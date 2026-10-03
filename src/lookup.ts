import { ErrorCode, ApiError } from "./errors.js";
import type { ClassDecl, LinearizationResult, MethodLookupResult } from "./types.js";

export type ClassMap = ReadonlyMap<string, ClassDecl>;

/**
 * 按成功线性化顺序查找方法：返回第一个定义者，其余定义者列为被遮蔽。
 * 线性化冲突的类不允许查找（抛 C3_CONFLICT）。
 */
export function lookupMethod(
  classes: ClassMap,
  linearization: LinearizationResult,
  method: string,
): MethodLookupResult {
  if (!linearization.ok || !linearization.mro) {
    throw new ApiError(
      ErrorCode.C3_CONFLICT,
      `类 ${linearization.className} 的线性化存在冲突，不能进行方法查找`,
      409,
      { conflict: linearization.conflict },
    );
  }

  const definers: { className: string; order: number }[] = [];
  linearization.mro.forEach((name, order) => {
    const decl = classes.get(name);
    if (decl && decl.methods.includes(method)) {
      definers.push({ className: name, order });
    }
  });

  const first = definers[0];
  return {
    className: linearization.className,
    method,
    found: first !== undefined,
    provider: first ? first.className : null,
    shadowed: definers.slice(1),
    mro: linearization.mro,
  };
}
