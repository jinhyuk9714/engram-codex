import { describe, test } from "node:test";
import assert from "node:assert/strict";

describe("graceful shutdown", () => {
  test("runs teardown once even when invoked multiple times", async () => {
    const mod = await import("../../lib/http/graceful-shutdown.js");
    const events = [];
    let closeServer;

    assert.equal(typeof mod.createGracefulShutdown, "function");

    const shutdown = mod.createGracefulShutdown({
      server: {
        close(callback) {
          events.push("server.close");
          closeServer = callback;
        }
      },
      getAllSessionIds: () => ({
        streamableIds: ["s-1"],
        legacyIds: ["l-1"]
      }),
      closeStreamableSession: async (id) => {
        events.push(`closeStreamable:${id}`);
      },
      closeLegacySseSession: async (id) => {
        events.push(`closeLegacy:${id}`);
      },
      stopMemoryEvaluator: () => {
        events.push("stopMemoryEvaluator");
      },
      stopEmbeddingWorker: () => {
        events.push("stopEmbeddingWorker");
      },
      stopRecurringJobs: () => {
        events.push("stopRecurringJobs");
      },
      shutdownNLI: async () => {
        events.push("shutdownNLI");
      },
      shutdownPool: async () => {
        events.push("shutdownPool");
      },
      saveAccessStats: async (logDir) => {
        events.push(`saveAccessStats:${logDir}`);
      },
      setExitCode: (code) => {
        events.push(`exitCode:${code}`);
      },
      logDir: "tmp/test-logs",
      consoleImpl: { log() {} }
    });

    const first = shutdown("SIGINT");
    const second = shutdown("SIGTERM");
    assert.strictEqual(first, second);

    closeServer();
    await first;

    assert.deepEqual(events, [
      "server.close",
      "closeStreamable:s-1",
      "closeLegacy:l-1",
      "stopMemoryEvaluator",
      "stopEmbeddingWorker",
      "stopRecurringJobs",
      "shutdownNLI",
      "shutdownPool",
      "saveAccessStats:tmp/test-logs",
      "exitCode:0"
    ]);
  });

  test("awaits NLI cleanup before exiting", async () => {
    const mod = await import("../../lib/http/graceful-shutdown.js");
    const events = [];
    let closeServer;
    let resolveNli;

    const shutdown = mod.createGracefulShutdown({
      server: {
        close(callback) {
          events.push("server.close");
          closeServer = callback;
        }
      },
      getAllSessionIds: () => ({ streamableIds: [], legacyIds: [] }),
      closeStreamableSession: async () => {},
      closeLegacySseSession: async () => {},
      stopMemoryEvaluator: () => {
        events.push("stopMemoryEvaluator");
      },
      stopEmbeddingWorker: () => {
        events.push("stopEmbeddingWorker");
      },
      stopRecurringJobs: () => {
        events.push("stopRecurringJobs");
      },
      shutdownNLI: () => new Promise((resolve) => {
        events.push("shutdownNLI:start");
        resolveNli = () => {
          events.push("shutdownNLI:done");
          resolve();
        };
      }),
      shutdownPool: async () => {
        events.push("shutdownPool");
      },
      saveAccessStats: async () => {
        events.push("saveAccessStats");
      },
      setExitCode: (code) => {
        events.push(`exitCode:${code}`);
      },
      logDir: "tmp/test-logs",
      consoleImpl: { log() {} }
    });

    const promise = shutdown("SIGINT");
    closeServer();
    await Promise.resolve();

    assert.deepEqual(events, [
      "server.close",
      "stopMemoryEvaluator",
      "stopEmbeddingWorker",
      "stopRecurringJobs",
      "shutdownNLI:start"
    ]);

    resolveNli();
    await promise;

    assert.deepEqual(events, [
      "server.close",
      "stopMemoryEvaluator",
      "stopEmbeddingWorker",
      "stopRecurringJobs",
      "shutdownNLI:start",
      "shutdownNLI:done",
      "shutdownPool",
      "saveAccessStats",
      "exitCode:0"
    ]);
  });
});
