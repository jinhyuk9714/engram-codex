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

const DISALLOWED_PATTERNS = [
  /\bMemento\b/g,
  /nerdvana\.kr/g,
  /pmcp\.nerdvana\.kr/g,
  /Tasks abstraction/g,
  /long-running operation support/g
];

describe("protocol surface alignment docs", () => {
  test("user-facing docs do not advertise legacy branding or unsupported task features", () => {
    for (const relativePath of DOC_PATHS) {
      const fullPath = path.join(ROOT_DIR, relativePath);
      const source = fs.readFileSync(fullPath, "utf8");

      for (const pattern of DISALLOWED_PATTERNS) {
        assert.doesNotMatch(
          source,
          pattern,
          `${relativePath} should not contain ${pattern}`
        );
      }
    }
  });
});
