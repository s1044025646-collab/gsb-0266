import { test } from "node:test";
import assert from "node:assert/strict";
import { linearize, findCycle } from "../src/c3.js";
import { validateDecls, linearizeOf, lookupMethod, Hierarchy } from "../src/service.js";
import { ApiError, ErrorCodes } from "../src/errors.js";

function hier(decls: [string, string[], string[]][]): Hierarchy {
  return { classes: new Map(decls.map(([name, parents, methods]) => [name, { name, parents, methods }])) };
}

function assertValidMro(h: Hierarchy, order: string[], parentsOf: Record<string, string[]>): void {
  assert.equal(new Set(order).size, order.length, "线性化结果不能有重复类");
  const pos = new Map(order.map((c, i) => [c, i]));
  for (const [child, parents] of Object.entries(parentsOf)) {
    if (!pos.has(child)) continue;
    for (let i = 0; i < parents.length - 1; i++) {
      assert.ok(pos.get(parents[i])! < pos.get(parents[i + 1])!, `局部优先 ${parents[i]} < ${parents[i + 1]} 应保留`);
    }
    for (const p of parents) {
      if (pos.has(p)) assert.ok(pos.get(child)! < pos.get(p)!, `${child} 应排在父类 ${p} 之前`);
    }
  }
}

test("孤立根类只包含自己", () => {
  const r = linearize("Root", () => []);
  assert.ok(r.ok);
  assert.deepEqual(r.order, ["Root"]);
});

test("菱形继承：共享祖先只出现一次", () => {
  const h = hier([
    ["O", [], []],
    ["X", ["O"], []],
    ["Y", ["O"], []],
    ["A", ["X", "Y"], []],
  ]);
  const r = linearizeOf(h, "A");
  assert.ok(r.ok);
  assert.deepEqual(r.order, ["A", "X", "Y", "O"]);
  assertValidMro(h, r.order, { A: ["X", "Y"], X: ["O"], Y: ["O"] });
});

test("多层多父类线性化", () => {
  const h = hier([
    ["O", [], []],
    ["F", ["O"], []],
    ["E", ["O"], []],
    ["D", ["O"], []],
    ["C", ["D", "F"], []],
    ["B", ["D", "E"], []],
    ["A", ["B", "C"], []],
  ]);
  const r = linearizeOf(h, "A");
  assert.ok(r.ok);
  assert.deepEqual(r.order, ["A", "B", "C", "D", "E", "F", "O"]);
  assertValidMro(h, r.order, { A: ["B", "C"], B: ["D", "E"], C: ["D", "F"] });
});

test("交换父类顺序改变线性化与方法提供者", () => {
  const h1 = hier([
    ["X", [], ["who"]],
    ["Y", [], ["who"]],
    ["A", ["X", "Y"], []],
  ]);
  const h2 = hier([
    ["X", [], ["who"]],
    ["Y", [], ["who"]],
    ["A", ["Y", "X"], []],
  ]);
  assert.equal(lookupMethod(h1, "A", "who").provider, "X");
  assert.equal(lookupMethod(h2, "A", "who").provider, "Y");
});

test("方法遮蔽：返回第一个定义者并列出被遮蔽者", () => {
  const h = hier([
    ["O", [], ["who"]],
    ["X", ["O"], ["who"]],
    ["A", ["X"], ["who"]],
  ]);
  const r = lookupMethod(h, "A", "who");
  assert.equal(r.provider, "A");
  assert.deepEqual(r.shadowed, ["X", "O"]);
});

test("缺失方法返回未找到", () => {
  const h = hier([["A", [], ["foo"]]]);
  const r = lookupMethod(h, "A", "bar");
  assert.equal(r.found, false);
});

test("重复类名报错", () => {
  assert.throws(
    () => validateDecls([{ name: "A" }, { name: "A" }]),
    (e: unknown) => e instanceof ApiError && e.code === ErrorCodes.DUPLICATE_CLASS
  );
});

test("重复直接父类报错", () => {
  assert.throws(
    () => validateDecls([{ name: "B" }, { name: "A", parents: ["B", "B"] }]),
    (e: unknown) => e instanceof ApiError && e.code === ErrorCodes.DUPLICATE_PARENT
  );
});

test("缺失父类报错", () => {
  assert.throws(
    () => validateDecls([{ name: "A", parents: ["Ghost"] }]),
    (e: unknown) => e instanceof ApiError && e.code === ErrorCodes.MISSING_PARENT
  );
});

test("自继承报错", () => {
  assert.throws(
    () => validateDecls([{ name: "A", parents: ["A"] }]),
    (e: unknown) => e instanceof ApiError && e.code === ErrorCodes.SELF_INHERITANCE
  );
});

test("继承环报错并给出环路径", () => {
  const cycle = findCycle(["A", "B", "C"], (c) => ({ A: ["B"], B: ["C"], C: ["A"] })[c]!);
  assert.deepEqual(cycle, ["A", "B", "C", "A"]);
  assert.throws(
    () => validateDecls([{ name: "A", parents: ["B"] }, { name: "B", parents: ["C"] }, { name: "C", parents: ["A"] }]),
    (e: unknown) => e instanceof ApiError && e.code === ErrorCodes.CYCLE && /A -> B -> C -> A/.test(e.message)
  );
});

test("无环但顺序矛盾：A(X,Y) B(Y,X) Z(A,B) 无一致线性化", () => {
  assert.throws(
    () =>
      validateDecls([
        { name: "X" },
        { name: "Y" },
        { name: "A", parents: ["X", "Y"] },
        { name: "B", parents: ["Y", "X"] },
        { name: "Z", parents: ["A", "B"] },
      ]),
    (e: unknown) => e instanceof ApiError && e.code === ErrorCodes.CONFLICT
  );
  const h = hier([
    ["X", [], []],
    ["Y", [], []],
    ["A", ["X", "Y"], []],
    ["B", ["Y", "X"], []],
    ["Z", ["A", "B"], []],
  ]);
  const r = linearizeOf(h, "Z");
  assert.ok(!r.ok);
  assert.ok(r.steps.some((s) => !s.accepted && s.blockedBy!.length > 0), "应记录被拒绝的候选与阻挡尾部");
});

test("合并过程记录被拒绝的候选及阻挡尾部", () => {
  const h = hier([
    ["O", [], []],
    ["X", ["O"], []],
    ["Y", ["O"], []],
    ["A", ["X", "Y"], []],
  ]);
  const r = linearizeOf(h, "A");
  assert.ok(r.ok);
  const rejected = r.steps.filter((s) => !s.accepted);
  assert.ok(rejected.some((s) => s.candidate === "O"), "O 应曾被尾部阻挡");
});

test("输入声明顺序（文件行序）不影响结果", () => {
  const decls: [string, string[], string[]][] = [
    ["O", [], ["who"]],
    ["X", ["O"], []],
    ["Y", ["O"], []],
    ["A", ["X", "Y"], []],
  ];
  const shuffled: [string, string[], string[]][] = [
    ["A", ["X", "Y"], []],
    ["Y", ["O"], []],
    ["O", [], ["who"]],
    ["X", ["O"], []],
  ];
  const r1 = linearizeOf(hier(decls), "A");
  const r2 = linearizeOf(hier(shuffled), "A");
  assert.ok(r1.ok && r2.ok);
  assert.deepEqual(r1.order, r2.order);
});

test("非法名称与数量上限", () => {
  assert.throws(
    () => validateDecls([{ name: "1bad" }]),
    (e: unknown) => e instanceof ApiError && e.code === ErrorCodes.INVALID_NAME
  );
  assert.throws(
    () => validateDecls(Array.from({ length: 1001 }, (_, i) => ({ name: `C${i}` }))),
    (e: unknown) => e instanceof ApiError && e.code === ErrorCodes.TOO_MANY_CLASSES
  );
});
