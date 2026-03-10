/**
 * Engram Codex Server (HTTP) - production bootstrap
 */

import "./lib/load-env.js";

import { PORT, ACCESS_KEY, SESSION_TTL_MS, LOG_DIR, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS } from "./lib/config.js";
import { RateLimiter } from "./lib/rate-limiter.js";
import {
  closeStreamableSession,
  closeLegacySseSession,
  cleanupExpiredSessions,
  getSessionCounts,
  getAllSessionIds
} from "./lib/sessions.js";
import { cleanupExpiredOAuthData } from "./lib/oauth.js";
import { clearRecurringJobs, registerRecurringJobs } from "./lib/http/startup.js";
import { createHttpServer } from "./lib/http/server.js";
import { createGracefulShutdown } from "./lib/http/graceful-shutdown.js";
import { saveAccessStats } from "./lib/tools/index.js";
import { shutdownPool } from "./lib/tools/db.js";
import { getMemoryEvaluator } from "./lib/memory/MemoryEvaluator.js";
import { MemoryManager } from "./lib/memory/MemoryManager.js";
import { updateSessionCounts } from "./lib/metrics.js";
import { preloadNLI, shutdownNLI } from "./lib/memory/NLIClassifier.js";

const rateLimiter = new RateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: RATE_LIMIT_MAX_REQUESTS
});
setInterval(() => rateLimiter.cleanup(), 5 * 60_000).unref();

let globalEmbeddingWorker = null;
let recurringJobs = null;

const server = createHttpServer({
  deps: { rateLimiter }
});

server.listen(PORT, () => {
  console.log(`Engram Codex HTTP server listening on port ${PORT}`);
  console.log("Streamable HTTP endpoints: POST/GET/DELETE /mcp");
  console.log("Legacy SSE endpoints: GET /sse, POST /message");
  console.log("Probe endpoints: GET /health, GET /ready, GET /metrics");

  if (ACCESS_KEY) {
    console.log("Authentication: ENABLED");
  } else {
    console.log("Authentication: DISABLED (set ENGRAM_ACCESS_KEY to enable)");
  }

  console.log(`Session TTL: ${SESSION_TTL_MS / 60000} minutes`);

  recurringJobs = registerRecurringJobs({
    env: process.env,
    logDir: LOG_DIR,
    cleanupExpiredSessions,
    cleanupExpiredOAuthData,
    getSessionCounts,
    updateSessionCounts,
    saveAccessStats,
    memoryManagerFactory: () => MemoryManager.getInstance(),
    consoleImpl: console
  });

  getMemoryEvaluator().start().catch((err) => {
    console.error("[Startup] Failed to start MemoryEvaluator:", err.message);
  });

  import("./lib/memory/EmbeddingWorker.js")
    .then(({ EmbeddingWorker }) => {
      globalEmbeddingWorker = new EmbeddingWorker();
      return globalEmbeddingWorker.start();
    })
    .then(async () => {
      const { GraphLinker } = await import("./lib/memory/GraphLinker.js");
      const graphLinker = new GraphLinker();

      globalEmbeddingWorker.on("embedding_ready", async ({ fragmentId }) => {
        try {
          const count = await graphLinker.linkFragment(fragmentId, "system");
          if (count > 0) {
            console.debug(`[GraphLinker] Linked ${count} for ${fragmentId}`);
          }
        } catch (err) {
          console.warn(`[GraphLinker] Error: ${err.message}`);
        }
      });
    })
    .catch((err) => {
      console.error("[Startup] Failed to start EmbeddingWorker:", err.message);
    });

  preloadNLI().catch((err) => {
    console.warn("[Startup] NLI preload skipped:", err.message);
  });
});

const gracefulShutdown = createGracefulShutdown({
  server,
  getAllSessionIds,
  closeStreamableSession,
  closeLegacySseSession,
  stopMemoryEvaluator: () => getMemoryEvaluator().stop(),
  stopEmbeddingWorker: () => {
    if (globalEmbeddingWorker) {
      globalEmbeddingWorker.stop();
    }
  },
  stopRecurringJobs: () => clearRecurringJobs(recurringJobs),
  shutdownNLI,
  shutdownPool,
  saveAccessStats,
  logDir: LOG_DIR,
  setExitCode: (code) => {
    process.exitCode = code;
  },
  consoleImpl: console
});

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
