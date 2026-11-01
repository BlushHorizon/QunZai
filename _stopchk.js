
const wait = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  // 用接口优雅停一次（会顺带验证 stop 不会误杀 SnowLuma）
  try {
    const r = await fetch("http://127.0.0.1:8787/api/engine/stop", { method: "POST", headers: {"Content-Type":"application/json"}, body: "{}" });
    console.log("STOP:", (await r.text()).slice(0, 300));
  } catch (e) { console.log("STOP ERR:", e.message); }
  await wait(1500);
  for (const p of ["/api/status","/api/engine/status"]) {
    try { console.log(p, "->", (await (await fetch("http://127.0.0.1:8787" + p)).text()).slice(0,150)); }
    catch (e) { console.log(p, "-> DOWN"); }
  }
})();
