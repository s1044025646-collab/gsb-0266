import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Store } from "../src/store.js";
import { validateDecls, linearizeOf, lookupMethod } from "../src/service.js";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c3-")), "test.db");
}

const diamond = [
  { name: "O", parents: [], methods: ["who"] },
  { name: "X", parents: ["O"], methods: ["who", "save"] },
  { name: "Y", parents: ["O"], methods: ["who", "load"] },
  { name: "A", parents: ["X", "Y"], methods: ["who"] },
];

test("导入生成版本，修改父类顺序生成新版本，旧版本可复算", () => {
  const store = new Store(tmpDb());
  const h1 = validateDecls(diamond);
  const v1 = store.importSnapshot([...h1.classes.values()]);
  const swapped = diamond.map((d) => (d.name === "A" ? { ...d, parents: ["Y", "X"] } : d));
  const h2 = validateDecls(swapped);
  const v2 = store.importSnapshot([...h2.classes.values()]);
  assert.notEqual(v1, v2);
  // 旧版本仍按原输入复算
  const old = store.loadHierarchy(v1);
  const r = linearizeOf(old, "A");
  assert.ok(r.ok);
  assert.deepEqual(r.order, ["A", "X", "Y", "O"]);
  const nw = store.loadHierarchy(v2);
  const r2 = linearizeOf(nw, "A");
  assert.ok(r2.ok);
  assert.deepEqual(r2.order, ["A", "Y", "X", "O"]);
  store.close();
});

test("校验失败的导入不留下任何版本", () => {
  const store = new Store(tmpDb());
  assert.throws(() => validateDecls([{ name: "A", parents: ["Ghost"] }]));
  assert.equal(store.listVersions().length, 0);
  store.close();
});

test("报告保存与重启后读取同一版本记录", () => {
  const db = tmpDb();
  let store = new Store(db);
  const h = validateDecls(diamond);
  const v = store.importSnapshot([...h.classes.values()]);
  const lk = lookupMethod(store.loadHierarchy(v), "A", "who");
  const rid = store.saveReport(v, "lookup", "A.who", lk);
  store.close();
  // 模拟重启
  store = new Store(db);
  const versions = store.listVersions();
  assert.equal(versions.length, 1);
  assert.equal(versions[0].id, v);
  const report = store.getReport(rid);
  assert.ok(report);
  assert.equal(report!.versionId, v);
  assert.equal((report!.payload as { provider: string }).provider, "A");
  const again = linearizeOf(store.loadHierarchy(v), "A");
  assert.ok(again.ok);
  assert.deepEqual(again.order, ["A", "X", "Y", "O"]);
  store.close();
});
