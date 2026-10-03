import { test } from "node:test";
import assert from "node:assert/strict";
import { tempService } from "./helpers.ts";
import { startApp, type StartedServer } from "../src/server.ts";

let server: StartedServer | null = null;

async function api(path: string, init?: RequestInit & { body?: unknown }): Promise<{
  status: number;
  data: any;
}> {
  const res = await fetch(`http://127.0.0.1:${server!.port}${path}`, {
    method: init?.method,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

test.beforeEach(async () => {
  const { service, cleanup } = tempService();
  (globalThis as { __cleanup?: () => void }).__cleanup = cleanup;
  server = await startApp(service, undefined);
});

test.afterEach(async () => {
  await server?.close();
  (globalThis as { __cleanup?: () => void }).__cleanup?.();
  server = null;
});

test("HTTP：导入 -> MRO -> 查找 -> 报告 全链路", async () => {
  const imported = await api("/api/import", {
    method: "POST",
    body: {
      note: "api 测试",
      classes: [
        { name: "O", parents: [], methods: [] },
        { name: "X", parents: ["O"], methods: ["who"] },
        { name: "Y", parents: ["O"], methods: ["who"] },
        { name: "G", parents: ["X", "Y"], methods: [] },
      ],
    },
  });
  assert.equal(imported.status, 200);
  const v = imported.data.version;

  const mro = await api(`/api/versions/${v}/classes/G/mro?persist=1`);
  assert.deepEqual(mro.data.result.mro, ["G", "X", "Y", "O"]);
  assert.equal(typeof mro.data.result.reportId, "number");

  const lookup = await api(`/api/versions/${v}/classes/G/lookup?method=who`);
  assert.equal(lookup.data.result.lookup.provider, "X");
  assert.deepEqual(lookup.data.result.lookup.shadowed[0], {
    className: "Y",
    order: 2,
  });

  const reports = await api(`/api/reports`);
  assert.equal(reports.data.reports.length, 1);
  const reportId = reports.data.reports[0].reportId;
  const report = await api(`/api/reports/${reportId}`);
  assert.equal(report.data.report.snapshot.version, v);
});

test("HTTP：校验失败返回 422 与结构化错误码，且无版本产生", async () => {
  const bad = await api("/api/import", {
    method: "POST",
    body: { classes: [{ name: "A", parents: ["Ghost"], methods: [] }] },
  });
  assert.equal(bad.status, 422);
  assert.equal(bad.data.error.code, "VALIDATION_FAILED");
  assert.equal(bad.data.error.details[0].code, "MISSING_PARENT");

  const versions = await api("/api/versions");
  assert.deepEqual(versions.data.versions, []);
});

test("HTTP：顺序冲突返回可解释信息", async () => {
  const imported = await api("/api/import", {
    method: "POST",
    body: {
      classes: [
        { name: "X", parents: [], methods: [] },
        { name: "Y", parents: [], methods: [] },
        { name: "A", parents: ["X", "Y"], methods: [] },
        { name: "B", parents: ["Y", "X"], methods: [] },
        { name: "Z", parents: ["A", "B"], methods: [] },
      ],
    },
  });
  const v = imported.data.version;
  const mro = await api(`/api/versions/${v}/classes/Z/mro`);
  assert.equal(mro.data.ok, false);
  assert.match(mro.data.result.conflict.message, /C3 线性化冲突/);
});

test("HTTP：不存在的类与版本返回 404", async () => {
  const noVersion = await api("/api/versions");
  assert.equal(noVersion.status, 200);
  const missing = await api("/api/versions/99/classes/A/mro");
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error.code, "VERSION_NOT_FOUND");
});
