import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { ApiError, ValidationError, ErrorCode } from "./errors.js";
import { isValidIdentifier } from "./declarations.js";
import { AnalysisService } from "./service.js";

interface Route {
  method: string;
  pattern: RegExp;
  handler: (params: RegExpMatchArray, body: unknown, query: URLSearchParams) => unknown;
}

export interface StartedServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/** 让操作系统分配一个空闲端口（默认行为）。 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createNetServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolvePort(port));
      } else {
        srv.close(() => reject(new Error("无法获取空闲端口")));
      }
    });
    srv.on("error", reject);
  });
}

export function createApp(service: AnalysisService): Server {
  const routes: Route[] = [
    {
      method: "POST",
      pattern: /^\/api\/import$/,
      handler: (_p, body) => {
        const obj = asObject(body);
        const note = typeof obj.note === "string" ? obj.note : "";
        const result = service.importDeclarations(obj.classes, note);
        return { ok: true, ...result };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/versions$/,
      handler: () => ({ ok: true, versions: service.listVersions() }),
    },
    {
      method: "GET",
      pattern: /^\/api\/versions\/(\d+)\/relations$/,
      handler: (p) => ({
        ok: true,
        version: Number(p[1]),
        relations: service.relations(Number(p[1])),
      }),
    },
    {
      method: "GET",
      pattern: /^\/api\/versions\/(\d+)\/classes\/([A-Za-z_][A-Za-z0-9_]*)\/mro$/,
      handler: (p, _b, q) => {
        const r = service.linearization(
          Number(p[1]),
          String(p[2]),
          q.get("persist") === "1",
        );
        return { ok: r.ok, result: r };
      },
    },
    {
      method: "GET",
      pattern:
        /^\/api\/versions\/(\d+)\/classes\/([A-Za-z_][A-Za-z0-9_]*)\/lookup$/,
      handler: (p, _b, q) => {
        const method = q.get("method");
        if (!isValidIdentifier(method)) {
          throw new ApiError(
            ErrorCode.INVALID_IDENTIFIER,
            "查询参数 method 必须是合法标识符",
            400,
          );
        }
        const r = service.lookup(
          Number(p[1]),
          String(p[2]),
          method,
          q.get("persist") === "1",
        );
        return { ok: r.lookup.found, result: r };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/reports$/,
      handler: (_p, _b, q) => {
        const v = q.get("version");
        return {
          ok: true,
          reports: service.listReports(v === null ? undefined : Number(v)),
        };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/reports\/(\d+)$/,
      handler: (p, _b, q) => ({
        ok: true,
        report: service.exportReport(
          Number(p[1]),
          q.get("snapshot") !== "0",
        ),
      }),
    },
  ];

  const server = createServer((req, res) => {
    void handle(req, res, routes);
  });
  return server;
}

export async function startApp(
  service: AnalysisService,
  port: number | undefined,
  host = "127.0.0.1",
): Promise<StartedServer> {
  const listenPort = port ?? (await pickFreePort());
  const server = createApp(service);
  await new Promise<void>((resolveListen, reject) => {
    server.on("error", reject);
    server.listen(listenPort, host, () => resolveListen());
  });
  const addr = server.address();
  const actualPort = addr && typeof addr === "object" ? addr.port : listenPort;
  return {
    server,
    port: actualPort,
    close: () =>
      new Promise<void>((resolveClose, reject) =>
        server.close((err) => (err ? reject(err) : resolveClose())),
      ),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  routes: Route[],
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    let body: unknown = null;
    if (req.method === "POST") {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          throw new ApiError(ErrorCode.INVALID_BODY, "请求体不是合法 JSON", 400);
        }
      }
    }
    const route = routes.find(
      (r) => r.method === req.method && r.pattern.test(url.pathname),
    );
    if (!route) {
      sendJson(res, 404, {
        ok: false,
        error: { code: "NOT_FOUND", message: `无此路由: ${req.method} ${url.pathname}` },
      });
      return;
    }
    const match = url.pathname.match(route.pattern)!;
    const data = await route.handler(match, body, url.searchParams);
    sendJson(res, 200, data);
  } catch (err) {
    if (err instanceof ValidationError) {
      sendJson(res, 422, {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: err.message,
          details: err.errors,
        },
      });
      return;
    }
    if (err instanceof ApiError) {
      sendJson(res, err.status, {
        ok: false,
        error: { code: err.code, message: err.message, ...err.extra },
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, {
      ok: false,
      error: { code: "INTERNAL", message },
    });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const json = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) {
    throw new ApiError(ErrorCode.INVALID_BODY, "请求体必须是 JSON 对象", 400);
  }
  return body as Record<string, unknown>;
}
