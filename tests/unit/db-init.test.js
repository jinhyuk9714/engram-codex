import { describe, test } from "node:test";
import assert from "node:assert/strict";

describe("db init", () => {
  test("creates the vector extension and applies schema plus deterministic migrations in order", async () => {
    process.env.LOG_DIR = "tmp/test-logs";
    const { SQL_MIGRATION_FILES, runDbInit } = await import("../../lib/memory/db-init.js");
    const executedQueries = [];
    const readOrder = [];

    await runDbInit({
      embeddingDimensions: 1536,
      pool: {
        query: async (sql) => {
          executedQueries.push(sql);
        }
      },
      readSqlFile: async (fileUrl) => {
        readOrder.push(fileUrl.pathname.split("/").pop());
        return `-- ${fileUrl.pathname.split("/").pop()}`;
      },
      runFlexibleDimensionsMigration: async () => {
        throw new Error("flexible dimensions migration should not run");
      },
      log: { info: () => {}, warn: () => {} }
    });

    assert.match(executedQueries[0], /CREATE EXTENSION IF NOT EXISTS vector/i);
    assert.deepEqual(readOrder, [
      "memory-schema.sql",
      ...SQL_MIGRATION_FILES.map(fileUrl => fileUrl.pathname.split("/").pop())
    ]);
  });

  test("runs the flexible embedding-dimension migration only when dimensions exceed 2000", async () => {
    process.env.LOG_DIR = "tmp/test-logs";
    const { runDbInit } = await import("../../lib/memory/db-init.js");
    let flexibleRuns = 0;

    await runDbInit({
      embeddingDimensions: 3072,
      pool: {
        query: async () => {}
      },
      readSqlFile: async () => "SELECT 1;",
      runFlexibleDimensionsMigration: async () => {
        flexibleRuns += 1;
      },
      log: { info: () => {}, warn: () => {} }
    });

    assert.equal(flexibleRuns, 1);
  });
});
