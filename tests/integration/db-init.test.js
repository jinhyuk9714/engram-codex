import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

import { runDbInit } from "../../lib/memory/db-init.js";

const S = "agent_memory";
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

describe("db init bootstrap", () => {
  before(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
  });

  test("recreates the latest schema objects from a blank database", async () => {
    await runDbInit({
      embeddingDimensions: 1536,
      pool,
      log: { info: () => {}, warn: () => {} }
    });

    const { rows: columns } = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = 'fragments'
        AND column_name = ANY($2::text[])
    `, [S, ["valid_from", "valid_to", "last_decay_at", "key_id"]]);
    const columnNames = new Set(columns.map((row) => row.column_name));

    assert.deepEqual(
      [...columnNames].sort(),
      ["key_id", "last_decay_at", "valid_from", "valid_to"]
    );

    const { rows: objects } = await pool.query(`
      SELECT to_regclass($1) AS api_keys,
             to_regclass($2) AS api_key_usage,
             to_regclass($3) AS morpheme_dict
    `, [
      `${S}.api_keys`,
      `${S}.api_key_usage`,
      `${S}.morpheme_dict`
    ]);

    assert.ok(objects[0].api_keys);
    assert.ok(objects[0].api_key_usage);
    assert.ok(objects[0].morpheme_dict);
  });

  after(async () => {
    await pool.end();
  });
});
