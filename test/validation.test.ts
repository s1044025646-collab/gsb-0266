import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDeclarations, findCycle } from "../src/declarations.js";
import { ErrorCode, ValidationError } from "../src/errors.js";

function codes(err: unknown): string[] {
  assert.ok(err instanceof ValidationError);
  return err.errors.map((e) => e.code);
}

test("非法标识符被拒绝（区分大小写规则本身不报错）", () => {
  assert.throws(
    () => validateDeclarations([{ name: "1Bad", parents: [], methods: [] }]),
    (err: unknown) => codes(err).includes(ErrorCode.INVALID_IDENTIFIER),
  );
  assert.throws(
    () => validateDeclarations([{ name: "Ok", parents: ["x-y"], methods: [] }]),
    (err: unknown) => codes(err).includes(ErrorCode.INVALID_IDENTIFIER),
  );
});

test("重复类名、重复直接父类、自继承、缺失父类分别报告不同错误码", () => {
  try {
    validateDeclarations([
      { name: "A", parents: ["A"], methods: [] }, // 自继承
      { name: "A", parents: [], methods: [] }, // 重复类名
      { name: "B", parents: ["A", "A"], methods: [] }, // 重复父类
      { name: "C", parents: ["Nope"], methods: [] }, // 缺失父类
    ]);
    assert.fail("应当抛出校验错误");
  } catch (err) {
    const c = codes(err);
    assert.ok(c.includes(ErrorCode.SELF_INHERITANCE));
    assert.ok(c.includes(ErrorCode.DUPLICATE_CLASS));
    assert.ok(c.includes(ErrorCode.DUPLICATE_PARENT));
    assert.ok(c.includes(ErrorCode.MISSING_PARENT));
  }
});

test("继承环错误提供实际环路径", () => {
  const graph = new Map([
    ["A", ["B"]],
    ["B", ["C"]],
    ["C", ["A"]],
  ]);
  const cycle = findCycle(graph)!;
  assert.deepEqual(cycle, ["A", "B", "C", "A"]);

  assert.throws(
    () =>
      validateDeclarations([
        { name: "A", parents: ["B"], methods: [] },
        { name: "B", parents: ["C"], methods: [] },
        { name: "C", parents: ["A"], methods: [] },
      ]),
    (err: unknown) => {
      if (!(err instanceof ValidationError)) return false;
      const e = err.errors.find((x) => x.code === ErrorCode.INHERITANCE_CYCLE);
      return !!e && Array.isArray(e.cycle) && e.cycle[0] === e.cycle[e.cycle.length - 1];
    },
  );
});

test("校验通过后规范化：父类保留声明顺序，方法去重", () => {
  const out = validateDeclarations([
    { name: "C", parents: ["A", "B"], methods: ["z", "z", "a"] },
    { name: "A", parents: [], methods: [] },
    { name: "B", parents: [], methods: [] },
  ]);
  const c = out.find((x) => x.name === "C")!;
  assert.deepEqual(c.parents, ["A", "B"]);
  assert.deepEqual(c.methods, ["a", "z"]);
});

test("空批次被拒绝", () => {
  assert.throws(
    () => validateDeclarations([]),
    (err: unknown) => codes(err).includes(ErrorCode.EMPTY_BATCH),
  );
});
