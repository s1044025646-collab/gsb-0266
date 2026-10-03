#!/usr/bin/env node
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { Store } from "./store.js";
import { AnalysisService } from "./service.js";
import { readDeclFile } from "./fileformat.js";
import { startApp } from "./server.js";
import { ApiError, ValidationError } from "./errors.js";
import { ALGORITHM_VERSION } from "./c3.js";

const DATA_DIR = resolve(process.env.C3_DATA_DIR ?? "data");
const DB_PATH = resolve(DATA_DIR, "c3.sqlite");

interface ParsedArgs {
  flags: Map<string, string | boolean>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      else flags.set(arg.slice(2), true);
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function openService(): AnalysisService {
  mkdirSync(DATA_DIR, { recursive: true });
  return new AnalysisService(new Store(DB_PATH));
}

async function main(): Promise<number> {
  const [command = "help", ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    case "version":
      process.stdout.write(`c3tool ${ALGORITHM_VERSION}\n`);
      return 0;
    case "import": {
      const file = args.positionals[0];
      if (!file) fail("用法: c3tool import <decl-file> [--note=...]");
      const decls = readDeclFile(resolve(file));
      const service = openService();
      const result = service.importDeclarations(
        decls,
        String(args.flags.get("note") ?? ""),
      );
      printJson({ ok: true, ...result });
      return 0;
    }
    case "versions": {
      const service = openService();
      printJson({ ok: true, versions: service.listVersions() });
      return 0;
    }
    case "relations": {
      const service = openService();
      const v = resolveVersionArg(service, args);
      printJson({ ok: true, version: v, relations: service.relations(v) });
      return 0;
    }
    case "mro": {
      const className = args.positionals[0];
      if (!className) fail("用法: c3tool mro <ClassName> [--version=N] [--persist]");
      const service = openService();
      const v = resolveVersionArg(service, args);
      const result = service.linearization(v, className, args.flags.has("persist"));
      printJson({ ok: result.ok, result });
      return result.ok ? 0 : 2;
    }
    case "merge": {
      const className = args.positionals[0];
      if (!className) fail("用法: c3tool merge <ClassName> [--version=N]");
      const service = openService();
      const v = resolveVersionArg(service, args);
      const result = service.linearization(v, className, false);
      printJson({
        ok: result.ok,
        className,
        mro: result.mro,
        rounds: result.rounds,
        conflict: result.conflict,
      });
      return result.ok ? 0 : 2;
    }
    case "lookup": {
      const className = args.positionals[0];
      const method = args.positionals[1];
      if (!className || !method) {
        fail("用法: c3tool lookup <ClassName> <method> [--version=N] [--persist]");
      }
      const service = openService();
      const v = resolveVersionArg(service, args);
      const result = service.lookup(v, className!, method!, args.flags.has("persist"));
      printJson({ ok: result.lookup.found, result });
      return result.lookup.found ? 0 : 1;
    }
    case "reports": {
      const service = openService();
      const vFlag = args.flags.get("version");
      printJson({
        ok: true,
        reports: service.listReports(
          vFlag === undefined || vFlag === true ? undefined : Number(vFlag),
        ),
      });
      return 0;
    }
    case "report": {
      const id = Number(args.positionals[0]);
      if (!Number.isInteger(id)) fail("用法: c3tool report <reportId> [--no-snapshot]");
      const service = openService();
      printJson({
        ok: true,
        report: service.exportReport(id, !args.flags.has("no-snapshot")),
      });
      return 0;
    }
    case "serve": {
      const service = openService();
      const portFlag = args.flags.get("port");
      const host = String(args.flags.get("host") ?? "127.0.0.1");
      const port =
        portFlag === undefined || portFlag === true
          ? undefined
          : Number(portFlag);
      const started = await startApp(service, port, host);
      process.stdout.write(
        `C3 分析服务已启动: http://${host}:${started.port}  (数据: ${DB_PATH})\n`,
      );
      const shutdown = () => {
        void started.close().then(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      await new Promise<void>(() => {});
      return 0;
    }
    default:
      process.stderr.write(`未知命令: ${command}\n\n`);
      printHelp();
      return 2;
  }
}

function resolveVersionArg(service: AnalysisService, args: ParsedArgs): number {
  const v = args.flags.get("version");
  if (v === undefined || v === true) return service.resolveVersion(undefined);
  return Number(v);
}

function printHelp(): void {
  process.stdout.write(
    [
      "c3tool — 离线 C3 多重继承线性化与方法查找后端",
      `算法版本: ${ALGORITHM_VERSION}；数据目录: ${DATA_DIR} (可用环境变量 C3_DATA_DIR 覆盖)`,
      "",
      "用法:",
      "  c3tool import <decl.json|decl.txt> [--note=...]   导入声明（完整校验通过才落库，产生新版本）",
      "  c3tool versions                                   列出声明快照版本",
      "  c3tool relations [--version=N]                    查看类关系（父类/子类/自有方法）",
      "  c3tool mro <ClassName> [--version=N] [--persist]  计算线性化（--persist 存报告）",
      "  c3tool merge <ClassName> [--version=N]            查看 C3 合并过程与冲突详情",
      "  c3tool lookup <ClassName> <method> [--version=N] [--persist]  按 MRO 查找方法定义者",
      "  c3tool reports [--version=N]                      列出查询报告",
      "  c3tool report <reportId> [--no-snapshot]          导出报告（默认附原输入快照）",
      "  c3tool serve [--port=PORT] [--host=127.0.0.1]     启动 HTTP API（默认自动选空闲端口）",
      "  c3tool version",
      "",
      "文本声明格式示例 (# 为注释):",
      "  O",
      "  X(O): xm",
      "  Y(O): ym, foo",
      "  A(X, Y): foo       # 父类顺序 X,Y 有意义",
      "",
    ].join("\n"),
  );
}

function fail(message: string): never {
  process.stderr.write(message + "\n");
  process.exit(2);
}main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof ValidationError) {
      printJson({
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: err.message,
          details: err.errors,
        },
      });
      process.exit(3);
    }
    if (err instanceof ApiError) {
      printJson({ ok: false, error: { code: err.code, message: err.message } });
      process.exit(2);
    }
    process.stderr.write((err instanceof Error ? err.stack ?? err.message : String(err)) + "\n");
    process.exit(1);
  },
);
