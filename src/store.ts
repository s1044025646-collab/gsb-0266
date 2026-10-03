import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { ALGORITHM_VERSION, ClassDecl, Hierarchy } from "./service.js";
import { ApiError, ErrorCodes } from "./errors.js";

/** SQLite 持久化：声明快照（版本化）、算法版本、查询报告。 */
export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        algorithm_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        snapshot TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id INTEGER NOT NULL REFERENCES versions(id),
        algorithm_version TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  /** 批量导入：调用方已完整校验；单事务落库，失败不留下半套声明。 */
  importSnapshot(decls: ClassDecl[]): number {
    const snapshot = JSON.stringify(decls);
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      const res = this.db
        .prepare("INSERT INTO versions (algorithm_version, created_at, snapshot) VALUES (?, ?, ?)")
        .run(ALGORITHM_VERSION, now, snapshot);
      this.db.exec("COMMIT");
      return Number(res.lastInsertRowid);
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  listVersions(): { id: number; algorithmVersion: string; createdAt: string; classCount: number }[] {
    const rows = this.db
      .prepare("SELECT id, algorithm_version, created_at, snapshot FROM versions ORDER BY id")
      .all() as unknown as { id: number; algorithm_version: string; created_at: string; snapshot: string }[];
    return rows.map((r) => ({
      id: r.id,
      algorithmVersion: r.algorithm_version,
      createdAt: r.created_at,
      classCount: (JSON.parse(r.snapshot) as ClassDecl[]).length,
    }));
  }

  loadHierarchy(versionId: number): Hierarchy {
    const row = this.db.prepare("SELECT snapshot FROM versions WHERE id = ?").get(versionId) as
      | { snapshot: string }
      | undefined;
    if (!row) throw new ApiError(ErrorCodes.VERSION_NOT_FOUND, `版本 ${versionId} 不存在。`, undefined, 404);
    const decls = JSON.parse(row.snapshot) as ClassDecl[];
    return { classes: new Map(decls.map((d) => [d.name, d])) };
  }

  saveReport(versionId: number, kind: string, subject: string, payload: unknown): number {
    const res = this.db
      .prepare(
        "INSERT INTO reports (version_id, algorithm_version, kind, subject, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(versionId, ALGORITHM_VERSION, kind, subject, JSON.stringify(payload), new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  listReports(versionId?: number): { id: number; versionId: number; kind: string; subject: string; createdAt: string }[] {
    const rows = (versionId
      ? this.db.prepare("SELECT id, version_id, kind, subject, created_at FROM reports WHERE version_id = ? ORDER BY id").all(versionId)
      : this.db.prepare("SELECT id, version_id, kind, subject, created_at FROM reports ORDER BY id").all()) as unknown as
      { id: number; version_id: number; kind: string; subject: string; created_at: string }[];
    return rows.map((r) => ({ id: r.id, versionId: r.version_id, kind: r.kind, subject: r.subject, createdAt: r.created_at }));
  }

  getReport(id: number) {
    const row = this.db
      .prepare("SELECT id, version_id, algorithm_version, kind, subject, payload, created_at FROM reports WHERE id = ?")
      .get(id) as
      | { id: number; version_id: number; algorithm_version: string; kind: string; subject: string; payload: string; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      versionId: row.version_id,
      algorithmVersion: row.algorithm_version,
      kind: row.kind,
      subject: row.subject,
      payload: JSON.parse(row.payload) as unknown,
      createdAt: row.created_at,
    };
  }

  close(): void {
    this.db.close();
  }
}
