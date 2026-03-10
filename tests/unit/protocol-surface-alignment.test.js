import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");

const DOC_PATHS = [
  "README.md",
  "README.en.md",
  "README.simple.md",
  "INSTALL.md",
  "INSTALL.en.md"
];

const CODE_TEXT_PATHS = [
  "lib/auth.js",
  "lib/gemini.js",
  "lib/memory/NLIClassifier.js",
  "lib/memory/normalize-vectors.js",
  "lib/memory/memory-schema.sql",
  "tests/unit/http-server.test.js"
];

const DOC_DISALLOWED_PATTERNS = [
  /\bMemento\b/g,
  /nerdvana\.kr/g,
  /pmcp\.nerdvana\.kr/g,
  /Tasks abstraction/g,
  /long-running operation support/g
];

const CODE_DISALLOWED_PATTERNS = [
  /\bMemento\b/g,
  /\bnerdvana MCP\b/g,
  /\bnerdvana-nli-service\b/g,
  /psql -U nerdvana -d nerdvana_mcp/g,
  /legacy nerdvana\.vector cast should be removed/g,
  /OAuth metadata fallback does not expose a legacy nerdvana host when Host is missing/g
];

describe("protocol surface alignment docs", () => {
  test("user-facing docs do not advertise legacy branding or unsupported task features", () => {
    for (const relativePath of DOC_PATHS) {
      const fullPath = path.join(ROOT_DIR, relativePath);
      const source = fs.readFileSync(fullPath, "utf8");

      for (const pattern of DOC_DISALLOWED_PATTERNS) {
        assert.doesNotMatch(
          source,
          pattern,
          `${relativePath} should not contain ${pattern}`
        );
      }
    }
  });

  test("internal comments and test descriptions avoid legacy branding outside compatibility exceptions", () => {
    for (const relativePath of CODE_TEXT_PATHS) {
      const fullPath = path.join(ROOT_DIR, relativePath);
      const source = fs.readFileSync(fullPath, "utf8");

      for (const pattern of CODE_DISALLOWED_PATTERNS) {
        assert.doesNotMatch(
          source,
          pattern,
          `${relativePath} should not contain ${pattern}`
        );
      }
    }
  });
});
