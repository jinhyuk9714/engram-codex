import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCb);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");
const moduleUrl = pathToFileURL(
  path.join(ROOT_DIR, "lib/memory/NLIClassifier.js")
).href;
const nodeBin = fs.existsSync(process.execPath) ? process.execPath : "node";

async function importFreshNliModule(suffix) {
  return import(`${moduleUrl}?test=${suffix}`);
}

describe("NLI lifecycle", () => {
  test("shutdownNLI is safe when no in-process model was loaded", async () => {
    const mod = await importFreshNliModule(`empty-${Date.now()}`);

    assert.equal(typeof mod.shutdownNLI, "function");
    await mod.shutdownNLI();
  });

  test("shutdownNLI disposes the loaded model once and is idempotent", async () => {
    const mod = await importFreshNliModule(`idempotent-${Date.now()}`);
    let disposeCalls = 0;

    assert.equal(typeof mod.__setNLIStateForTests, "function");
    mod.__setNLIStateForTests({
      mode: "inprocess",
      tokenizer: {},
      model: {
        async dispose() {
          disposeCalls++;
        }
      },
      id2label: { 0: "entailment" },
      failed: false,
      loading: null
    });

    await mod.shutdownNLI();
    await mod.shutdownNLI();

    assert.equal(disposeCalls, 1);
  });

  test("shutdownNLI waits for in-flight preload before disposing", async () => {
    const mod = await importFreshNliModule(`loading-${Date.now()}`);
    let resolveLoad;
    let disposeCalls = 0;
    let settled = false;

    const loading = new Promise((resolve) => {
      resolveLoad = resolve;
    });

    mod.__setNLIStateForTests({
      mode: "inprocess",
      loading,
      failed: false
    });

    const shutdownPromise = mod.shutdownNLI().then(() => {
      settled = true;
    });

    await Promise.resolve();
    assert.equal(settled, false);

    mod.__setNLIStateForTests({
      tokenizer: {},
      model: {
        async dispose() {
          disposeCalls++;
        }
      },
      id2label: { 0: "entailment" }
    });
    resolveLoad();

    await shutdownPromise;
    assert.equal(disposeCalls, 1);
  });

  test("NLI_DISABLE_INPROCESS=true disables in-process NLI without an external service", async () => {
    const script = `
      const mod = await import(${JSON.stringify(moduleUrl)} + '?env=' + Date.now());
      await mod.preloadNLI();
      const result = {
        available: mod.isNLIAvailable(),
        classified: await mod.classifyNLI('premise', 'hypothesis')
      };
      console.log(JSON.stringify(result));
    `;

    const { stdout } = await execFile(nodeBin, ["--input-type=module", "-e", script], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        LOG_DIR: "tmp/test-logs",
        NLI_SERVICE_URL: "",
        NLI_DISABLE_INPROCESS: "true"
      }
    });

    const payload = JSON.parse(stdout.trim().split("\n").pop());
    assert.equal(payload.available, false);
    assert.equal(payload.classified, null);
    assert.doesNotMatch(stdout, /Loading model:/);
  });
});
