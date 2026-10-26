"""
mock OneBot 11 (real WebSocket, RFC6455) + mock OpenAI-compatible HTTP.
Usage: python mock_ws.py [onebot_port] [openai_port]
Log lines are ASCII-only to avoid Windows console encoding issues.
"""
import asyncio
import base64
import hashlib
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

OB_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 3001
AI_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 18080
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


# ------------------------------------------------------------------ OpenAI mock
class OpenAIMock(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(n)
        try:
            req = json.loads(raw)
        except Exception:
            req = {}
        if self.path.rstrip('/').endswith('/balance'):
            return self._json({'balance_infos': [{
                'total_balance': '12.34', 'currency': 'CNY',
                'granted_balance': '2.00', 'topped_up_balance': '10.34'}]})
        last = ''
        for m in req.get('messages', []):
            if m.get('role') == 'user':
                last = str(m.get('content', ''))
        return self._json({
            'id': 'chatcmpl-mock', 'object': 'chat.completion',
            'model': req.get('model', 'deepseek-chat'),
            'choices': [{'index': 0,
                         'message': {'role': 'assistant',
                                     'content': '[mock reply] you said: ' + last},
                         'finish_reason': 'stop'}],
            'usage': {'prompt_tokens': 10, 'completion_tokens': 10, 'total_tokens': 20},
        })

    def do_GET(self):
        if self.path.rstrip('/').endswith('/balance'):
            return self._json({'balance_infos': [{
                'total_balance': '12.34', 'currency': 'CNY',
                'granted_balance': '2.00', 'topped_up_balance': '10.34'}]})
        return self._json({'ok': True})


def start_openai():
    srv = HTTPServer(('127.0.0.1', AI_PORT), OpenAIMock)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# ------------------------------------------------------------------ WebSocket
def frame(payload: bytes, opcode=0x1) -> bytes:
    head = bytearray()
    head.append(0x80 | opcode)
    n = len(payload)
    if n < 126:
        head.append(n)
    elif n < 65536:
        head.append(126)
        head += n.to_bytes(2, 'big')
    else:
        head.append(127)
        head += n.to_bytes(8, 'big')
    return bytes(head) + payload


async def read_exact(reader, n):
    try:
        return await reader.readexactly(n)
    except Exception:
        return None


async def read_frame(reader):
    hdr = await read_exact(reader, 2)
    if not hdr:
        return None, None
    fin_op = hdr[0]
    opcode = fin_op & 0x0F
    masked = hdr[1] & 0x80
    ln = hdr[1] & 0x7F
    if ln == 126:
        ext = await read_exact(reader, 2)
        if not ext:
            return None, None
        ln = int.from_bytes(ext, 'big')
    elif ln == 127:
        ext = await read_exact(reader, 8)
        if not ext:
            return None, None
        ln = int.from_bytes(ext, 'big')
    mask = None
    if masked:
        mask = await read_exact(reader, 4)
        if not mask:
            return None, None
    data = await read_exact(reader, ln) if ln else b''
    if data is None:
        return None, None
    if mask:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return opcode, data


class OneBotWS:
    def __init__(self, port):
        self.port = port
        self.sent = []

    async def handle(self, reader, writer):
        peer = writer.get_extra_info('peername')
        try:
            # ---- HTTP upgrade handshake
            raw = b''
            while b'\r\n\r\n' not in raw:
                chunk = await reader.read(1024)
                if not chunk:
                    raise RuntimeError('eof before handshake')
                raw += chunk
                if len(raw) > 65536:
                    raise RuntimeError('handshake too large')
            head = raw.split(b'\r\n\r\n', 1)[0].decode('latin1')
            lines = head.split('\r\n')
            reqline = lines[0]
            headers = {}
            for ln in lines[1:]:
                if ':' in ln:
                    k, v = ln.split(':', 1)
                    headers[k.strip().lower()] = v.strip()
            key = headers.get('sec-websocket-key', '')
            print('[ws] handshake from %s: %s' % (peer, reqline), flush=True)
            if not key:
                raise RuntimeError('no Sec-WebSocket-Key')
            accept = base64.b64encode(
                hashlib.sha1((key + GUID).encode()).digest()).decode()
            resp = ('HTTP/1.1 101 Switching Protocols\r\n'
                    'Upgrade: websocket\r\n'
                    'Connection: Upgrade\r\n'
                    'Sec-WebSocket-Accept: %s\r\n\r\n' % accept)
            writer.write(resp.encode())
            await writer.drain()
            print('[ws] handshake done, client ready', flush=True)

            # ---- message loop
            while True:
                opcode, data = await read_frame(reader)
                if opcode is None:
                    break
                if opcode == 0x8:
                    print('[ws] client sent close', flush=True)
                    break
                if opcode == 0x9:
                    writer.write(frame(data, 0xA))
                    await writer.drain()
                    continue
                if opcode == 0xA:
                    continue
                if opcode not in (0x1, 0x2):
                    continue
                text = data.decode('utf-8', 'replace')
                try:
                    msg = json.loads(text)
                except Exception:
                    print('[ws] non-json frame: %s' % text[:120], flush=True)
                    continue
                await self.on_action(msg, writer)
        except Exception as e:
            print('[ws] error: %r' % (e,), flush=True)
        finally:
            try:
                writer.close()
            except Exception:
                pass
            print('[ws] disconnected %s' % (peer,), flush=True)

    async def on_action(self, msg, writer):
        action = msg.get('action', '')
        echo = msg.get('echo')
        print('[ws] action: %s echo=%s' % (action, echo), flush=True)
        if action == 'get_login_info':
            data = {'user_id': 2296258484, 'nickname': 'QunZaiMockBot'}
        elif action == 'get_version_info':
            data = {'app_name': 'mock-onebot', 'app_version': '1.0.0',
                    'protocol_version': 'v11'}
        elif action == 'get_status':
            data = {'online': True, 'good': True}
        elif action == 'get_group_list':
            data = [{'group_id': 123456789, 'group_name': 'MockGroup'}]
        elif action in ('send_group_msg', 'send_private_msg'):
            params = msg.get('params', {})
            self.sent.append(params)
            txt = ''
            for seg in (params.get('message') or []):
                if isinstance(seg, dict):
                    txt += str(seg.get('data', {}).get('text', ''))
            print('[ws] SENT -> %s | %s' % (action, txt), flush=True)
            data = {'message_id': 999}
        else:
            data = {}
        reply = {'status': 'ok', 'retcode': 0, 'data': data, 'message': ''}
        if echo is not None:
            reply['echo'] = echo
        writer.write(frame((json.dumps(reply) + '\n').encode()))
        await writer.drain()
        if action == 'get_version_info':
            asyncio.get_event_loop().create_task(self.push_group_msg(writer))

    async def push_group_msg(self, writer):
        await asyncio.sleep(1.0)
        ev = {'time': int(time.time()), 'self_id': 2296258484,
              'post_type': 'message', 'message_type': 'group', 'sub_type': 'normal',
              'message_id': 1001, 'group_id': 123456789, 'user_id': 555666,
              'anonymous': None, 'message': [{'type': 'text', 'data': {'text': '在吗？'}}],
              'raw_message': '在吗？', 'font': 0,
              'sender': {'user_id': 555666, 'nickname': 'Tester', 'card': 'Tester'}}
        try:
            writer.write(frame((json.dumps(ev) + '\n').encode()))
            await writer.drain()
            print('[ws] pushed group message event', flush=True)
        except Exception:
            pass


async def main():
    start_openai()
    print('[openai] mock up on http://127.0.0.1:%d' % AI_PORT, flush=True)
    mock = OneBotWS(OB_PORT)
    server = await asyncio.start_server(mock.handle, '127.0.0.1', OB_PORT)
    print('[ws] mock OneBot (real websocket) on ws://127.0.0.1:%d' % OB_PORT, flush=True)
    async with server:
        await server.serve_forever()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
