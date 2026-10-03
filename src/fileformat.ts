import { readFileSync } from "node:fs";
import type { ClassDeclInput } from "./types.js";
import { ErrorCode, ApiError } from "./errors.js";

/**
 * 读取声明文件。
 *
 * 支持两种格式（按扩展名/内容选择）：
 * 1. .json：[{ "name": "A", "parents": ["X"], "methods": ["foo"] }]
 * 2. .txt：每行一条，形如
 *      Child(Parent1, Parent2): method1, method2
 *      Root: method_a
 *    # 开头为注释，空行忽略；行号用于错误定位。
 *
 * 注意：同一类的父类书写顺序会被原样保留，但各类所在行的先后顺序
 * 不影响线性化结果（结果对文件行序不敏感）。
 */
export function readDeclFile(filePath: string): ClassDeclInput[] {
  const text = readFileSync(filePath, "utf8");
  if (filePath.toLowerCase().endsWith(".json")) {
    return parseJson(text);
  }
  return parseText(text);
}

function parseJson(text: string): ClassDeclInput[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new ApiError(
      ErrorCode.INVALID_BODY,
      `JSON 解析失败: ${(err as Error).message}`,
      400,
    );
  }
  if (!Array.isArray(data)) {
    throw new ApiError(ErrorCode.INVALID_BODY, "JSON 顶层必须是声明数组", 400);
  }
  return data.map((item, i) => {
    const obj = (item ?? {}) as Record<string, unknown>;
    return {
      name: String(obj.name ?? ""),
      parents: asStringArray(obj.parents),
      methods: asStringArray(obj.methods),
      line: typeof obj.line === "number" ? obj.line : i + 1,
    };
  });
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

export function parseText(text: string): ClassDeclInput[] {
  const out: ClassDeclInput[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line.length === 0) return;

    const [headPart, methodPart = ""] = splitOnce(line, ":");
    const head = headPart.trim();

    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^)]*)\))?$/.exec(head);
    if (!m) {
      throw new ApiError(
        ErrorCode.INVALID_BODY,
        `第 ${lineNo} 行无法解析，期望 'Name(Parent1, Parent2): m1, m2' 形式: ${rawLine.trim()}`,
        400,
      );
    }
    const name = m[1]!;
    const parents = m[2]
      ? m[2]
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];
    const methods = methodPart
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    out.push({ name, parents, methods, line: lineNo });
  });
  return out;
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  if (i < 0) return [s, ""];
  return [s.slice(0, i), s.slice(i + 1)];
}
