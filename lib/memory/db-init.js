#!/usr/bin/env node

import "../load-env.js";

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { EMBEDDING_DIMENSIONS } from "../config.js";
import { getPrimaryPool, shutdownPool } from "../tools/db.js";
import { runFlexibleEmbeddingDimsMigration } from "./migration-007-flexible-embedding-dims.js";

export const SQL_SCHEMA_FILE = new URL("./memory-schema.sql", import.meta.url);
export const SQL_MIGRATION_FILES = [
  new URL("./migration-001-temporal.sql", import.meta.url),
  new URL("./migration-002-decay.sql", import.meta.url),
  new URL("./migration-003-api-keys.sql", import.meta.url),
  new URL("./migration-004-key-isolation.sql", import.meta.url),
  new URL("./migration-005-gc-columns.sql", import.meta.url),
  new URL("./migration-006-superseded-by-constraint.sql", import.meta.url),
  new URL("./migration-007-link-weight.sql", import.meta.url),
  new URL("./migration-008-morpheme-dict.sql", import.meta.url)
];

async function defaultReadSqlFile(fileUrl) {
  return readFile(fileUrl, "utf8");
}

function logInfo(log, message) {
  if (typeof log?.info === "function") {
    log.info(message);
    return;
  }
  if (typeof log?.log === "function") {
    log.log(message);
  }
}

export async function runDbInit({
  embeddingDimensions = EMBEDDING_DIMENSIONS,
  pool = getPrimaryPool(),
  readSqlFile = defaultReadSqlFile,
  runFlexibleDimensionsMigration = ({ pool: targetPool, embeddingDimensions: dims, log }) =>
    runFlexibleEmbeddingDimsMigration({ pool: targetPool, embeddingDimensions: dims, log }),
  log = console
} = {}) {
  logInfo(log, "[db:init] Ensuring pgvector extension is installed");
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");

  for (const fileUrl of [SQL_SCHEMA_FILE, ...SQL_MIGRATION_FILES]) {
    logInfo(log, `[db:init] Applying ${fileUrl.pathname.split("/").pop()}`);
    const sql = await readSqlFile(fileUrl);
    await pool.query(sql);
  }

  if (embeddingDimensions > 2000) {
    logInfo(log, `[db:init] Applying flexible embedding-dimension migration (${embeddingDimensions})`);
    await runFlexibleDimensionsMigration({
      pool,
      embeddingDimensions,
      log
    });
  }
}

async function main() {
  try {
    await runDbInit();
  } finally {
    await shutdownPool();
  }
}

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
