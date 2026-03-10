import { queryWithAgentVector } from "../../../tools/db.js";
import { SCHEMA } from "../constants.js";

export class CandidateFinder {
  constructor({
    query = queryWithAgentVector,
    schema = SCHEMA
  } = {}) {
    this.query = query;
    this.schema = schema;
  }

  async listNewFragments(lastCheckAt = null) {
    let newFragmentsQuery = `
      SELECT id, content, topic, type, importance, embedding, created_at
      FROM ${this.schema}.fragments
      WHERE embedding IS NOT NULL`;

    const params = [];
    if (lastCheckAt) {
      params.push(lastCheckAt);
      newFragmentsQuery += " AND created_at > $1";
    }
    newFragmentsQuery += " ORDER BY created_at DESC LIMIT 20";

    const result = await this.query("system", newFragmentsQuery, params);
    return result.rows || [];
  }

  async listContradictionCandidates(fragment) {
    const result = await this.query(
      "system",
      `SELECT c.id, c.content, c.topic, c.type, c.importance,
              c.created_at, c.is_anchor,
              1 - (c.embedding <=> (SELECT embedding FROM ${this.schema}.fragments WHERE id = $1)) AS similarity
       FROM ${this.schema}.fragments c
       WHERE c.id != $1
         AND c.topic = $2
         AND c.embedding IS NOT NULL
         AND 1 - (c.embedding <=> (SELECT embedding FROM ${this.schema}.fragments WHERE id = $1)) > 0.85
         AND NOT EXISTS (
           SELECT 1 FROM ${this.schema}.fragment_links fl
           WHERE ((fl.from_id = $1 AND fl.to_id = c.id)
               OR (fl.from_id = c.id AND fl.to_id = $1))
             AND fl.relation_type = 'contradicts'
         )
       ORDER BY similarity DESC
       LIMIT 3`,
      [fragment.id, fragment.topic]
    );

    return result.rows || [];
  }

  async listSupersessionPairs() {
    const result = await this.query(
      "system",
      `SELECT a.id AS id_a, a.content AS content_a, a.created_at AS created_a,
              b.id AS id_b, b.content AS content_b, b.created_at AS created_b,
              1 - (a.embedding <=> b.embedding) AS similarity
       FROM ${this.schema}.fragments a
       JOIN ${this.schema}.fragments b ON a.topic = b.topic
                                      AND a.type = b.type
                                      AND a.id < b.id
       WHERE a.embedding IS NOT NULL AND b.embedding IS NOT NULL
         AND a.valid_to IS NULL AND b.valid_to IS NULL
         AND 1 - (a.embedding <=> b.embedding) BETWEEN 0.7 AND 0.85
         AND NOT EXISTS (
           SELECT 1 FROM ${this.schema}.fragment_links fl
           WHERE (fl.from_id = a.id AND fl.to_id = b.id)
              OR (fl.from_id = b.id AND fl.to_id = a.id)
         )
       ORDER BY similarity DESC
       LIMIT 10`,
      []
    );

    return result.rows || [];
  }

  async getFragmentById(id) {
    const result = await this.query(
      "system",
      `SELECT id, content, created_at, is_anchor
       FROM ${this.schema}.fragments
       WHERE id = $1`,
      [id]
    );

    return result.rows?.[0] || null;
  }
}
