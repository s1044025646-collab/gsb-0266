import { test } from "node:test";
import assert from "node:assert/strict";
import { tempService, decl, assertNoDuplicates, assertLocalPrecedence } from "./helpers.ts";
import { ErrorCode, ApiError } from "../src/errors.js";
import { lookupMethod } from "../src/lookup.ts";
import { C3Analyzer } from "../src/c3.ts";
import { Store } from "../src/store.ts";
import { AnalysisService } from "../src/service.ts";

test("方法遮蔽：按 MRO 第一个定义者胜出，其余列入 shadowed", () => {
  const decls = [
    decl("O", [], ["ping"]),
    decl("X", ["O"], ["ping"]),
    decl("Y", ["O"], []),
    decl("G", ["X", "Y"], []),
  ];
  const map = new Map(decls.map((d) => [d.name, d]));
  const lin = C3Analyzer.fromArray(decls).linearize("G");
  const r = lookupMethod(map, lin, "ping");
  assert.equal(r.found, true);
  assert.equal(r.provider, "X");
  assert.deepEqual(r.shadowed.map((s) => s.className), ["O"]);
});

test("缺失方法返回 found=false", () => {
  const decls = [decl("O"), decl("A", ["O"])];
  const map = new Map(decls.map((d) => [d.name, d]));
  const lin = C3Analyzer.fromArray(decls).linearize("A");
  const r = lookupMethod(map, lin, "missing");
  assert.equal(r.found, false);
  assert.equal(r.provider, null);
  assert.deepEqual(r.shadowed, []);
});

test("有冲突的类不能进行方法查找", () => {
  const { service, cleanup } = tempService();
  try {
    const v = service.importDeclarations([
      { name: "X", parents: [], methods: ["f"] },
      { name: "Y", parents: [], methods: ["f"] },
      { name: "A", parents: ["X", "Y"], methods: [] },
      { name: "B", parents: ["Y", "X"], methods: [] },
      { name: "Z", parents: ["A", "B"], methods: [] },
    ]).version;
    assert.throws(
      () => service.lookup(v, "Z", "f"),
      (err: unknown) => err instanceof ApiError && err.code === ErrorCode.C3_CONFLICT,
    );
  } finally {
    cleanup();
  }
});

test("批量导入失败不留半套声明", () => {
  const { service, cleanup } = tempService();
  try {
    assert.throws(() =>
      service.importDeclarations([
        { name: "A", parents: ["Missing"], methods: [] },
      ]),
    );
    assert.equal(service.listVersions().length, 0);
  } finally {
    cleanup();
  }
});

test("交换父类顺序产生新版本；旧版本仍按原输入复算且提供者不同", () => {
  const { service, cleanup } = tempService();
  try {
    const v1 = service.importDeclarations([
      { name: "O", parents: [], methods: [] },
      { name: "X", parents: ["O"], methods: ["who"] },
      { name: "Y", parents: ["O"], methods: ["who"] },
      { name: "G", parents: ["X", "Y"], methods: [] },
    ]).version;
    const v2 = service.importDeclarations([
      { name: "O", parents: [], methods: [] },
      { name: "X", parents: ["O"], methods: ["who"] },
      { name: "Y", parents: ["O"], methods: ["who"] },
      { name: "G", parents: ["Y", "X"], methods: [] },
    ]).version;
    assert.notEqual(v1, v2);
    assert.equal(service.lookup(v1, "G", "who").lookup.provider, "X");
    assert.equal(service.lookup(v2, "G", "who").lookup.provider, "Y");
  } finally {
    cleanup();
  }
});

test("幂等导入（内容完全相同）复用最新版本", () => {
  const { service, cleanup } = tempService();
  try {
    const payload = [{ name: "A", parents: [], methods: [] }];
    const first = service.importDeclarations(payload);
    const second = service.importDeclarations(payload);
    assert.equal(first.version, second.version);
    assert.equal(second.reused, true);
  } finally {
    cleanup();
  }
});

test("改变文件行序不改变结果", () => {
  const { service, cleanup } = tempService();
  try {
    const v1 = service.importDeclarations([
      { name: "G", parents: ["X", "Y"], methods: [], line: 1 },
      { name: "X", parents: ["O"], methods: [], line: 2 },
      { name: "Y", parents: ["O"], methods: [], line: 3 },
      { name: "O", parents: [], methods: [], line: 4 },
    ]).version;
    const v2 = service.importDeclarations([
      { name: "O", parents: [], methods: [], line: 40 },
      { name: "Y", parents: ["O"], methods: [], line: 30 },
      { name: "X", parents: ["O"], methods: [], line: 20 },
      { name: "G", parents: ["X", "Y"], methods: [], line: 10 },
    ]).version;
    assert.equal(v1, v2, "仅行序不同应复用同一版本（规范化后哈希相同）");
    assert.deepEqual(service.linearization(v1, "G").mro, ["G", "X", "Y", "O"]);
  } finally {
    cleanup();
  }
});

test("更大层次：全部成功 MRO 无重复且保留局部父类优先关系", () => {
  const { service, cleanup } = tempService();
  try {
    const input = [
      { name: "O", parents: [], methods: [] },
      { name: "A", parents: ["O"], methods: [] },
      { name: "B", parents: ["O"], methods: [] },
      { name: "C", parents: ["O"], methods: [] },
      { name: "D", parents: ["O"], methods: [] },
      { name: "E", parents: ["O"], methods: [] },
      { name: "K1", parents: ["A", "B", "C"], methods: [] },
      { name: "K2", parents: ["D", "B", "E"], methods: [] },
      { name: "Z", parents: ["K1", "K2"], methods: [] },
      { name: "R", parents: ["C", "D"], methods: [] },
    ];
    const v = service.importDeclarations(input).version;
    const mros = new Map<string, string[]>();
    for (const c of input) {
      const r = service.linearization(v, c.name);
      assert.equal(r.ok, true, `${c.name} 应成功`);
      assertNoDuplicates(r.mro!);
      mros.set(c.name, r.mro!);
    }
    assertLocalPrecedence(
      input.map((x) => decl(x.name, x.parents, x.methods)),
      mros,
    );
  } finally {
    cleanup();
  }
});

test("重启后读取同一版本与旧报告并复算结果一致", () => {
  const { service, dbPath, cleanup } = tempService();
  try {
    const v = service.importDeclarations([
      { name: "O", parents: [], methods: [] },
      { name: "X", parents: ["O"], methods: ["who"] },
      { name: "Y", parents: ["O"], methods: ["who"] },
      { name: "G", parents: ["X", "Y"], methods: [] },
    ]).version;
    const reportId = service.lookup(v, "G", "who", true).reportId!;
    // 用新的 Store 重新打开同一数据库文件，模拟服务重启
    const reopenedStore = new Store(dbPath);
    const reopened = new AnalysisService(reopenedStore);
    assert.deepEqual(reopened.listVersions().map((x) => x.version), [v]);
    const report = reopened.exportReport(reportId, true);
    assert.equal(report.lookup?.provider, "X");
    assert.equal(report.snapshot?.version, v);
    assert.equal(reopened.lookup(v, "G", "who").lookup.provider, "X");
    reopenedStore.close();
  } finally {
    cleanup();
  }
});
