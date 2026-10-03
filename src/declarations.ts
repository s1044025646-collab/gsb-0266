import { ErrorCode, ValidationError, type FieldError } from "./errors.js";
import type { ClassDecl, ClassDeclInput } from "./types.js";

/** 可调的合理上限。 */
export const MAX_NAME_LENGTH = 128;
export const MAX_METHOD_LENGTH = 128;
export const MAX_CLASSES = 1000;

/**
 * 类名/方法名：区分大小写的标识符。
 * 允许字母、数字、下划线，首字符不能为数字（与常见语言习惯一致）。
 */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidIdentifier(name: unknown): name is string {
  return typeof name === "string" && IDENT_RE.test(name);
}

/** 规范化单条声明的字段形态；返回字段级错误列表。 */
function normalizeEntry(raw: unknown, index: number): {
  decl?: ClassDecl;
  errors: FieldError[];
  line?: number;
  name?: string;
} {
  const errors: FieldError[] = [];
  if (typeof raw !== "object" || raw === null) {
    return {
      errors: [
        {
          code: ErrorCode.INVALID_BODY,
          message: `第 ${index + 1} 条声明不是对象`,
          line: index + 1,
        },
      ],
    };
  }
  const obj = raw as Record<string, unknown>;
  const line = typeof obj.line === "number" ? obj.line : undefined;
  const name = obj.name;
  const nameStr = typeof name === "string" ? name : String(name);

  if (!isValidIdentifier(name)) {
    errors.push({
      code: ErrorCode.INVALID_IDENTIFIER,
      message: `非法类名: ${JSON.stringify(name)}（需匹配 ${IDENT_RE}）`,
      line,
    });
  } else if (name.length > MAX_NAME_LENGTH) {
    errors.push({
      code: ErrorCode.NAME_TOO_LONG,
      message: `类名过长: ${name}（上限 ${MAX_NAME_LENGTH}）`,
      className: name,
      line,
    });
  }

  const strList = (value: unknown, what: string): string[] | null => {
    if (!Array.isArray(value)) {
      errors.push({
        code: ErrorCode.INVALID_BODY,
        message: `${what} 必须是字符串数组（类 ${JSON.stringify(name)}）`,
        className: nameStr,
        line,
      });
      return null;
    }
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") {
        errors.push({
          code: ErrorCode.INVALID_IDENTIFIER,
          message: `${what} 中存在非字符串项: ${JSON.stringify(item)}（类 ${nameStr}）`,
          className: nameStr,
          line,
        });
        return null;
      }
      out.push(item);
    }
    return out;
  };

  const parents = strList(obj.parents ?? [], "parents");
  const methods = strList(obj.methods ?? [], "methods");

  const normParents: string[] = [];
  if (parents) {
    for (const p of parents) {
      if (!isValidIdentifier(p)) {
        errors.push({
          code: ErrorCode.INVALID_IDENTIFIER,
          message: `非法父类名: ${JSON.stringify(p)}（类 ${nameStr}）`,
          className: nameStr,
          line,
        });
      } else if (p.length > MAX_NAME_LENGTH) {
        errors.push({
          code: ErrorCode.NAME_TOO_LONG,
          message: `父类名过长: ${p}（类 ${nameStr}）`,
          className: nameStr,
          line,
        });
      } else {
        normParents.push(p);
      }
    }
  }

  const methodSet = new Set<string>();
  if (methods) {
    for (const m of methods) {
      if (!isValidIdentifier(m)) {
        errors.push({
          code: ErrorCode.INVALID_IDENTIFIER,
          message: `非法方法名: ${JSON.stringify(m)}（类 ${nameStr}）`,
          className: nameStr,
          line,
        });
      } else if (m.length > MAX_METHOD_LENGTH) {
        errors.push({
          code: ErrorCode.NAME_TOO_LONG,
          message: `方法名过长: ${m}（类 ${nameStr}）`,
          className: nameStr,
          line,
        });
      } else {
        methodSet.add(m);
      }
    }
  }

  if (errors.length > 0) return { errors, line, name: nameStr };
  return {
    decl: {
      name: nameStr,
      // 父类保留声明顺序（重复检测在完整校验阶段做）
      parents: normParents,
      methods: [...methodSet].sort(),
    },
    errors,
    line,
    name: nameStr,
  };
}

/**
 * 完整校验一批声明。
 * 任何错误都抛出 ValidationError —— 调用方据此保证“失败不留半套声明”。
 * 校验项彼此独立收集，一次报告尽可能多的问题。
 */
export function validateDeclarations(rawInputs: unknown): ClassDecl[] {
  if (!Array.isArray(rawInputs)) {
    throw new ValidationError([
      {
        code: ErrorCode.INVALID_BODY,
        message: "请求体 classes 必须是声明数组",
      },
    ]);
  }
  if (rawInputs.length === 0) {
    throw new ValidationError([
      { code: ErrorCode.EMPTY_BATCH, message: "批量导入为空：至少需要一个类声明" },
    ]);
  }
  if (rawInputs.length > MAX_CLASSES) {
    throw new ValidationError([
      {
        code: ErrorCode.TOO_MANY_CLASSES,
        message: `类数量超限：${rawInputs.length} > ${MAX_CLASSES}`,
      },
    ]);
  }

  const errors: FieldError[] = [];
  const normalized: { decl: ClassDecl; line?: number }[] = [];
  for (let i = 0; i < rawInputs.length; i++) {
    const r = normalizeEntry(rawInputs[i], i);
    errors.push(...r.errors);
    if (r.decl) normalized.push({ decl: r.decl, line: r.line });
  }

  const byName = new Map<string, number>();
  for (const { decl, line } of normalized) {
    const prevLine = byName.get(decl.name);
    if (prevLine !== undefined) {
      errors.push({
        code: ErrorCode.DUPLICATE_CLASS,
        message: `重复类名: ${decl.name}（行 ${prevLine} 与行 ${line ?? "?"}）`,
        className: decl.name,
        line,
      });
    } else {
      byName.set(decl.name, line ?? -1);
    }
  }

  const validNames = new Set(normalized.map(({ decl }) => decl.name));
  for (const { decl, line } of normalized) {
    // 自继承
    if (decl.parents.includes(decl.name)) {
      errors.push({
        code: ErrorCode.SELF_INHERITANCE,
        message: `类 ${decl.name} 不能继承自身`,
        className: decl.name,
        line,
      });
    }
    // 同一直接父类重复出现
    const seen = new Set<string>();
    for (const p of decl.parents) {
      if (seen.has(p)) {
        errors.push({
          code: ErrorCode.DUPLICATE_PARENT,
          message: `类 ${decl.name} 的直接父类重复: ${p}（父类顺序中出现多次）`,
          className: decl.name,
          line,
        });
      }
      seen.add(p);
    }
    // 缺失父类
    for (const p of decl.parents) {
      if (p !== decl.name && !validNames.has(p)) {
        errors.push({
          code: ErrorCode.MISSING_PARENT,
          message: `类 ${decl.name} 的父类 ${p} 未在本批声明中定义`,
          className: decl.name,
          line,
        });
      }
    }
  }

  if (errors.length > 0) throw new ValidationError(errors);

  // 结构完整后做环检测（自环已单独报告；这里找长度 >= 2 的实际环路径）
  const graph = new Map<string, string[]>();
  for (const { decl } of normalized) graph.set(decl.name, [...decl.parents]);
  const cycle = findCycle(graph);
  if (cycle) {
    throw new ValidationError([
      {
        code: ErrorCode.INHERITANCE_CYCLE,
        message: `检测到继承环: ${cycle.join(" -> ")}`,
        cycle,
        className: cycle[0],
      },
    ]);
  }

  // 输出顺序按名字排序，使结果与“文件行序”无关（确定性）。
  return normalized
    .map(({ decl }) => decl)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * 深度优先环检测，返回形如 [A, B, C, A] 的实际环路径；无环返回 null。
 * 多个环时返回遍历中遇到的第一个（按名字排序保证稳定）。
 */
export function findCycle(graph: Map<string, string[]>): string[] | null {
  const state = new Map<string, 0 | 1 | 2>(); // 0=未访问 1=在栈上 2=完成
  const stack: string[] = [];
  const nodes = [...graph.keys()].sort();

  const dfs = (node: string): string[] | null => {
    state.set(node, 1);
    stack.push(node);
    const neighbors = [...(graph.get(node) ?? [])].sort();
    for (const next of neighbors) {
      const s = state.get(next) ?? 0;
      if (s === 1) {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (s === 0) {
        const found = dfs(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, 2);
    return null;
  };

  for (const n of nodes) {
    if ((state.get(n) ?? 0) === 0) {
      const found = dfs(n);
      if (found) return found;
    }
  }
  return null;
}

export function asClassDeclInput(
  decl: ClassDecl & { line?: number },
): ClassDeclInput {
  return { name: decl.name, parents: decl.parents, methods: decl.methods, line: decl.line };
}
