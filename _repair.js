
const post = async (p, body) => {
  const r = await fetch("http://127.0.0.1:8787" + p, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  return await r.text();
};
(async () => {
  console.log("START:", (await post("/api/engine/start", { dir: "D:\\SnowLuma-v1.14.22-win-x64", account: "1413214574" })).slice(0, 700));
  await new Promise(r => setTimeout(r, 3000));
  console.log("STATUS:", (await (await fetch("http://127.0.0.1:8787/api/status")).text()).slice(0, 400));
})();
