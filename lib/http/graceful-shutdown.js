export function createGracefulShutdown({
  server,
  getAllSessionIds,
  closeStreamableSession,
  closeLegacySseSession,
  stopMemoryEvaluator,
  stopEmbeddingWorker,
  stopRecurringJobs,
  shutdownNLI,
  shutdownPool,
  saveAccessStats,
  logDir,
  setExitCode = (code) => {
    process.exitCode = code;
  },
  consoleImpl = console
}) {
  let shutdownPromise = null;

  return function gracefulShutdown(signal) {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      try {
        consoleImpl.log(`\n[Shutdown] Received ${signal}, starting graceful shutdown...`);

        const serverClosed = new Promise((resolve, reject) => {
          server.close((err) => {
            if (err) {
              reject(err);
              return;
            }

            consoleImpl.log("[Shutdown] HTTP server closed");
            resolve();
          });
        });

        consoleImpl.log("[Shutdown] Closing all sessions (with auto-reflect)...");
        const { streamableIds, legacyIds } = getAllSessionIds();
        for (const sessionId of streamableIds) {
          await closeStreamableSession(sessionId);
        }
        for (const sessionId of legacyIds) {
          await closeLegacySseSession(sessionId);
        }

        stopMemoryEvaluator?.();
        stopEmbeddingWorker?.();
        stopRecurringJobs?.();

        await shutdownNLI?.();
        await shutdownPool?.();
        await saveAccessStats?.(logDir);
        consoleImpl.log("[Shutdown] Final stats saved");

        await serverClosed;
        consoleImpl.log("[Shutdown] Graceful shutdown complete");
        setExitCode(0);
      } catch (err) {
        consoleImpl.error?.(`[Shutdown] Graceful shutdown failed: ${err.message}`);
        setExitCode(1);
      }
    })();

    return shutdownPromise;
  };
}
