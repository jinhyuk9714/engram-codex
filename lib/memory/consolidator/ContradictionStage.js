import { queryWithAgentVector } from "../../tools/db.js";
import { geminiCLIJson, isGeminiCLIAvailable } from "../../gemini.js";
import { detectContradiction as nliDetect, isNLIAvailable } from "../NLIClassifier.js";
import { logDebug, logInfo, logWarn } from "../../logger.js";
import { SCHEMA } from "./constants.js";
import { CandidateFinder } from "./contradiction/CandidateFinder.js";
import { PendingQueue } from "./contradiction/PendingQueue.js";
import { ResolutionPolicy } from "./contradiction/ResolutionPolicy.js";

async function defaultGetRedisClient() {
  const { redisClient } = await import("../../redis.js");
  return redisClient;
}

export class ContradictionStage {
  constructor({
    store,
    query = queryWithAgentVector,
    geminiJson = geminiCLIJson,
    isGeminiAvailable = isGeminiCLIAvailable,
    detectNli = nliDetect,
    isNliAvailable = isNLIAvailable,
    getRedisClient = defaultGetRedisClient,
    logInfoFn = logInfo,
    logWarnFn = logWarn,
    logDebugFn = logDebug,
    schema = SCHEMA,
    candidateFinder,
    resolutionPolicy,
    pendingQueue
  } = {}) {
    this.store = store;
    this.query = query;
    this.geminiJson = geminiJson;
    this.isGeminiAvailable = isGeminiAvailable;
    this.detectNli = detectNli;
    this.isNliAvailable = isNliAvailable;
    this.getRedisClient = getRedisClient;
    this.logInfo = logInfoFn;
    this.logWarn = logWarnFn;
    this.logDebug = logDebugFn;
    this.schema = schema;
    this.candidateFinder = candidateFinder || new CandidateFinder({
      query,
      schema
    });
    this.resolutionPolicy = resolutionPolicy || new ResolutionPolicy({
      store,
      query,
      geminiJson,
      isGeminiAvailable,
      detectNli,
      isNliAvailable,
      logInfoFn,
      logWarnFn,
      schema
    });
    this.pendingQueue = pendingQueue || new PendingQueue({
      getRedisClient,
      logInfoFn,
      logWarnFn,
      logDebugFn
    });
  }

  async run() {
    const contradictionResult = await this._detectContradictions();

    return {
      contradictionsFound: contradictionResult.found,
      nliResolvedDirectly: contradictionResult.nliResolved,
      nliSkippedAsNonContra: contradictionResult.nliSkipped,
      supersessionsDetected: await this._detectSupersessions(),
      pendingContradictions: await this._processPendingContradictions()
    };
  }

  async _detectContradictions() {
    const lastCheckAt = await this.pendingQueue.getLastCheckAt();
    const newFragments = await this.candidateFinder.listNewFragments(lastCheckAt);
    if (newFragments.length === 0) {
      return { found: 0, nliResolved: 0, nliSkipped: 0 };
    }

    const isNliAvailable = this.resolutionPolicy.isNliAvailable
      || this.isNliAvailable;
    const isGeminiAvailable = this.resolutionPolicy.isGeminiAvailable
      || this.isGeminiAvailable;
    const nliAvailable = isNliAvailable ? isNliAvailable() : false;
    const geminiAvailable = isGeminiAvailable ? await isGeminiAvailable() : false;
    let found = 0;
    let nliResolved = 0;
    let nliSkipped = 0;
    let latestProcessed = null;

    for (const newFragment of newFragments) {
      const candidates = await this.candidateFinder.listContradictionCandidates(newFragment);
      if (candidates.length === 0) continue;

      for (const candidate of candidates) {
        const outcome = await this.resolutionPolicy.reviewContradiction(
          newFragment,
          candidate,
          {
            nliAvailable,
            geminiAvailable,
            pendingQueue: this.pendingQueue
          }
        );

        found += outcome.found;
        nliResolved += outcome.nliResolved;
        nliSkipped += outcome.nliSkipped;

        if (outcome.markProcessed && (!latestProcessed || newFragment.created_at > latestProcessed)) {
          latestProcessed = newFragment.created_at;
        }
      }
    }

    if (latestProcessed) {
      await this.pendingQueue.updateLastCheckAt(latestProcessed);
    }

    if (nliResolved > 0 || nliSkipped > 0) {
      this.logInfo(`[MemoryConsolidator] NLI stats: ${nliResolved} resolved, ${nliSkipped} skipped (saved ${nliResolved + nliSkipped} Gemini calls)`);
    }

    return { found, nliResolved, nliSkipped };
  }

  async _resolveContradiction(newFragment, candidate, reasoning) {
    // valid_to updates are delegated to ResolutionPolicy.resolveContradiction.
    return this.resolutionPolicy.resolveContradiction(newFragment, candidate, reasoning);
  }

  async _detectSupersessions() {
    const isGeminiAvailable = this.resolutionPolicy.isGeminiAvailable
      || this.isGeminiAvailable;
    const geminiAvailable = isGeminiAvailable ? await isGeminiAvailable() : false;
    if (!geminiAvailable) return 0;

    const candidates = await this.candidateFinder.listSupersessionPairs();
    if (candidates.length === 0) return 0;

    let detected = 0;

    for (const pair of candidates) {
      if (await this.resolutionPolicy.reviewSupersession(pair, { geminiAvailable })) {
        detected++;
      }
    }

    return detected;
  }

  async _askGeminiSupersession(contentA, contentB) {
    return this.resolutionPolicy.askGeminiSupersession(contentA, contentB);
  }

  async _askGeminiContradiction(contentA, contentB) {
    return this.resolutionPolicy.askGeminiContradiction(contentA, contentB);
  }

  async _flagPotentialContradiction(redisClient, key, fragmentA, fragmentB) {
    return this.pendingQueue.flagPotentialContradiction(fragmentA, fragmentB);
  }

  async _processPendingContradictions() {
    return this.pendingQueue.processPendingContradictions({
      resolutionPolicy: this.resolutionPolicy,
      candidateFinder: this.candidateFinder
    });
  }

  async _updateContradictionTimestamp(redisClient, key, timestamp) {
    return this.pendingQueue.updateLastCheckAt(timestamp);
  }
}
