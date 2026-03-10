import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ContradictionStage } from "../../lib/memory/consolidator/ContradictionStage.js";
import { CandidateFinder } from "../../lib/memory/consolidator/contradiction/CandidateFinder.js";
import { PendingQueue } from "../../lib/memory/consolidator/contradiction/PendingQueue.js";
import { ResolutionPolicy } from "../../lib/memory/consolidator/contradiction/ResolutionPolicy.js";

describe("CandidateFinder", () => {
  test("uses the existing contradiction and supersession query thresholds", async () => {
    const calls = [];
    const finder = new CandidateFinder({
      schema: "agent_memory",
      query: async (...args) => {
        calls.push(args);
        return { rows: [] };
      }
    });

    await finder.listNewFragments("2026-01-01T00:00:00Z");
    await finder.listContradictionCandidates({ id: "frag-1", topic: "auth" });
    await finder.listSupersessionPairs();

    assert.match(calls[0][1], /created_at > \$1/);
    assert.match(calls[0][1], /LIMIT 20/);
    assert.match(calls[1][1], /> 0\.85/);
    assert.match(calls[1][1], /LIMIT 3/);
    assert.match(calls[2][1], /BETWEEN 0\.7 AND 0\.85/);
    assert.match(calls[2][1], /LIMIT 10/);
  });
});

describe("ResolutionPolicy", () => {
  test("updates valid_to and halves the older fragment importance when the newer fragment wins", async () => {
    const queryCalls = [];
    const linkCalls = [];
    const policy = new ResolutionPolicy({
      schema: "agent_memory",
      query: async (...args) => {
        queryCalls.push(args);
        return { rowCount: 1 };
      },
      store: {
        async createLink(...args) {
          linkCalls.push(args);
        }
      },
      logInfoFn: () => {},
      logWarnFn: () => {}
    });

    await policy.resolveContradiction(
      { id: "newer", created_at: "2026-03-01T00:00:00Z" },
      { id: "older", created_at: "2026-02-01T00:00:00Z", is_anchor: false },
      "reason"
    );

    assert.deepStrictEqual(linkCalls, [
      ["newer", "older", "contradicts", "system"],
      ["older", "newer", "superseded_by", "system"]
    ]);
    assert.equal(queryCalls.length, 2);
    assert.match(queryCalls[0][1], /importance = importance \* 0\.5/);
    assert.deepStrictEqual(queryCalls[0][2], ["older"]);
    assert.match(queryCalls[1][1], /valid_to = NOW\(\)/);
    assert.deepStrictEqual(queryCalls[1][2], ["older"]);
  });

  test("skips importance decay for anchor fragments", async () => {
    const queryCalls = [];
    const policy = new ResolutionPolicy({
      schema: "agent_memory",
      query: async (...args) => {
        queryCalls.push(args);
        return { rowCount: 1 };
      },
      store: {
        async createLink() {}
      },
      logInfoFn: () => {},
      logWarnFn: () => {}
    });

    await policy.resolveContradiction(
      { id: "newer", created_at: "2026-03-01T00:00:00Z" },
      { id: "anchor", created_at: "2026-02-01T00:00:00Z", is_anchor: true },
      "reason"
    );

    assert.equal(queryCalls.length, 1);
    assert.match(queryCalls[0][1], /valid_to = NOW\(\)/);
  });
});

describe("PendingQueue", () => {
  test("is a no-op when Redis is unavailable", async () => {
    const pendingQueue = new PendingQueue({
      getRedisClient: async () => ({ status: "end" }),
      logWarnFn: () => {},
      logInfoFn: () => {},
      logDebugFn: () => {}
    });

    assert.equal(await pendingQueue.getLastCheckAt(), null);
    assert.equal(await pendingQueue.processPendingContradictions({}), 0);
  });

  test("requeues failed pending entries and stops replay", async () => {
    const calls = [];
    let popped = false;
    const redisClient = {
      status: "ready",
      async lpop() {
        if (popped) return null;
        popped = true;
        return JSON.stringify({
          idA: "frag-a",
          idB: "frag-b",
          contentA: "A",
          contentB: "B"
        });
      },
      async rpush(key, value) {
        calls.push(["rpush", key, value]);
      }
    };
    const pendingQueue = new PendingQueue({
      getRedisClient: async () => redisClient,
      logWarnFn: () => {},
      logInfoFn: () => {},
      logDebugFn: () => {}
    });

    const processed = await pendingQueue.processPendingContradictions({
      isGeminiAvailable: async () => true,
      askGeminiContradiction: async () => {
        throw new Error("boom");
      },
      getFragmentById: async () => null,
      resolveContradiction: async () => {}
    });

    assert.equal(processed, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "rpush");
    assert.equal(calls[0][1], "frag:pending_contradictions");
  });
});

describe("ContradictionStage collaborator orchestration", () => {
  test("preserves the existing flat result shape while delegating pending replay to the queue collaborator", async () => {
    const stage = new ContradictionStage({
      candidateFinder: {
        async listNewFragments() {
          return [];
        },
        async listSupersessionPairs() {
          return [];
        }
      },
      pendingQueue: {
        async getLastCheckAt() {
          return null;
        },
        async updateLastCheckAt() {},
        async flagPotentialContradiction() {},
        async processPendingContradictions() {
          return 5;
        }
      },
      resolutionPolicy: {
        async askGeminiContradiction() {
          return { contradicts: false, reasoning: "none" };
        },
        async askGeminiSupersession() {
          return { supersedes: false, reasoning: "none" };
        },
        async resolveContradiction() {},
        async resolveSupersession() {}
      },
      isNliAvailable: () => false,
      isGeminiAvailable: async () => false,
      logInfoFn: () => {},
      logWarnFn: () => {},
      logDebugFn: () => {}
    });

    const result = await stage.run();

    assert.deepStrictEqual(result, {
      contradictionsFound: 0,
      nliResolvedDirectly: 0,
      nliSkippedAsNonContra: 0,
      supersessionsDetected: 0,
      pendingContradictions: 5
    });
  });
});
