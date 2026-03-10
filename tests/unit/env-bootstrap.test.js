import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadEnvFile } from "../../lib/load-env.js";

describe("env bootstrap", () => {
  test("loads missing values from a .env file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "engram-env-"));
    const envPath = path.join(tempDir, ".env");
    fs.writeFileSync(envPath, "PORT=57332\nMEMENTO_ACCESS_KEY=test-key\n", "utf8");

    const env = {};
    const loaded = loadEnvFile(envPath, { env });

    assert.equal(loaded, true);
    assert.equal(env.PORT, "57332");
    assert.equal(env.MEMENTO_ACCESS_KEY, "test-key");
  });

  test("does not override existing shell environment values", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "engram-env-"));
    const envPath = path.join(tempDir, ".env");
    fs.writeFileSync(envPath, "PORT=57332\nMEMENTO_ACCESS_KEY=file-key\n", "utf8");

    const env = {
      PORT: "60000",
      MEMENTO_ACCESS_KEY: "shell-key"
    };

    loadEnvFile(envPath, { env });

    assert.equal(env.PORT, "60000");
    assert.equal(env.MEMENTO_ACCESS_KEY, "shell-key");
  });
});
