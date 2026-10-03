const { Store } = await import("../dist/src/store.js");
const { startServer } = await import("../dist/src/server.js");
const store = new Store(process.env.C3_DB);
const server = await startServer(store, 0);
const port = server.address().port;
const post = (p, b) => fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const get = (p) => fetch(`http://127.0.0.1:${port}${p}`);
let r = await post("/api/imports", { classes: [
  { name: "O", parents: [], methods: ["who"] },
  { name: "X", parents: ["O"], methods: ["who", "save"] },
  { name: "Y", parents: ["O"], methods: ["who", "load"] },
  { name: "A", parents: ["X", "Y"], methods: ["who"] }
]});
console.log("import:", r.status, JSON.stringify(await r.json()));
r = await get("/api/versions/1/linearize/A");
console.log("mro:", r.status, (await r.json()).order.join(">"));
r = await get("/api/versions/1/lookup/A/save");
console.log("lookup:", r.status, (await r.json()).provider);
r = await get("/api/versions/1/lookup/A/nope");
console.log("missing:", r.status, (await r.json()).code);
r = await post("/api/imports", { classes: [{ name: "A", parents: ["B"] }] });
console.log("bad import:", r.status, (await r.json()).code);
r = await get("/api/versions/1/report");
const rep = await r.json();
console.log("report:", r.status, "id=", rep.reportId, "classes=", rep.classes.length);
server.close();
store.close();
