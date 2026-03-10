import http from "http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import {
  PORT,
  ACCESS_KEY,
  SESSION_TTL_MS,
  LOG_DIR,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
  REDIS_ENABLED
} from "../config.js";
import { RateLimiter } from "../rate-limiter.js";
import {
  register as metricsRegister,
  recordHttpRequest,
  updateSessionCounts
} from "../metrics.js";
import { validateOrigin, readJsonBody, sseWrite } from "../utils.js";
import { sendJSON } from "../compression.js";
import {
  createStreamableSession,
  validateStreamableSession,
  closeStreamableSession,
  createLegacySseSession,
  validateLegacySseSession,
  closeLegacySseSession,
  getSessionCounts,
  getLegacySession
} from "../sessions.js";
import {
  isInitializeRequest,
  requireAuthentication,
  validateMasterKey,
  validateAuthentication
} from "../auth.js";
import {
  listApiKeys,
  createApiKey,
  updateApiKeyStatus,
  deleteApiKey
} from "../admin/ApiKeyStore.js";
import {
  getAuthServerMetadata,
  getResourceMetadata,
  handleAuthorize,
  handleToken
} from "../oauth.js";
import { jsonRpcError, dispatchJsonRpc } from "../jsonrpc.js";
import {
  getAdminImageMeta,
  handleAdminApiRequest,
  isAdminImageRequest,
  isAdminUiRequest
} from "./admin.js";
import { getPrimaryPool, getPoolStats } from "../tools/db.js";
import { redisClient } from "../redis.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");

export function getDefaultHttpConfig() {
  return {
    port: PORT,
    accessKey: ACCESS_KEY,
    sessionTtlMs: SESSION_TTL_MS,
    logDir: LOG_DIR,
    rateLimitWindowMs: RATE_LIMIT_WINDOW_MS,
    rateLimitMaxRequests: RATE_LIMIT_MAX_REQUESTS,
    redisEnabled: REDIS_ENABLED,
    rootDir: ROOT_DIR
  };
}

function getDefaultDeps() {
  return {
    validateOrigin,
    readJsonBody,
    sseWrite,
    sendJSON,
    metricsRegister,
    recordHttpRequest,
    updateSessionCounts,
    createStreamableSession,
    validateStreamableSession,
    closeStreamableSession,
    createLegacySseSession,
    validateLegacySseSession,
    closeLegacySseSession,
    getSessionCounts,
    getLegacySession,
    isInitializeRequest,
    requireAuthentication,
    validateMasterKey,
    validateAuthentication,
    listApiKeys,
    createApiKey,
    updateApiKeyStatus,
    deleteApiKey,
    getAuthServerMetadata,
    getResourceMetadata,
    handleAuthorize,
    handleToken,
    jsonRpcError,
    dispatchJsonRpc,
    getAdminImageMeta,
    handleAdminApiRequest,
    isAdminImageRequest,
    isAdminUiRequest,
    getPrimaryPool,
    getPoolStats,
    redisClient,
    osImpl: os
  };
}

function createProbePayload(status) {
  return {
    status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    pid: process.pid,
    workerId: process.env.WORKER_ID || "single",
    memory: process.memoryUsage(),
    checks: {}
  };
}

function getMetadataBaseUrl(req, config) {
  return `https://${req.headers.host || `localhost:${config.port}`}`;
}

async function populateDependencyChecks(health, { config, deps, readiness }) {
  if (!config.redisEnabled) {
    health.checks.redis = { status: "disabled" };
  } else {
    try {
      if (deps.redisClient && deps.redisClient.status === "ready") {
        health.checks.redis = { status: "up" };
      } else {
        health.checks.redis = { status: "down", error: "Not connected" };
      }
    } catch (err) {
      health.checks.redis = { status: "down", error: err.message };
    }
  }

  try {
    const pool = deps.getPrimaryPool();
    await pool.query("SELECT 1");
    const poolStats = deps.getPoolStats?.();
    health.checks.database = { status: "up", ...(poolStats ? { pool: poolStats } : {}) };
  } catch (err) {
    health.checks.database = { status: "down", error: err.message };
    if (readiness) {
      health.status = "not_ready";
    }
  }

  const sessionCounts = deps.getSessionCounts();
  health.checks.sessions = {
    streamable: sessionCounts.streamable,
    legacy: sessionCounts.legacy,
    total: sessionCounts.total
  };
}

async function handleHealthRequest(req, res, startTime, { config, deps }) {
  const health = createProbePayload("healthy");
  await populateDependencyChecks(health, { config, deps, readiness: false });
  await deps.sendJSON(res, 200, health, req);
  const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
  deps.recordHttpRequest(req.method, "/health", 200, duration);
}

async function handleReadyRequest(req, res, startTime, { config, deps }) {
  const health = createProbePayload("ready");
  await populateDependencyChecks(health, { config, deps, readiness: true });
  const statusCode = health.checks.database?.status === "up" ? 200 : 503;
  await deps.sendJSON(res, statusCode, health, req);
  const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
  deps.recordHttpRequest(req.method, "/ready", statusCode, duration);
}

export function createHttpServer(options = {}) {
  const config = {
    ...getDefaultHttpConfig(),
    ...(options.config || {})
  };
  const deps = {
    ...getDefaultDeps(),
    ...(options.deps || {})
  };
  const rateLimiter = options.deps?.rateLimiter
    ?? new RateLimiter({
      windowMs: config.rateLimitWindowMs,
      maxRequests: config.rateLimitMaxRequests
    });

  return http.createServer(async (req, res) => {
    const startTime = process.hrtime.bigint();

    if (!deps.validateOrigin(req, res)) {
      return;
    }

    const url = new URL(req.url || "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      await handleHealthRequest(req, res, startTime, { config, deps });
      return;
    }

    if (req.method === "GET" && url.pathname === "/ready") {
      await handleReadyRequest(req, res, startTime, { config, deps });
      return;
    }

    if (req.method === "GET" && url.pathname === "/metrics") {
      try {
        res.statusCode = 200;
        res.setHeader("Content-Type", deps.metricsRegister.contentType);
        res.end(await deps.metricsRegister.metrics());

        const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
        deps.recordHttpRequest(req.method, url.pathname, 200, duration);
      } catch (err) {
        console.error("[Metrics] Error generating metrics:", err);
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/mcp") {
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
      res.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id");

      const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
        || req.socket.remoteAddress
        || "unknown";

      if (!rateLimiter.allow(clientIp)) {
        res.writeHead(429, { "Retry-After": String(Math.ceil(config.rateLimitWindowMs / 1000)) });
        res.end(JSON.stringify(deps.jsonRpcError(null, -32000, "Too many requests")));
        return;
      }

      let sessionId = req.headers["mcp-session-id"] || url.searchParams.get("sessionId") || url.searchParams.get("mcp-session-id");
      let sessionKeyId = null;
      let msg;

      try {
        msg = await deps.readJsonBody(req);
      } catch (err) {
        if (err.statusCode === 413) {
          await deps.sendJSON(res, 413, deps.jsonRpcError(null, -32000, "Payload too large"), req);
          return;
        }
        await deps.sendJSON(res, 400, deps.jsonRpcError(null, -32700, "Parse error"), req);
        return;
      }

      if (sessionId) {
        const validation = await deps.validateStreamableSession(sessionId);

        if (!validation.valid) {
          await deps.sendJSON(res, 400, deps.jsonRpcError(null, -32000, validation.reason), req);
          return;
        }

        const session = validation.session;
        sessionKeyId = session.keyId ?? null;

        if (!session.authenticated) {
          if (!await deps.requireAuthentication(req, res, msg, null)) {
            return;
          }

          session.authenticated = true;
        }
      }

      if (!sessionId && deps.isInitializeRequest(msg)) {
        const authCheck = await deps.validateAuthentication(req, msg);

        if (!authCheck.valid) {
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(deps.jsonRpcError(msg.id ?? null, -32000, authCheck.error)));
          return;
        }

        sessionKeyId = authCheck.keyId ?? null;
        sessionId = await deps.createStreamableSession(true, sessionKeyId);
        console.log(`[Streamable] Authenticated session created: ${sessionId}${sessionKeyId ? ` (keyId: ${sessionKeyId})` : " (master)"}`);
      }

      if (!sessionId) {
        await deps.sendJSON(res, 400, deps.jsonRpcError(
          msg?.id ?? null,
          -32000,
          "Session required. Send an 'initialize' request first to create a session, then include the returned MCP-Session-Id header in subsequent requests."
        ), req);
        return;
      }

      if (msg.method === "tools/call" && msg.params?.arguments) {
        msg.params.arguments._sessionId = sessionId;
        msg.params.arguments._keyId = sessionKeyId;
      }

      const { kind, response } = await deps.dispatchJsonRpc(msg);

      if (kind === "accepted") {
        res.statusCode = 202;
        res.setHeader("MCP-Session-Id", sessionId);
        res.end();
        return;
      }

      res.setHeader("MCP-Session-Id", sessionId);
      await deps.sendJSON(res, 200, response, req);

      const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
      deps.recordHttpRequest(req.method, url.pathname, 200, duration);
      return;
    }

    if (req.method === "GET" && url.pathname === "/mcp") {
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
      res.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id");

      const sessionId = req.headers["mcp-session-id"] || url.searchParams.get("sessionId") || url.searchParams.get("mcp-session-id");

      if (!sessionId) {
        res.statusCode = 400;
        res.end("Missing session ID");
        return;
      }

      const validation = await deps.validateStreamableSession(sessionId);

      if (!validation.valid) {
        res.statusCode = 400;
        res.end(validation.reason);
        return;
      }

      const session = validation.session;

      if (!session.authenticated) {
        res.statusCode = 401;
        res.end("Unauthorized");
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("MCP-Session-Id", sessionId);

      session.setSseResponse(res);

      req.on("close", () => {
        console.log(`[Streamable] SSE closed for session: ${sessionId}`);
        session.setSseResponse(null);
      });

      return;
    }

    if (req.method === "DELETE" && url.pathname === "/mcp") {
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
      res.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id");

      const sessionId = req.headers["mcp-session-id"] || url.searchParams.get("sessionId") || url.searchParams.get("mcp-session-id");

      if (!sessionId) {
        res.statusCode = 400;
        res.end("Missing session ID");
        return;
      }

      const validation = await deps.validateStreamableSession(sessionId);

      if (!validation.valid) {
        res.statusCode = 400;
        res.end(validation.reason);
        return;
      }

      await deps.closeStreamableSession(sessionId);
      console.log(`[Streamable] Session deleted: ${sessionId}`);

      res.statusCode = 200;
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/sse") {
      const rawKey = url.searchParams.get("accessKey") || "";
      let accessKey = rawKey;
      try {
        accessKey = decodeURIComponent(rawKey);
      } catch {}
      const isAuthenticated = !config.accessKey || (accessKey === config.accessKey);

      if (!isAuthenticated) {
        res.statusCode = 401;
        res.end("Unauthorized");
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");

      const sessionId = deps.createLegacySseSession(res);
      const session = deps.getLegacySession(sessionId);
      session.authenticated = isAuthenticated;

      console.log(`[Legacy SSE] Session created: ${sessionId}`);

      deps.sseWrite(res, "endpoint", `/message?sessionId=${encodeURIComponent(sessionId)}`);

      req.on("close", () => {
        console.log(`[Legacy SSE] Session closed: ${sessionId}`);
        deps.closeLegacySseSession(sessionId);
      });

      return;
    }

    if (req.method === "POST" && url.pathname === "/message") {
      const sessionId = url.searchParams.get("sessionId");

      if (!sessionId) {
        res.statusCode = 400;
        res.end("Missing session ID");
        return;
      }

      const validation = deps.validateLegacySseSession(sessionId);

      if (!validation.valid) {
        res.statusCode = 404;
        res.end(validation.reason);
        return;
      }

      const session = validation.session;

      if (!session.authenticated) {
        res.statusCode = 401;
        res.end("Unauthorized");
        return;
      }

      let msg;
      try {
        msg = await deps.readJsonBody(req);
      } catch (err) {
        if (err.statusCode === 413) {
          res.statusCode = 413;
          res.end("Payload too large");
          return;
        }
        res.statusCode = 400;
        res.end("Invalid JSON");
        return;
      }

      if (msg.method === "tools/call" && msg.params?.arguments) {
        msg.params.arguments._sessionId = sessionId;
      }

      const { kind, response } = await deps.dispatchJsonRpc(msg);

      if (kind === "ok" || kind === "error") {
        deps.sseWrite(session.res, "message", response);
      }

      res.statusCode = 202;
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      const baseUrl = getMetadataBaseUrl(req, config);
      const metadata = deps.getAuthServerMetadata(baseUrl);

      res.setHeader("Access-Control-Allow-Origin", "*");
      await deps.sendJSON(res, 200, metadata, req);
      return;
    }

    if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
      const baseUrl = getMetadataBaseUrl(req, config);
      const metadata = deps.getResourceMetadata(baseUrl);

      res.setHeader("Access-Control-Allow-Origin", "*");
      await deps.sendJSON(res, 200, metadata, req);
      return;
    }

    if (req.method === "GET" && url.pathname === "/authorize") {
      const params = {
        response_type: url.searchParams.get("response_type"),
        client_id: url.searchParams.get("client_id"),
        redirect_uri: url.searchParams.get("redirect_uri"),
        code_challenge: url.searchParams.get("code_challenge"),
        code_challenge_method: url.searchParams.get("code_challenge_method"),
        state: url.searchParams.get("state"),
        scope: url.searchParams.get("scope")
      };

      const result = await deps.handleAuthorize(params);

      if (result.error) {
        const redirectUri = params.redirect_uri;
        if (redirectUri) {
          const errorUrl = new URL(redirectUri);
          errorUrl.searchParams.set("error", result.error);
          errorUrl.searchParams.set("error_description", result.error_description);
          if (params.state) {
            errorUrl.searchParams.set("state", params.state);
          }
          res.statusCode = 302;
          res.setHeader("Location", errorUrl.toString());
          res.end();
        } else {
          await deps.sendJSON(res, 400, result, req);
        }
        return;
      }

      if (result.redirect) {
        res.statusCode = 302;
        res.setHeader("Location", result.redirect);
        res.end();
        return;
      }

      res.statusCode = 500;
      res.end("Internal error");
      return;
    }

    if (req.method === "POST" && url.pathname === "/token") {
      let body;
      try {
        const rawBody = await new Promise((resolve, reject) => {
          const chunks = [];
          req.on("data", (chunk) => chunks.push(chunk));
          req.on("end", () => resolve(Buffer.concat(chunks).toString()));
          req.on("error", reject);
        });

        const contentType = req.headers["content-type"] || "";
        if (contentType.includes("application/json")) {
          body = JSON.parse(rawBody);
        } else {
          body = Object.fromEntries(new URLSearchParams(rawBody));
        }
      } catch {
        await deps.sendJSON(res, 400, { error: "invalid_request", error_description: "Failed to parse request body" }, req);
        return;
      }

      const result = await deps.handleToken(body);

      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Access-Control-Allow-Origin", "*");
      await deps.sendJSON(res, result.error ? 400 : 200, result, req);
      return;
    }

    if (deps.isAdminUiRequest(req.method, url.pathname)) {
      const htmlPath = path.join(config.rootDir, "assets", "admin", "index.html");
      fs.readFile(htmlPath, (err, data) => {
        if (err) {
          res.statusCode = 404;
          res.end("Admin UI not found");
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.end(data);
      });
      return;
    }

    if (deps.isAdminImageRequest(req.method, url.pathname)) {
      const imageMeta = deps.getAdminImageMeta(url.pathname, config.rootDir);
      fs.readFile(imageMeta.filePath, (err, data) => {
        if (err) {
          res.statusCode = 404;
          res.end("Image not found");
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", imageMeta.mimeType);
        res.setHeader("Cache-Control", "public, max-age=86400");
        res.end(data);
      });
      return;
    }

    if (await deps.handleAdminApiRequest({
      req,
      res,
      pathname: url.pathname,
      origin: req.headers.origin,
      deps: {
        validateMasterKey: deps.validateMasterKey,
        readJsonBody: deps.readJsonBody,
        getPrimaryPool: deps.getPrimaryPool,
        listApiKeys: deps.listApiKeys,
        createApiKey: deps.createApiKey,
        updateApiKeyStatus: deps.updateApiKeyStatus,
        deleteApiKey: deps.deleteApiKey,
        getSessionCounts: deps.getSessionCounts,
        redisClient: deps.redisClient,
        osImpl: deps.osImpl,
        statfsSync: fs.statfsSync
      }
    })) {
      return;
    }

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Session-Id, memento-access-key");
      res.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id");
      res.setHeader("Access-Control-Max-Age", "86400");
      res.end();
      return;
    }

    res.statusCode = 404;
    res.end("Not Found");

    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    deps.recordHttpRequest(req.method, url.pathname, 404, duration);
  });
}
