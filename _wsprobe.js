
const TOK = "0ws4wbQtsNiif8MFfZdbMj04WmVetXEj2KRgRR7T-7o";
const tryUrl = (url, label) => new Promise((res) => {
  let ws;
  try { ws = new WebSocket(url); } catch (e) { return res(label + " -> CTOR-ERR " + e.message); }
  const t = setTimeout(() => { try{ws.close();}catch{} res(label + " -> TIMEOUT"); }, 5000);
  ws.onopen = () => ws.send(JSON.stringify({ action: "get_login_info", params: {}, echo: "p" }));
  ws.onmessage = (ev) => { clearTimeout(t); const d = String(ev.data).slice(0,160); try{ws.close();}catch{} res(label + " -> OK " + d); };
  ws.onerror = () => { clearTimeout(t); res(label + " -> ERROR"); };
});
(async () => {
  console.log(await tryUrl("ws://127.0.0.1:3001?access_token=" + encodeURIComponent(TOK), "query access_token"));
  console.log(await tryUrl("ws://127.0.0.1:3001", "no token"));
  // http api
  for (const [label, url, hdr] of [
    ["http no-token", "http://127.0.0.1:3000/get_login_info", {}],
    ["http bearer", "http://127.0.0.1:3000/get_login_info", { Authorization: "Bearer YC9fatxUIwWTst8m6-OWG8cTUBIJrqhlKsDrC31Rg6Q" }],
    ["http query", "http://127.0.0.1:3000/get_login_info?access_token=YC9fatxUIwWTst8m6-OWG8cTUBIJrqhlKsDrC31Rg6Q", {}],
  ]) {
    try { const r = await fetch(url, { headers: hdr }); console.log(label, "->", r.status, (await r.text()).slice(0,120)); }
    catch (e) { console.log(label, "-> ERR", e.message); }
  }
})();
