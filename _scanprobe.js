
const post = async (p, body) => {
  const r = await fetch("http://127.0.0.1:8787" + p, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  return (await r.text()).slice(0, 800);
};
(async () => {
  console.log("scan(no acct):", await post("/api/engine/scan", { dir: "D:\\SnowLuma-v1.14.22-win-x64", account: "" }));
  console.log("scan(acct):", await post("/api/engine/scan", { dir: "D:\\SnowLuma-v1.14.22-win-x64", account: "1413214574" }));
})();
