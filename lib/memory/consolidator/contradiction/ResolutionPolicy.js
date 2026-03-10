import { queryWithAgentVector } from "../../../tools/db.js";
import { geminiCLIJson, isGeminiCLIAvailable } from "../../../gemini.js";
import { logInfo, logWarn } from "../../../logger.js";
import { detectContradiction as nliDetect, isNLIAvailable } from "../../NLIClassifier.js";
import { SCHEMA } from "../constants.js";

export class ResolutionPolicy {
  constructor({
    store,
    query = queryWithAgentVector,
    geminiJson = geminiCLIJson,
    isGeminiAvailable = isGeminiCLIAvailable,
    detectNli = nliDetect,
    isNliAvailable = isNLIAvailable,
    logInfoFn = logInfo,
    logWarnFn = logWarn,
    schema = SCHEMA
  } = {}) {
    this.store = store;
    this.query = query;
    this.geminiJson = geminiJson;
    this.isGeminiAvailable = isGeminiAvailable;
    this.detectNli = detectNli;
    this.isNliAvailable = isNliAvailable;
    this.logInfo = logInfoFn;
    this.logWarn = logWarnFn;
    this.schema = schema;
  }

  async reviewContradiction(newFragment, candidate, { nliAvailable, geminiAvailable, pendingQueue }) {
    if (nliAvailable) {
      const nliResult = await this.detectNli(newFragment.content, candidate.content);

      if (nliResult) {
        if (nliResult.contradicts && !nliResult.needsEscalation) {
          await this.resolveContradiction(
            newFragment,
            candidate,
            `NLI contradiction (conf=${nliResult.confidence.toFixed(3)})`
          );
          return { found: 1, nliResolved: 1, nliSkipped: 0, markProcessed: true };
        }

        if (!nliResult.contradicts && !nliResult.needsEscalation) {
          return { found: 0, nliResolved: 0, nliSkipped: 1, markProcessed: true };
        }
      }
    }

    if (!geminiAvailable) {
      if (parseFloat(candidate.similarity) > 0.92) {
        await pendingQueue.flagPotentialContradiction(newFragment, candidate);
      }
      return { found: 0, nliResolved: 0, nliSkipped: 0, markProcessed: false };
    }

    try {
      const verdict = await this.askGeminiContradiction(newFragment.content, candidate.content);
      if (verdict.contradicts) {
        await this.resolveContradiction(newFragment, candidate, verdict.reasoning);
        return { found: 1, nliResolved: 0, nliSkipped: 0, markProcessed: true };
      }

      return { found: 0, nliResolved: 0, nliSkipped: 0, markProcessed: true };
    } catch (err) {
      this.logWarn(`[MemoryConsolidator] Gemini contradiction check failed: ${err.message}`);
      return { found: 0, nliResolved: 0, nliSkipped: 0, markProcessed: false };
    }
  }

  async reviewSupersession(pair, { geminiAvailable }) {
    if (!geminiAvailable) return false;

    try {
      const verdict = await this.askGeminiSupersession(pair.content_a, pair.content_b);
      if (!verdict.supersedes) return false;

      const older = new Date(pair.created_a) < new Date(pair.created_b)
        ? { id: pair.id_a, content: pair.content_a, created_at: pair.created_a }
        : { id: pair.id_b, content: pair.content_b, created_at: pair.created_b };
      const newer = older.id === pair.id_a
        ? { id: pair.id_b, content: pair.content_b, created_at: pair.created_b }
        : { id: pair.id_a, content: pair.content_a, created_at: pair.created_a };

      await this.resolveSupersession(older, newer, verdict.reasoning);
      return true;
    } catch (err) {
      this.logWarn(`[MemoryConsolidator] Supersession check failed: ${err.message}`);
      return false;
    }
  }

  async resolveContradiction(newFragment, candidate, reasoning) {
    await this.store.createLink(newFragment.id, candidate.id, "contradicts", "system");

    const newDate = new Date(newFragment.created_at);
    const oldDate = new Date(candidate.created_at);

    if (newDate > oldDate) {
      if (!candidate.is_anchor) {
        await this.query(
          "system",
          `UPDATE ${this.schema}.fragments SET importance = importance * 0.5 WHERE id = $1`,
          [candidate.id],
          "write"
        );
      }
      await this.store.createLink(candidate.id, newFragment.id, "superseded_by", "system");
      await this.query(
        "system",
        `UPDATE ${this.schema}.fragments SET valid_to = NOW()
         WHERE id = $1 AND valid_to IS NULL`,
        [candidate.id],
        "write"
      );
    } else {
      await this.query(
        "system",
        `UPDATE ${this.schema}.fragments SET importance = importance * 0.5 WHERE id = $1`,
        [newFragment.id],
        "write"
      );
      await this.store.createLink(newFragment.id, candidate.id, "superseded_by", "system");
      await this.query(
        "system",
        `UPDATE ${this.schema}.fragments SET valid_to = NOW()
         WHERE id = $1 AND valid_to IS NULL`,
        [newFragment.id],
        "write"
      );
    }

    this.logInfo(`[MemoryConsolidator] Contradiction resolved: ${newFragment.id} <-> ${candidate.id}: ${reasoning}`);
  }

  async resolveSupersession(older, newer, reasoning) {
    await this.store.createLink(older.id, newer.id, "superseded_by", "system");
    await this.query(
      "system",
      `UPDATE ${this.schema}.fragments
       SET valid_to = NOW(), importance = GREATEST(0.05, importance * 0.5)
       WHERE id = $1 AND valid_to IS NULL`,
      [older.id],
      "write"
    );

    this.logInfo(`[MemoryConsolidator] Supersession: ${older.id} -> ${newer.id}: ${reasoning}`);
  }

  async askGeminiSupersession(contentA, contentB) {
    const prompt = `두 개의 지식 파편이 "대체 관계"인지 판단하라.

파편 A: "${contentA}"
파편 B: "${contentB}"

대체 관계란: 동일 주제에 대해 한쪽이 다른 쪽의 정보를 갱신·교체·전환한 경우.
예: "cron으로 스케줄링" -> "Airflow로 전환" = 대체 관계
예: "Redis 캐시 사용" + "Redis 포트 6379" = 보완 관계 (대체 아님)

반드시 다음 JSON 형식으로만 응답하라:
{"supersedes": true 또는 false, "reasoning": "판단 근거 1문장"}`;

    try {
      return await this.geminiJson(prompt, { timeoutMs: 30_000 });
    } catch (err) {
      this.logWarn(`[MemoryConsolidator] Gemini supersession parse failed: ${err.message}`);
      return { supersedes: false, reasoning: "Gemini CLI 응답 파싱 실패" };
    }
  }

  async askGeminiContradiction(contentA, contentB) {
    const prompt = `두 개의 지식 파편이 서로 모순되는지 판단하라.

파편 A: "${contentA}"
파편 B: "${contentB}"

모순이란: 동일 주제에 대해 서로 양립 불가능한 주장을 하는 경우.
유사하지만 보완적인 정보는 모순이 아니다.
시간 경과에 의한 정보 갱신도 모순으로 판단한다 (구 정보 vs 신 정보).

반드시 다음 JSON 형식으로만 응답하라:
{"contradicts": true 또는 false, "reasoning": "판단 근거 1문장"}`;

    try {
      return await this.geminiJson(prompt, { timeoutMs: 30_000 });
    } catch (err) {
      this.logWarn(`[MemoryConsolidator] Gemini CLI parse failed: ${err.message}`);
      return { contradicts: false, reasoning: "Gemini CLI 응답 파싱 실패" };
    }
  }
}
