import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { MEMORY_CONFIG } from "../../config/memory.js";

const execFile = promisify(execFileCb);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");
const CONFIG_MODULE_URL = pathToFileURL(path.join(ROOT_DIR, "lib/config.js")).href;
const AUTH_MODULE_URL = pathToFileURL(path.join(ROOT_DIR, "lib/auth.js")).href;
const nodeBin = fs.existsSync(process.execPath) ? process.execPath : "node";

async function runJsonScript(source, env = {}) {
  const { stdout } = await execFile(nodeBin, ["--input-type=module", "-e", source], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      LOG_DIR: "tmp/test-logs",
      ...env
    }
  });

  return JSON.parse(stdout.trim().split("\n").pop());
}

describe("Engram breaking rename", () => {
  test("config reads ENGRAM_ACCESS_KEY and ignores the legacy MEMENTO_ACCESS_KEY", async () => {
    const payload = await runJsonScript(`
      const mod = await import(${JSON.stringify(CONFIG_MODULE_URL)} + '?config=' + Date.now());
      console.log(JSON.stringify({ accessKey: mod.ACCESS_KEY }));
    `, {
      ENGRAM_ACCESS_KEY: "engram-key",
      MEMENTO_ACCESS_KEY: "legacy-key"
    });

    assert.equal(payload.accessKey, "engram-key");
  });

  test("config does not fall back to MEMENTO_ACCESS_KEY when ENGRAM_ACCESS_KEY is unset", async () => {
    const payload = await runJsonScript(`
      const mod = await import(${JSON.stringify(CONFIG_MODULE_URL)} + '?legacy=' + Date.now());
      console.log(JSON.stringify({ accessKey: mod.ACCESS_KEY }));
    `, {
      ENGRAM_ACCESS_KEY: "",
      MEMENTO_ACCESS_KEY: "legacy-key"
    });

    assert.equal(payload.accessKey, "");
  });

  test("validateAuthentication accepts engram-access-key and rejects the legacy memento-access-key", async () => {
    const payload = await runJsonScript(`
      const mod = await import(${JSON.stringify(AUTH_MODULE_URL)} + '?auth=' + Date.now());
      const accepted = await mod.validateAuthentication({
        headers: { 'engram-access-key': 'engram-key' }
      }, null);
      const rejected = await mod.validateAuthentication({
        headers: { 'memento-access-key': 'engram-key' }
      }, null);
      console.log(JSON.stringify({ accepted, rejected }));
    `, {
      ENGRAM_ACCESS_KEY: "engram-key",
      MEMENTO_ACCESS_KEY: ""
    });

    assert.equal(payload.accepted.valid, true);
    assert.equal(payload.rejected.valid, false);
  });

  test("embedding worker queue key uses the engram namespace", () => {
    assert.equal(MEMORY_CONFIG.embeddingWorker.queueKey, "engram:embedding_queue");
  });

  test("runtime SQL helpers no longer reference the legacy nerdvana search path", () => {
    for (const relativePath of [
      "lib/tools/db.js",
      "lib/memory/FragmentStore.js",
      "lib/memory/normalize-vectors.js"
    ]) {
      const source = fs.readFileSync(path.join(ROOT_DIR, relativePath), "utf8");
      assert.doesNotMatch(source, /nerdvana/, `${relativePath} should not reference nerdvana`);
    }
  });
});
