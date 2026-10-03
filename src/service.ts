import { C3Analyzer } from "./c3.js";
import { ErrorCode, ApiError, ValidationError } from "./errors.js";
import { lookupMethod } from "./lookup.js";
import { Store } from "./store.js";
import { validateDeclarations } from "./declarations.js";
import type {
  AnalysisReport,
  ClassDecl,
  DeclSnapshot,
  LinearizationResult,
  MethodLookupResult,
} from "./types.js";

export interface ImportResult {
  version: number;
  reused: boolean;
  classCount: number;
}

/** 关系视图条目。 */
export interface RelationRow {
  name: string;
  parents: string[];
  children: string[];
  methods: string[];
}

export class AnalysisService {
  constructor(private readonly store: Store) {}

  /**
   * 批量导入：先完整校验，通过后才在一个事务里落库；
   * 校验失败直接抛出，不产生任何写入（半套声明不可能残留）。
   */
  importDeclarations(rawClasses: unknown, note = ""): ImportResult {
    const classes = validateDeclarations(rawClasses);
    const tx = this.store.db.prepare("BEGIN");
    try {
      tx.run();
      const saved = this.store.saveSnapshot(classes, note);
      this.store.db.prepare("COMMIT").run();
      return { version: saved.version, reused: saved.reused, classCount: classes.length };
    } catch (err) {
      this.store.db.prepare("ROLLBACK").run();
      throw err;
    }
  }

  listVersions() {
    return this.store.listVersions();
  }

  resolveVersion(version: number | undefined): number {
    if (version !== undefined) return version;
    const latest = this.store.latestVersion();
    if (latest === null) {
      throw new ApiError(
        ErrorCode.VERSION_NOT_FOUND,
        "尚无任何声明版本，请先导入",
        404,
      );
    }
    return latest;
  }

  getSnapshot(version: number): DeclSnapshot {
    return this.store.loadSnapshot(version);
  }

  /** 查看类关系：直接父类、直接子类、自有方法。 */
  relations(version: number): RelationRow[] {
    const snap = this.store.loadSnapshot(version);
    const childrenOf = new Map<string, Set<string>>();
    for (const c of snap.classes) {
      for (const p of c.parents) {
        if (!childrenOf.has(p)) childrenOf.set(p, new Set());
        childrenOf.get(p)!.add(c.name);
      }
    }
    return snap.classes.map((c) => ({
      name: c.name,
      parents: [...c.parents],
      children: [...(childrenOf.get(c.name) ?? new Set<string>())].sort(),
      methods: [...c.methods],
    }));
  }

  /** 计算某类线性化（基于指定版本的快照复算），可选持久化为报告。 */
  linearization(
    version: number,
    className: string,
    persist = false,
  ): LinearizationResult & { reportId: number | null } {
    const snap = this.store.loadSnapshot(version);
    const result = analyzeFromSnapshot(snap, className);
    let reportId: number | null = null;
    if (persist) {
      reportId = this.store.saveReport(version, className, null, {
        linearization: result,
        lookup: null,
      });
    }
    return { ...result, reportId };
  }

  /** 方法查找（基于指定版本复算），可选持久化为报告。 */
  lookup(
    version: number,
    className: string,
    method: string,
    persist = false,
  ): {
    linearization: LinearizationResult;
    lookup: MethodLookupResult;
    reportId: number | null;
  } {
    const snap = this.store.loadSnapshot(version);
    const lin = analyzeFromSnapshot(snap, className);
    const map = new Map(snap.classes.map((c) => [c.name, c]));
    const result = lookupMethod(map, lin, method);
    let reportId: number | null = null;
    if (persist) {
      reportId = this.store.saveReport(version, className, method, {
        linearization: lin,
        lookup: result,
      });
    }
 return { linearization: lin, lookup: result, reportId };
  }

  /** 导出报告：自包含，附带复算所用快照，保证旧报告可按原输入复算。 */
  exportReport(
    reportId: number,
    includeSnapshot = true,
  ): AnalysisReport {
    const report = this.store.loadReport(reportId);
    if (includeSnapshot) {
      report.snapshot = this.store.loadSnapshot(report.version);
    }
    return report;
  }

  listReports(version?: number) {
    return this.store.listReports(version);
  }
}

/** 用快照中的声明构建类映射并执行线性化（纯函数式复算入口）。 */
export function analyzeFromSnapshot(
  snap: DeclSnapshot,
  className: string,
): LinearizationResult {
  const map = new Map<string, ClassDecl>(snap.classes.map((c) => [c.name, c]));
  if (!map.has(className)) {
    throw new ApiError(
      ErrorCode.CLASS_NOT_FOUND,
      `版本 ${snap.version} 中不存在类 ${className}`,
      404,
    );
  }
  const analyzer = C3Analyzer.fromArray(snap.classes);
  return analyzer.linearize(className);
}

export { ValidationError };
