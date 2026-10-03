import { linearize, findCycle, MergeStep, LinearizeResult } from "./c3.js";
import { ApiError, ErrorCodes } from "./errors.js";

export const ALGORITHM_VERSION = "c3-1.0.0";
export const MAX_CLASSES = 1000;
export const MAX_NAME_LENGTH = 64;
export const MAX_METHODS_PER_CLASS = 500;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ClassDecl {
  name: string;
  parents: string[];
  methods: string[];
}

export interface Hierarchy {
  classes: Map<string, ClassDecl>;
}

function checkName(kind: string, value: unknown): string {
  if (typeof value !== "string" || !NAME_RE.test(value) || value.length > MAX_NAME_LENGTH) {
    throw new ApiError(
      ErrorCodes.INVALID_NAME,
      `${kind} "${String(value)}" 非法：须为区分大小写的标识符（字母/下划线开头，仅含字母数字下划线），长度 1-${MAX_NAME_LENGTH}。`
    );
  }
  return value;
}

/** 完整校验一批声明；任何错误都抛出，调用方保证不落库。 */
export function validateDecls(raw: unknown): Hierarchy {
  if (!Array.isArray(raw)) throw new ApiError(ErrorCodes.INVALID_INPUT, "请求体须为类声明数组。");
  if (raw.length === 0) throw new ApiError(ErrorCodes.INVALID_INPUT, "类声明数组不能为空。");
  if (raw.length > MAX_CLASSES) {
    throw new ApiError(ErrorCodes.TOO_MANY_CLASSES, `类数量 ${raw.length} 超过上限 ${MAX_CLASSES}。`);
  }
  const classes = new Map<string, ClassDecl>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      throw new ApiError(ErrorCodes.INVALID_INPUT, "每个类声明须为对象 {name, parents, methods}。");
    }
    const { name, parents = [], methods = [] } = item as Record<string, unknown>;
    const clsName = checkName("类名", name);
    if (classes.has(clsName)) {
      throw new ApiError(ErrorCodes.DUPLICATE_CLASS, `重复类名：${clsName}。`);
    }
    if (!Array.isArray(parents)) throw new ApiError(ErrorCodes.INVALID_INPUT, `类 ${clsName} 的 parents 须为数组。`);
    if (!Array.isArray(methods)) throw new ApiError(ErrorCodes.INVALID_INPUT, `类 ${clsName} 的 methods 须为数组。`);
    if (methods.length > MAX_METHODS_PER_CLASS) {
      throw new ApiError(ErrorCodes.INVALID_INPUT, `类 ${clsName} 的方法数超过上限 ${MAX_METHODS_PER_CLASS}。`);
    }
    const parentList = parents.map((p) => checkName(`类 ${clsName} 的父类名`, p));
    const seen = new Set<string>();
    for (const p of parentList) {
      if (seen.has(p)) throw new ApiError(ErrorCodes.DUPLICATE_PARENT, `类 ${clsName} 的直接父类 ${p} 重复。`);
      seen.add(p);
      if (p === clsName) throw new ApiError(ErrorCodes.SELF_INHERITANCE, `类 ${clsName} 不能继承自身。`);
    }
    const methodList = methods.map((m) => checkName(`类 ${clsName} 的方法名`, m));
    classes.set(clsName, { name: clsName, parents: parentList, methods: [...new Set(methodList)] });
  }
  for (const decl of classes.values()) {
    for (const p of decl.parents) {
      if (!classes.has(p)) {
        throw new ApiError(ErrorCodes.MISSING_PARENT, `类 ${decl.name} 引用了未声明的父类 ${p}。`);
      }
    }
  }
  const cycle = findCycle([...classes.keys()], (c) => classes.get(c)!.parents);
  if (cycle) {
    throw new ApiError(ErrorCodes.CYCLE, `检测到继承环：${cycle.join(" -> ")}。`, { cycle });
  }
  // 全量试算，提前暴露顺序矛盾，保证导入的层次整体可线性化。
  const h: Hierarchy = { classes };
  for (const name of classes.keys()) {
    const r = linearizeOf(h, name);
    if (!r.ok) {
      throw new ApiError(ErrorCodes.CONFLICT, r.reason, { class: name, remainingHeads: r.remainingHeads });
    }
  }
  return h;
}

export function linearizeOf(h: Hierarchy, name: string): LinearizeResult {
  const decl = h.classes.get(name);
  if (!decl) throw new ApiError(ErrorCodes.CLASS_NOT_FOUND, `类 ${name} 不存在。`, undefined, 404);
  return linearize(name, (c) => h.classes.get(c)!.parents);
}

export interface LookupResult {
  className: string;
  method: string;
  found: boolean;
  provider?: string;
  shadowed?: string[];
  mro?: string[];
}

export function lookupMethod(h: Hierarchy, name: string, method: string): LookupResult {
  checkName("方法名", method);
  const lin = linearizeOf(h, name);
  if (!lin.ok) {
    throw new ApiError(ErrorCodes.CONFLICT, `类 ${name} 线性化冲突，不能进行方法查找：${lin.reason}`);
  }
  const definers = lin.order.filter((c) => h.classes.get(c)!.methods.includes(method));
  if (definers.length === 0) {
    return { className: name, method, found: false, mro: lin.order };
  }
  return { className: name, method, found: true, provider: definers[0], shadowed: definers.slice(1), mro: lin.order };
}

export interface Report {
  algorithmVersion: string;
  version: number;
  generatedAt: string;
  classes: {
    name: string;
    parents: string[];
    methods: string[];
    mro: string[];
    mergeSteps: MergeStep[];
  }[];
}

export function buildReport(h: Hierarchy, version: number): Report {
  const classes = [...classesIter(h)].map((decl) => {
    const lin = linearizeOf(h, decl.name);
    if (!lin.ok) throw new ApiError(ErrorCodes.CONFLICT, lin.reason);
    return { name: decl.name, parents: decl.parents, methods: decl.methods, mro: lin.order, mergeSteps: lin.steps };
  });
  return { algorithmVersion: ALGORITHM_VERSION, version, generatedAt: new Date().toISOString(), classes };
}

function* classesIter(h: Hierarchy) {
  yield* h.classes.values();
}
