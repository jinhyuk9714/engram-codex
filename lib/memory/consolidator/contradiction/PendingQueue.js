import { logDebug, logInfo, logWarn } from "../../../logger.js";

const LAST_CHECK_KEY = "frag:contradiction_check_at";
const PENDING_KEY = "frag:pending_contradictions";
const PENDING_BATCH_SIZE = 10;

async function defaultGetRedisClient() {
  const { redisClient } = await import("../../../redis.js");
  return redisClient;
}

export class PendingQueue {
  constructor({
    getRedisClient = defaultGetRedisClient,
    logInfoFn = logInfo,
    logWarnFn = logWarn,
    logDebugFn = logDebug
  } = {}) {
    this.getRedisClient = getRedisClient;
    this.logInfo = logInfoFn;
    this.logWarn = logWarnFn;
    this.logDebug = logDebugFn;
  }

  async getLastCheckAt() {
    const redisClient = await this.getRedisClient();

    try {
      if (redisClient && redisClient.status === "ready") {
        const value = await redisClient.get(LAST_CHECK_KEY);
        return value || null;
      }
    } catch (err) {
      this.logWarn(`[MemoryConsolidator] Redis lastCheckAt read failed: ${err.message}`);
    }

    return null;
  }

  async updateLastCheckAt(timestamp) {
    const redisClient = await this.getRedisClient();

    try {
      if (redisClient && redisClient.status === "ready") {
        const normalizedTimestamp = timestamp instanceof Date
          ? timestamp.toISOString()
          : (typeof timestamp === "string" ? timestamp : new Date().toISOString());
        await redisClient.set(LAST_CHECK_KEY, normalizedTimestamp);
      }
    } catch (err) {
      this.logWarn(`[MemoryConsolidator] Contradiction timestamp update failed: ${err.message}`);
    }
  }

  async flagPotentialContradiction(fragmentA, fragmentB) {
    const redisClient = await this.getRedisClient();

    try {
      if (redisClient && redisClient.status === "ready") {
        const entry = JSON.stringify({
          idA: fragmentA.id,
          idB: fragmentB.id,
          contentA: fragmentA.content,
          contentB: fragmentB.content,
          flaggedAt: new Date().toISOString()
        });
        await redisClient.rpush(PENDING_KEY, entry);
        this.logDebug(`[MemoryConsolidator] Flagged potential contradiction: ${fragmentA.id} <-> ${fragmentB.id}`);
      }
    } catch (err) {
      this.logWarn(`[MemoryConsolidator] Failed to flag contradiction: ${err.message}`);
    }
  }

  async processPendingContradictions({
    resolutionPolicy,
    candidateFinder,
    isGeminiAvailable,
    askGeminiContradiction,
    getFragmentById,
    resolveContradiction
  } = {}) {
    const redisClient = await this.getRedisClient();
    const canUseGemini = isGeminiAvailable
      || resolutionPolicy?.isGeminiAvailable?.bind(resolutionPolicy);
    const askGemini = askGeminiContradiction
      || resolutionPolicy?.askGeminiContradiction?.bind(resolutionPolicy);
    const loadFragment = getFragmentById
      || candidateFinder?.getFragmentById?.bind(candidateFinder);
    const resolve = resolveContradiction
      || resolutionPolicy?.resolveContradiction?.bind(resolutionPolicy);

    if (!canUseGemini || !askGemini || !loadFragment || !resolve) return 0;
    if (!await canUseGemini()) return 0;
    if (!redisClient || redisClient.status !== "ready") return 0;

    let processed = 0;

    for (let index = 0; index < PENDING_BATCH_SIZE; index++) {
      const raw = await redisClient.lpop(PENDING_KEY);
      if (!raw) break;

      try {
        const entry = JSON.parse(raw);
        const verdict = await askGemini(entry.contentA, entry.contentB);

        if (verdict.contradicts) {
          const fragmentA = await loadFragment(entry.idA);
          const fragmentB = await loadFragment(entry.idB);

          if (fragmentA && fragmentB) {
            await resolve(fragmentA, fragmentB, verdict.reasoning);
            processed++;
          }
        }
      } catch (err) {
        this.logWarn(`[MemoryConsolidator] Pending contradiction processing failed: ${err.message}`);
        try {
          await redisClient.rpush(PENDING_KEY, raw);
        } catch {
          // ignore
        }
        break;
      }
    }

    if (processed > 0) {
      this.logInfo(`[MemoryConsolidator] Processed ${processed} pending contradictions`);
    }

    return processed;
  }
}
