import { test } from "node:test";
import assert from "node:assert/strict";
import { C3Analyzer } from "../src/c3.js";
import { decl } from "./helpers.ts";

/** 用类数组直接跑线性化（无环、无缺失父类前提）。 */
function run(decls: ReturnType<typeof decl>[], target: string) {
  return C3Analyzer.fromArray(decls).linearize(target);
}

test("孤立根类：无父类的类只包含自己", () => {
  const r = run([decl("Root")], "Root");
  assert.deepEqual(r.mro, ["Root"]);
  assert.equal(r.ok, true);
});

test("简单单继承链", () => {
  const decls = [decl("A"), decl("B", ["A"]), decl("C", ["B"])];
  assert.deepEqual(run(decls, "C").mro, ["C", "B", "A"]);
});

test("菱形共享祖先在最终顺序中只出现一次", () => {
  const decls = [
    decl("O"),
    decl("A", ["O"]),
    decl("B", ["O"]),
    decl("C", ["A", "B"]),
  ];
  const r = run(decls, "C");
  assert.deepEqual(r.mro, ["C", "A", "B", "O"]);
  assert.equal(new Set(r.mro!).size, r.mro!.length);
});

test("Python 文档示例（多父类）人工预期顺序", () => {
  // 源自 C3 经典示例：
  // O; A(O); B(O); C(O); D(O); E(O)
  // K1(A,B,C); K2(D,B,E); Z(K1,K2,A)
  const decls = [
    decl("O"),
    decl("A", ["O"]),
    decl("B", ["O"]),
    decl("C", ["O"]),
    decl("D", ["O"]),
    decl("E", ["O"]),
    decl("K1", ["A", "B", "C"]),
    decl("K2", ["D", "B", "E"]),
    decl("Z", ["K1", "K2", "A", "D"]),
  ];
  // Z(K1,K2,A,D) 的标准 C3 结果（Python 文档经典示例）
  const expected = ["Z", "K1", "K2", "A", "D", "B", "C", "E", "O"];
  assert.deepEqual(run(decls, "Z").mro, expected);
  assert.deepEqual(run(decls, "K1").mro, ["K1", "A", "B", "C", "O"]);
  assert.deepEqual(run(decls, "K2").mro, ["K2", "D", "B", "E", "O"]);
});

test("顺序矛盾 A(X,Y) B(Y,X) Z(A,B) 必须报冲突，且不退化", () => {
  const decls = [
    decl("X"),
    decl("Y"),
    decl("A", ["X", "Y"]),
    decl("B", ["Y", "X"]),
    decl("Z", ["A", "B"]),
  ];
  const r = run(decls, "Z");
  assert.equal(r.ok, false);
  assert.equal(r.mro, null);
  assert.ok(r.conflict);
  // 最后一轮所有候选都被拒绝
  const lastRound = r.rounds[r.rounds.length - 1]!;
  assert.equal(lastRound.selected, null);
  assert.ok(lastRound.trials.every((t) => !t.accepted));
  // 被拒绝候选必须带阻挡尾部
  for (const trial of lastRound.trials) {
    assert.ok(trial.blockedBy.length > 0);
    assert.ok(trial.reason);
  }
});

test("无环但局部顺序矛盾的另一形态 F(D,E)", () => {
  // D(O,A? ...) 构造: X<Y 与 Y<X 的矛盾经由不同父类引入
  const decls = [
    decl("O"),
    decl("X", ["O"]),
    decl("Y", ["O"]),
    decl("D", ["X", "Y"]),
    decl("E", ["Y", "X"]),
    decl("F", ["D", "E"]),
  ];
  const r = run(decls, "F");
  assert.equal(r.ok, false);
  assert.match(r.conflict!.message, /C3 线性化冲突/);
});

test("合并过程记录被拒绝候选及阻挡它的尾部", () => {
  // 经典 Z 示例：第二轮候选 A 出现在直接父类列表序列 [K2,A,D] 的尾部，先被拒绝，
  // 随后候选 K2 被接受。这验证“被拒绝候选 + 阻挡尾部”的记录。
  const decls = [
    decl("O"),
    decl("A", ["O"]),
    decl("B", ["O"]),
    decl("C", ["O"]),
    decl("D", ["O"]),
    decl("E", ["O"]),
    decl("K1", ["A", "B", "C"]),
    decl("K2", ["D", "B", "E"]),
    decl("Z", ["K1", "K2", "A", "D"]),
  ];
  const r = run(decls, "Z");
  assert.equal(r.ok, true);
  // round 0 选 K1；round 1 先拒绝 A（阻挡尾部含 A），再接受 K2
  const secondRound = r.rounds[1]!;
  const aTrial = secondRound.trials.find((t) => t.candidate === "A")!;
  assert.equal(aTrial.accepted, false);
  assert.ok(aTrial.blockedBy.some((tail) => tail.includes("A")));
  assert.match(aTrial.reason!, /被阻挡/);
  assert.equal(secondRound.selected, "K2");
});

test("缓存不影响结果：重复计算一致", () => {
  const decls = [
    decl("O"),
    decl("A", ["O"]),
    decl("B", ["O"]),
    decl("C", ["A", "B"]),
  ];
  const analyzer = C3Analyzer.fromArray(decls);
  const a = analyzer.linearize("C");
  const b = analyzer.linearize("C");
  assert.strictEqual(a, b);
});
