import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "./store.js";
import { validateDecls, linearizeOf, lookupMethod, buildReport, ALGORITHM_VERSION } from "./service.js";
import { startServer } from "./server.js";
import { ApiError } from "./errors.js";

const DB_PATH = process.env.C3_DB ?? path.join(process.cwd(), "data", "c3.db");

function latestVersion(store: Store): number {
  const vs = store.listVersions();
  if (vs.length === 0) throw new ApiError("E_INVALID_INPUT", "尚无版本，请先 import。");
  return vs[vs.length - 1].id;
}

function parseVersion(args: string[], store: Store): number {
  const i = args.indexOf("--version");
  if (i >= 0) return Number(args[i + 1]);
  return latestVersion(store);
}

function print(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

export function runCli(argv: string[]): void {
  const [cmd, ...args] = argv;
  const store = new Store(DB_PATH);
  try {
    switch (cmd) {
      case "import": {
        const file = args[0];
        if (!file) throw new ApiError("E_INVALID_INPUT", "用法: import <decls.json>");
        const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
        const decls = raw && typeof raw === "object" && "classes" in raw ? raw.classes : raw;
        const h = validateDecls(decls);
        const version = store.importSnapshot([...h.classes.values()]);
        print({ version, algorithmVersion: ALGORITHM_VERSION, classCount: h.classes.size });
        break;
      }
      case "versions":
        print({ versions: store.listVersions() });
        break;
      case "classes": {
        const v = parseVersion(args, store);
        print({ version: v, classes: [...store.loadHierarchy(v).classes.values()] });
        break;
      }
      case "show": {
        const v = parseVersion(args, store);
        const decl = store.loadHierarchy(v).classes.get(args[0]);
        if (!decl) throw new ApiError("E_CLASS_NOT_FOUND", `类 ${args[0]} 不存在。`);
        print(decl);
        break;
      }
      case "mro":
      case "trace": {
        const v = parseVersion(args, store);
        const r = linearizeOf(store.loadHierarchy(v), args[0]);
        store.saveReport(v, "linearize", args[0], r);
        if (!r.ok) {
          print({ code: "E_CONFLICT", reason: r.reason, remainingHeads: r.remainingHeads, steps: r.steps });
          process.exitCode = 1;
        } else if (cmd === "trace") {
          print(r);
        } else {
          print({ order: r.order });
        }
        break;
      }
      case "lookup": {
        const v = parseVersion(args, store);
        const r = lookupMethod(store.loadHierarchy(v), args[0], args[1]);
        store.saveReport(v, "lookup", `${args[0]}.${args[1]}`, r);
        print(r);
        if (!r.found) process.exitCode = 1;
        break;
      }
      case "report": {
        const v = parseVersion(args, store);
        const report = buildReport(store.loadHierarchy(v), v);
        const id = store.saveReport(v, "report", `version-${v}`, report);
        print({ reportId: id, ...report });
        break;
      }
      case "reports": {
        print({ reports: store.listReports() });
        break;
      }
      case "serve": {
        const i = args.indexOf("--port");
        const port = i >= 0 ? Number(args[i + 1]) : 0; // 0 = 自动选择空闲端口
        startServer(store, port).then(() => {});
        return; // 不关闭 store，服务持续运行
      }
      default:
        console.log(`用法: c3 <command>
  import <file>          导入类声明（JSON），生成新版本
  versions               列出所有版本
  classes [--version N]  查看某版本的类关系
  show <Class>           查看单个类声明
  mro <Class>            计算线性化（方法解析顺序）
  trace <Class>          查看完整合并过程（含被拒绝候选）
  lookup <Class> <m>     查找方法提供者与被遮蔽定义者
  report [--version N]   生成并保存分析报告
  reports                列出已保存报告
  serve [--port N]       启动 HTTP API（默认自动选择空闲端口）`);
    }
  } catch (e) {
    if (e instanceof ApiError) {
      console.error(JSON.stringify({ code: e.code, message: e.message, details: e.details ?? null }));
      process.exitCode = 1;
    } else {
      throw e;
    }
  } finally {
    if (argv[0] !== "serve") store.close();
  }
}
