import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

function createJsonRpcResult(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

async function readJson(response) {
  return JSON.parse(await response.text());
}

function createServerOptions(overrides = {}) {
  const config = {
    accessKey: "",
    sessionTtlMs: 60_000,
    logDir: "tmp/test-logs",
    rateLimitWindowMs: 60_000,
    rateLimitMaxRequests: 120,
    redisEnabled: false,
    port: 0,
    ...overrides.config
  };

  const deps = {
    validateOrigin: () => true,
    sendJSON: async (res, statusCode, payload) => {
      res.statusCode = statusCode;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(payload));
    },
    readJsonBody: async (req) => {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString() || "{}");
    },
    metricsRegister: {
      contentType: "text/plain; version=0.0.4",
      metrics: async () => "# HELP test 1\n"
    },
    recordHttpRequest: () => {},
    updateSessionCounts: () => {},
    getSessionCounts: () => ({ streamable: 0, legacy: 0, total: 0 }),
    getPoolStats: () => ({ total: 1, idle: 1, waiting: 0 }),
    getPrimaryPool: () => ({
      query: async () => ({ rows: [] })
    }),
    redisClient: { status: "stub" },
    rateLimiter: { allow: () => true, cleanup: () => {} },
    jsonRpcError: (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } }),
    dispatchJsonRpc: async (msg) => ({
      kind: "ok",
      response: createJsonRpcResult(msg.id ?? null, { ok: true })
    }),
    isInitializeRequest: (msg) => msg?.method === "initialize",
    validateAuthentication: async (req, msg) => {
      const bearer = req.headers.authorization;
      if (config.accessKey && bearer === `Bearer ${config.accessKey}`) {
        return { valid: true };
      }
      if (config.accessKey && msg?.params?.accessKey === config.accessKey) {
        return { valid: true };
      }
      if (config.accessKey) {
        return { valid: false, error: "Invalid or missing access key" };
      }
      return { valid: true };
    },
    requireAuthentication: async () => true,
    createStreamableSession: async () => "session-test-1",
    validateStreamableSession: async () => ({ valid: false, reason: "Invalid session" }),
    closeStreamableSession: async () => {},
    createLegacySseSession: () => "legacy-session",
    validateLegacySseSession: () => ({ valid: false, reason: "Invalid session" }),
    closeLegacySseSession: async () => {},
    getLegacySession: () => ({ authenticated: true, res: null }),
    getAllSessionIds: () => ({ streamableIds: [], legacyIds: [] }),
    cleanupExpiredSessions: async () => {},
    validateMasterKey: () => false,
    listApiKeys: async () => [],
    createApiKey: async () => ({}),
    updateApiKeyStatus: async () => ({}),
    deleteApiKey: async () => {},
    getAuthServerMetadata: () => ({}),
    getResourceMetadata: () => ({}),
    handleAuthorize: async () => ({}),
    handleToken: async () => ({}),
    cleanupExpiredOAuthData: async () => {},
    handleAdminApiRequest: async () => false,
    isAdminImageRequest: () => false,
    isAdminUiRequest: () => false,
    getAdminImageMeta: () => ({ filePath: "", mimeType: "application/octet-stream" }),
    saveAccessStats: async () => {},
    shutdownPool: async () => {},
    getMemoryEvaluator: () => ({ start: async () => {}, stop: () => {} }),
    memoryManagerFactory: () => ({ consolidate: async () => ({}) }),
    consoleImpl: console,
    registerRecurringJobs: () => ({}),
    ...overrides.deps
  };

  return { config, deps };
}

async function startServer(overrides = {}) {
  process.env.LOG_DIR = "tmp/test-logs";
  const { createHttpServer } = await import("../../lib/http/server.js");
  const server = createHttpServer(createServerOptions(overrides));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

const servers = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe("HTTP server black-box behavior", () => {
  test("GET /health returns 200 and reports Redis as disabled when Redis is optional", async () => {
    const { server, baseUrl } = await startServer({
      config: { redisEnabled: false }
    });
    servers.push(server);

    const response = await fetch(`${baseUrl}/health`);
    const payload = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(payload.status, "healthy");
    assert.deepEqual(payload.checks.redis, { status: "disabled" });
    assert.equal(payload.checks.database.status, "up");
  });

  test("GET /ready returns 200 when PostgreSQL is reachable", async () => {
    const { server, baseUrl } = await startServer();
    servers.push(server);

    const response = await fetch(`${baseUrl}/ready`);
    const payload = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(payload.checks.database.status, "up");
  });

  test("GET /ready returns 503 when PostgreSQL is unavailable", async () => {
    const { server, baseUrl } = await startServer({
      deps: {
        getPrimaryPool: () => ({
          query: async () => {
            throw new Error("database offline");
          }
        })
      }
    });
    servers.push(server);

    const response = await fetch(`${baseUrl}/ready`);
    const payload = await readJson(response);

    assert.equal(response.status, 503);
    assert.equal(payload.checks.database.status, "down");
  });

  test("POST /mcp initialize returns 401 when access key is required and missing", async () => {
    const { server, baseUrl } = await startServer({
      config: { accessKey: "test-key" }
    });
    servers.push(server);

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" }
      })
    });
    const payload = await readJson(response);

    assert.equal(response.status, 401);
    assert.equal(payload.error.message, "Invalid or missing access key");
  });

  test("POST /mcp initialize returns 200 and MCP-Session-Id when auth is valid", async () => {
    const { server, baseUrl } = await startServer({
      config: { accessKey: "test-key" }
    });
    servers.push(server);

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          accessKey: "test-key"
        }
      })
    });
    const payload = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("mcp-session-id"), "session-test-1");
    assert.deepEqual(payload, createJsonRpcResult(1, { ok: true }));
  });

  test("GET /metrics returns Prometheus content type", async () => {
    const { server, baseUrl } = await startServer();
    servers.push(server);

    const response = await fetch(`${baseUrl}/metrics`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /^text\/plain/);
    assert.match(body, /# HELP test 1/);
  });
});
