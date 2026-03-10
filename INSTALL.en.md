# Installation Guide

## Quick Start (Docker Compose)

This is the primary local-trial path. The default stack is only `postgres + engram-codex`.

```bash
cp .env.example .env
# Edit .env and set ENGRAM_ACCESS_KEY plus your PostgreSQL credentials
docker compose up --build
```

Verify:

```bash
curl -i http://localhost:57332/health
curl -i http://localhost:57332/ready
curl -i http://localhost:57332/metrics
```

- `/health` is the liveness probe and should return `200`.
- `/ready` should return `200` only when PostgreSQL is reachable.
- With `REDIS_ENABLED=false`, Redis is reported as `disabled` and does not fail readiness.
- `.env` is auto-loaded; no `source .env` step is required.

Shutdown / cleanup:

```bash
docker compose down -v
```

## Codex app / CLI Configuration

Codex app and Codex CLI share MCP settings. First expose the access key in your shell.

```bash
export ENGRAM_ACCESS_KEY='YOUR_ENGRAM_ACCESS_KEY'
```

Then add the server to `~/.codex/config.toml`.

```toml
[mcp_servers.engram-codex]
url = "http://localhost:57332/mcp"
bearer_token_env_var = "ENGRAM_ACCESS_KEY"
```

## Breaking Change Notice

- `MEMENTO_ACCESS_KEY` and `memento-access-key` no longer work.
- Existing operators must update shell environment variables, Codex config, reverse-proxy header forwarding, and deployment scripts to `ENGRAM_ACCESS_KEY` and `engram-access-key`.
- If Redis is enabled, the embedding queue key is now `engram:embedding_queue`; previously queued items under `memento:embedding_queue` are not consumed automatically after the upgrade.

If you want the server enabled only for a trusted project, place the same entry in `.codex/config.toml` inside that repository instead of the user-level config.

---

## Manual Installation

### Interactive setup script

```bash
bash scripts/setup.sh

# Compatibility path
# bash setup.sh
```

The script walks through `.env` creation, `npm install`, and `npm run db:init`.

### Dependencies

```bash
npm install

# (Optional) If npm install fails on a CUDA 11 system due to onnxruntime-node GPU binding:
# npm install --onnxruntime-node-install-cuda=skip
```

**Note on ONNX Runtime and CUDA:** On systems with CUDA 11 installed, `npm install` may fail during `onnxruntime-node` post-install. Use `npm install --onnxruntime-node-install-cuda=skip` to force CPU-only mode. This project does not require GPU acceleration.

### PostgreSQL preparation

The manual path still requires PostgreSQL 14+ with `pgvector` installed on the DB server so `npm run db:init` can create the `vector` extension.

### DB bootstrap / upgrade

```bash
npm run db:init
```

`npm run db:init` performs:
- `CREATE EXTENSION IF NOT EXISTS vector`
- `memory-schema.sql`
- migrations `001` through `008`
- the flexible-dimensions JS migration only when `EMBEDDING_DIMENSIONS > 2000`

```bash
# One-time L2 normalization of existing embeddings (safe to re-run; idempotent)
node lib/memory/normalize-vectors.js

# Backfill embeddings for existing fragments (requires embedding API key, one-time)
npm run backfill:embeddings
```

### Environment variables

```bash
cp .env.example .env
# Edit .env: set DATABASE_URL, ENGRAM_ACCESS_KEY, and other required values
```

- `DATABASE_URL` is the canonical DSN for `npm run db:init` and maintenance scripts.
- Runtime keeps `POSTGRES_*` support for compatibility.
- `.env` is auto-loaded when present.

If you need an operational rollback from the in-process ONNX classifier, add `NLI_DISABLE_INPROCESS=true` to `.env`. This only applies when `NLI_SERVICE_URL` is unset; the normal default remains `false`.

### Starting the server

```bash
npm start
```

### Verifying the server

```bash
curl -i http://localhost:57332/health
curl -i http://localhost:57332/ready
curl -i http://localhost:57332/metrics
```

- `/health` is the liveness probe. It returns `200` as long as the process can serve requests.
- `/ready` is the readiness probe. It returns `200` only when PostgreSQL responds successfully.
- When `REDIS_ENABLED=false`, Redis is reported as `disabled` and does not fail readiness.
- `NLI_DISABLE_INPROCESS=true` can be used as a shutdown-stability fallback to skip in-process NLI preload and inference.

### Tests

```bash
npm test

# Only when PostgreSQL and DATABASE_URL are available
npm run test:db
```

`npm test` covers the local-safe suite. The temporal integration test is intentionally split into `npm run test:db` because it requires a live Postgres connection.

For external access, expose the service through a reverse proxy (TLS termination, rate limiting). Do not publish internal host addresses or port numbers in external documentation.

## Recommended Session Rules

The server's `instructions` field nudges Codex toward `context`, `recall`, and `reflect`, but repository-specific habits belong in `AGENTS.md`.

```markdown
## Memory Rules
- At the start of every conversation, call the `context` tool to load Core Memory and Working Memory.
- Before debugging or writing code, call `recall(keywords=[relevant_keywords], type="error")` to surface related past learnings.
- Save durable decisions with `remember`, and call `reflect` before major checkpoints or session shutdown.
```

`context` returns only high-importance fragments within your token budget, so it injects critical information without polluting the context window. Keeping these rules in `AGENTS.md` makes the behavior reusable across Codex app and CLI sessions.

## MCP Protocol Version Negotiation

| Version | Notable Additions |
|---------|------------------|
| `2025-11-25` | Latest negotiated revision; current `initialize` advertises tools, prompts, and resources |
| `2025-06-18` | Structured tool output, server-driven interaction |
| `2025-03-26` | OAuth 2.1, Streamable HTTP transport |
| `2024-11-05` | Initial release; Legacy SSE transport |

The server advertises all four versions. Clients negotiate the highest mutually supported version during `initialize`.
