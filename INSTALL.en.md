# Installation Guide

## Quick Start (Interactive Setup Script)

```bash
bash setup.sh
```

Guides you through `.env` creation, `npm install`, and DB schema setup step by step.
The script now performs preflight checks for Node.js, `npm`, and `python3`, and warns early if `psql` is unavailable.

---

## Manual Installation

## Dependencies

```bash
npm install

# (Optional) If npm install fails on a CUDA 11 system due to onnxruntime-node GPU binding:
# npm install --onnxruntime-node-install-cuda=skip
```

**Note on ONNX Runtime and CUDA:** On systems with CUDA 11 installed, `npm install` may fail during `onnxruntime-node` post-install. Use `npm install --onnxruntime-node-install-cuda=skip` to force CPU-only mode. This project does not require GPU acceleration.

## PostgreSQL Schema

The `pgvector` extension must be installed prior to schema initialization:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Verify with `\dx` in psql. The HNSW index requires pgvector 0.5.0 or later.

**Fresh install:** apply the base schema snapshot, then run the full deterministic migration sequence so a new database matches the latest runtime expectations.

```bash
psql -U $POSTGRES_USER -d $POSTGRES_DB -f lib/memory/memory-schema.sql
psql $DATABASE_URL -f lib/memory/migration-001-temporal.sql
psql $DATABASE_URL -f lib/memory/migration-002-decay.sql
psql $DATABASE_URL -f lib/memory/migration-003-api-keys.sql
psql $DATABASE_URL -f lib/memory/migration-004-key-isolation.sql
psql $DATABASE_URL -f lib/memory/migration-005-gc-columns.sql
psql $DATABASE_URL -f lib/memory/migration-006-superseded-by-constraint.sql
psql $DATABASE_URL -f lib/memory/migration-007-link-weight.sql
psql $DATABASE_URL -f lib/memory/migration-008-morpheme-dict.sql
```

## Upgrade (Existing Installation)

Run the migration sequence only:

```bash
# Temporal schema: adds valid_from, valid_to, superseded_by columns and indexes
psql $DATABASE_URL -f lib/memory/migration-001-temporal.sql

# Decay idempotency: adds last_decay_at column
psql $DATABASE_URL -f lib/memory/migration-002-decay.sql

# API key management: creates api_keys and api_key_usage tables
psql $DATABASE_URL -f lib/memory/migration-003-api-keys.sql

# API key isolation: adds key_id column to fragments
psql $DATABASE_URL -f lib/memory/migration-004-key-isolation.sql

# GC policy reinforcement: adds auxiliary indexes on utility_score and access_count
psql $DATABASE_URL -f lib/memory/migration-005-gc-columns.sql

# fragment_links constraint: adds superseded_by to relation_type CHECK
psql $DATABASE_URL -f lib/memory/migration-006-superseded-by-constraint.sql

# link metadata: adds link weight support
psql $DATABASE_URL -f lib/memory/migration-007-link-weight.sql

# morpheme dictionary: adds fallback dictionary tables
psql $DATABASE_URL -f lib/memory/migration-008-morpheme-dict.sql
```

> **Upgrading from v1.1.0 or earlier**: If migration-006 is not applied, any operation that creates a `superseded_by` link — `amend`, `memory_consolidate`, and automatic relationship generation in GraphLinker — will fail with a DB constraint error. This migration is mandatory when upgrading an existing database.

```bash
# For models with >2000 dimensions (e.g., Gemini gemini-embedding-001 at 3072 dims) only:
# EMBEDDING_DIMENSIONS=3072 DATABASE_URL=$DATABASE_URL \
#   node lib/memory/migration-007-flexible-embedding-dims.js

# One-time L2 normalization of existing embeddings (safe to re-run; idempotent)
DATABASE_URL=$DATABASE_URL node lib/memory/normalize-vectors.js

# Backfill embeddings for existing fragments (requires embedding API key, one-time)
npm run backfill:embeddings
```

## Environment Variables

```bash
cp .env.example .env
# Edit .env: set DATABASE_URL, MEMENTO_ACCESS_KEY, and other required values
```

For the full list of environment variables, see [README.en.md — Configuration](README.en.md#10-configuration).

If you need an operational rollback from the in-process ONNX classifier, add `NLI_DISABLE_INPROCESS=true` to `.env`. This only applies when `NLI_SERVICE_URL` is unset; the normal default remains `false`.

## Starting the Server

```bash
node server.js
```

## Verifying the Server

```bash
curl -i http://localhost:57332/health
curl -i http://localhost:57332/ready
curl -i http://localhost:57332/metrics
```

- `/health` is the liveness probe. It returns `200` as long as the process can serve requests.
- `/ready` is the readiness probe. It returns `200` only when PostgreSQL responds successfully.
- When `REDIS_ENABLED=false`, Redis is reported as `disabled` and does not fail readiness.
- `NLI_DISABLE_INPROCESS=true` can be used as a shutdown-stability fallback to skip in-process NLI preload and inference.

## Tests

```bash
npm test

# Only when PostgreSQL and DATABASE_URL are available
npm run test:db
```

`npm test` covers the local-safe suite. The temporal integration test is intentionally split into `npm run test:db` because it requires a live Postgres connection.

On startup, the server logs the listening port, authentication status, session TTL, confirms `MemoryEvaluator` worker initialization, and begins NLI model preloading in the background (~30s on first download, ~1-2s from cache). Graceful shutdown on `SIGTERM` / `SIGINT` triggers `AutoReflect` for all active sessions, stops `MemoryEvaluator`, drains the PostgreSQL connection pool, and flushes access statistics.

## Codex app / CLI Configuration

Codex app and Codex CLI share MCP settings. First expose the access key in your shell.

```bash
export MEMENTO_ACCESS_KEY='YOUR_MEMENTO_ACCESS_KEY'
```

Then add the server to `~/.codex/config.toml`.

```toml
[mcp_servers.engram-codex]
url = "http://localhost:57332/mcp"
bearer_token_env_var = "MEMENTO_ACCESS_KEY"
```

If you want the server enabled only for a trusted project, place the same entry in `.codex/config.toml` inside that repository instead of the user-level config.

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
| `2025-11-25` | Tasks abstraction, long-running operation support |
| `2025-06-18` | Structured tool output, server-driven interaction |
| `2025-03-26` | OAuth 2.1, Streamable HTTP transport |
| `2024-11-05` | Initial release; Legacy SSE transport |

The server advertises all four versions. Clients negotiate the highest mutually supported version during `initialize`.
