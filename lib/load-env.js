import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let projectEnvLoaded = false;

function normalizeLine(line) {
  return line.replace(/^\uFEFF/, "").trim();
}

function stripInlineComment(value) {
  let result = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const prev = i > 0 ? value[i - 1] : "";

    if (char === "'" && !inDouble && prev !== "\\") {
      inSingle = !inSingle;
    } else if (char === "\"" && !inSingle && prev !== "\\") {
      inDouble = !inDouble;
    } else if (char === "#" && !inSingle && !inDouble) {
      break;
    }

    result += char;
  }

  return result.trim();
}

function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      const inner = value.slice(1, -1);
      if (first === "\"") {
        return inner
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, "\"");
      }
      return inner;
    }
  }

  return stripInlineComment(value);
}

export function parseEnvText(source) {
  const parsed = {};

  for (const rawLine of source.split(/\r?\n/)) {
    const line = normalizeLine(rawLine);
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice("export ".length) : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = normalized.slice(0, separatorIndex).trim();
    const value = normalized.slice(separatorIndex + 1).trim();
    if (!key) continue;

    parsed[key] = unquote(value);
  }

  return parsed;
}

export function loadEnvFile(filePath, { env = process.env, fsImpl = fs } = {}) {
  if (!filePath || !fsImpl.existsSync(filePath)) return false;

  const parsed = parseEnvText(fsImpl.readFileSync(filePath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) {
      env[key] = value;
    }
  }

  return true;
}

export function getProjectEnvPaths({ cwd = process.cwd(), repoRoot = REPO_ROOT } = {}) {
  return [...new Set([
    path.resolve(cwd, ".env"),
    path.resolve(repoRoot, ".env")
  ])];
}

export function loadProjectEnv(options = {}) {
  if (projectEnvLoaded) return false;

  const { env = process.env, fsImpl = fs, cwd = process.cwd(), repoRoot = REPO_ROOT } = options;
  let loadedAny = false;

  for (const filePath of getProjectEnvPaths({ cwd, repoRoot })) {
    loadedAny = loadEnvFile(filePath, { env, fsImpl }) || loadedAny;
  }

  projectEnvLoaded = true;
  return loadedAny;
}

loadProjectEnv();
