import * as http from "node:http";
import { Store } from "./store.js";
import { validateDecls, linearizeOf, lookupMethod, buildReport, ALGORITHM_VERSION } from "./service.js";
import { ApiError, ErrorCodes } from "./errors.js";

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 5 * 1024 * 1024) reject(new ApiError(ErrorCodes.INVALID_INPUT, "请求体过大。"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/api/health") {
        return send(res, 200, { ok: true, algorithmVersion: ALGORITHM_VERSION });
      }
      if (method === "POST" && url.pathname === "/api/imports") {
        const body = JSON.parse(await readBody(req));
        const decls = (body && typeof body === "object" && "classes" in body ? body.classes : body) as unknown;
        const h = validateDecls(decls); // 先完整校验
        const version = store.importSnapshot([...h.classes.values()]); // 再单事务保存
        return send(res, 201, { version, algorithmVersion: ALGORITHM_VERSION, classCount: h.classes.size });
      }
      if (method === "GET" && url.pathname === "/api/versions") {
        return send(res, 200, { versions: store.listVersions() });
      }
      if (parts[0] === "api" && parts[1] === "versions" && parts[2]) {
        const versionId = Number(parts[2]);
        if (!Number.isInteger(versionId)) throw new ApiError(ErrorCodes.INVALID_INPUT, "版本号须为整数。");
        const h = store.loadHierarchy(versionId);
        if (method === "GET" && parts.length === 4 && parts[3] === "classes") {
          return send(res, 200, { version: versionId, classes: [...h.classes.values()] });
        }
        if (method === "GET" && parts.length === 5 && parts[3] === "classes") {
          const decl = h.classes.get(decodeURIComponent(parts[4]));
          if (!decl) throw new ApiError(ErrorCodes.CLASS_NOT_FOUND, `类 ${parts[4]} 不存在。`, undefined, 404);
          return send(res, 200, decl);
        }
        if (method === "GET" && parts.length === 5 && parts[3] === "linearize") {
          const name = decodeURIComponent(parts[4]);
          const r = linearizeOf(h, name);
          store.saveReport(versionId, "linearize", name, r);
          if (!r.ok) throw new ApiError(ErrorCodes.CONFLICT, r.reason, r);
          return send(res, 200, r);
        }
        if (method === "GET" && parts.length === 6 && parts[3] === "lookup") {
          const name = decodeURIComponent(parts[4]);
          const m = decodeURIComponent(parts[5]);
          const r = lookupMethod(h, name, m);
          store.saveReport(versionId, "lookup", `${name}.${m}`, r);
          if (!r.found) {
            return send(res, 404, { code: ErrorCodes.METHOD_NOT_FOUND, message: `方法 ${m} 在类 ${name} 的线性化中未找到。`, result: r });
          }
          return send(res, 200, r);
        }
        if (method === "GET" && parts.length === 4 && parts[3] === "report") {
          const report = buildReport(h, versionId);
          const id = store.saveReport(versionId, "report", `version-${versionId}`, report);
          return send(res, 200, { reportId: id, ...report });
        }
      }
      if (method === "GET" && parts[0] === "api" && parts[1] === "reports") {
        if (parts.length === 2) return send(res, 200, { reports: store.listReports() });
        const id = Number(parts[2]);
        const r = store.getReport(id);
        if (!r) throw new ApiError(ErrorCodes.INVALID_INPUT, `报告 ${id} 不存在。`, undefined, 404);
        return send(res, 200, r);
      }
      throw new ApiError(ErrorCodes.INVALID_INPUT, `未知路由：${method} ${url.pathname}`, undefined, 404);
    } catch (e) {
      if (e instanceof ApiError) {
        return send(res, e.httpStatus, { code: e.code, message: e.message, details: e.details ?? null });
      }
      if (e instanceof SyntaxError) {
        return send(res, 400, { code: ErrorCodes.INVALID_INPUT, message: "请求体不是合法 JSON。" });
      }
      send(res, 500, { code: "E_INTERNAL", message: String(e) });
    }
  });
}

export function startServer(store: Store, port: number): Promise<http.Server> {
  const server = createServer(store);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      console.log(`C3 分析服务已启动: http://127.0.0.1:${actual} (算法版本 ${ALGORITHM_VERSION})`);
      resolve(server);
    });
  });
}
