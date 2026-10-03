import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ALGORITHM_VERSION } from "./c3.js";
import { ErrorCode, ApiError } from "./errors.js";
import type {
  AnalysisReport,
  ClassDecl,
  DeclSnapshot,
  LinearizationResult,
  MethodLookupResult,
} from "./types.js";

/**
 * SQLite 持久层：
 * - snapshots：声明快照（不可变），修改父类顺序即产生新版本
 * - reports：查询报告，绑定生成时的版本，重启后可按原输入复算
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    const abs = resolve(dbPath);
    mkdirSync(dirname(abs), { recursive: true });
    this.db = new DatabaseSync(abs);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        version INTEGER PRIMARY KEY AUTOINCREMENT,
        algorithm_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        report_id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER NOT NULL REFERENCES snapshots(version),
        algorithm_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        target_class TEXT,
        method TEXT,
        result_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /**
 * 保存快照。内容哈希与最新版本一致时复用该版本（幂等导入），
 * 否则新建版本 —— 父类顺序变化会改变哈希，从而产生新版本。
 */
  saveSnapshot(classes: ClassDecl[], note: string): {
    version: number;
    reused: boolean;
  } {
    const canonical = JSON.stringify(canonicalize(classes));
    const latest = this.latestVersion();
    if (latest !== null) {
      const row = this.db
        .prepare("SELECT payload_json FROM snapshots WHERE version = ?")
        .get(latest) as { payload_json: string } | undefined;
      if (row && row.payload_json === canonical) {
        return { version: latest, reused: true };
      }
    }
    const info = this.db
      .prepare(
        `INSERT INTO snapshots (algorithm_version, created_at, note, payload_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(ALGORITHM_VERSION, new Date().toISOString(), note, canonical);
    return { version: Number(info.lastInsertRowid), reused: false };
  }

  latestVersion(): number | null {
    const row = this.db
      .prepare("SELECT MAX(version) AS v FROM snapshots")
      .get() as { v: number | null } | undefined;
    const v = row?.v ?? null;
    return v === null ? null : Number(v);
  }

  listVersions(): {
    version: number;
    algorithmVersion: string;
    createdAt: string;
    note: string;
    classCount: number;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT version, algorithm_version, created_at, note, payload_json
         FROM snapshots ORDER BY version`,
      )
      .all() as {
      version: number;
      algorithm_version: string;
      created_at: string;
      note: string;
      payload_json: string;
    }[];
    return rows.map((r) => ({
      version: r.version,
      algorithmVersion: r.algorithm_version,
      createdAt: r.created_at,
      note: r.note,
      classCount: (JSON.parse(r.payload_json) as ClassDecl[]).length,
    }));
  }

  loadSnapshot(version: number): DeclSnapshot {
    const row = this.db
      .prepare(
        `SELECT version, algorithm_version, created_at, note, payload_json
         FROM snapshots WHERE version = ?`,
      )
      .get(version) as
      | {
          version: number;
          algorithm_version: string;
          created_at: string;
          note: string;
          payload_json: string;
        }
      | undefined;
    if (!row) {
      throw new ApiError(
        ErrorCode.VERSION_NOT_FOUND,
        `版本 ${version} 不存在`,
        404,
      );
    }
    return {
      version: row.version,
      algorithmVersion: row.algorithm_version,
      createdAt: row.created_at,
      note: row.note,
      classes: JSON.parse(row.payload_json) as ClassDecl[],
    };
  }

  /** 保存查询报告，返回报告 ID。 */
  saveReport(
    version: number,
    targetClass: string | null,
    method: string | null,
    result: { linearization: LinearizationResult | null; lookup: MethodLookupResult | null },
  ): number {
    const info = this.db
      .prepare(
        `INSERT INTO reports (version, algorithm_version, created_at, target_class, method, result_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        version,
        ALGORITHM_VERSION,
        new Date().toISOString(),
        targetClass,
        method,
        JSON.stringify(result),
      );
    return Number(info.lastInsertRowid);
  }

  listReports(version?: number): {
    reportId: number;
    version: number;
    createdAt: string;
    targetClass: string | null;
    method: string | null;
  }[] {
    const rows = (
      version === undefined
        ? this.db
            .prepare(
              `SELECT report_id, version, created_at, target_class, method
               FROM reports ORDER BY report_id`,
            )
            .all()
        : this.db
            .prepare(
              `SELECT report_id, version, created_at, target_class, method
               FROM reports WHERE version = ? ORDER BY report_id`,
            )
            .all(version)
    ) as {
      report_id: number;
      version: number;
      created_at: string;
      target_class: string | null;
      method: string | null;
    }[];
    return rows.map((r) => ({
      reportId: r.report_id,
      version: r.version,
      createdAt: r.created_at,
      targetClass: r.target_class,
      method: r.method,
    }));
  }

  loadReport(reportId: number): AnalysisReport {
    const row = this.db
      .prepare(
        `SELECT report_id, version, algorithm_version, created_at, target_class, method, result_json
         FROM reports WHERE report_id = ?`,
      )
      .get(reportId) as
      | {
          report_id: number;
          version: number;
          algorithm_version: string;
          created_at: string;
          target_class: string | null;
          method: string | null;
          result_json: string;
        }
      | undefined;
    if (!row) {
      throw new ApiError(ErrorCode.VERSION_NOT_FOUND, `报告 ${reportId} 不存在`, 404);
    }
    const result = JSON.parse(row.result_json) as {
      linearization: LinearizationResult | null;
      lookup: MethodLookupResult | null;
    };
    return {
      reportId: row.report_id,
      version: row.version,
      algorithmVersion: row.algorithm_version,
      generatedAt: row.created_at,
      targetClass: row.target_class,
      method: row.method,
      linearization: result.linearization,
      lookup: result.lookup,
      snapshot: null,
    };
  }

  close(): void {
    this.db.close();
  }
}

/**
 * 规范化为与输入行序无关的形态：类按名字排序，父类保持声明顺序（绝不重排）。
 * 方法已在校验阶段去重排序。
 */
function canonicalize(classes: ClassDecl[]): ClassDecl[] {
  return [...classes]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((c) => ({
      name: c.name,
      parents: [...c.parents],
      methods: [...c.methods].sort(),
    }));
}
