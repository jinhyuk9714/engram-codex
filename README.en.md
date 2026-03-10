# Engram Codex

**Fragment-based memory MCP server for durable Codex workflows.**

Engram Codex is a long-term memory server for MCP (Model Context Protocol) agents. It is packaged for Codex app and CLI workflows so important facts, decisions, error patterns, preferences, and procedures can be stored as small fragments and restored in the next session.

**Quick links**

- [Installation Guide](INSTALL.en.md)
- [Korean README](README.md)
- [Third-Party Notices](THIRD_PARTY_NOTICES.md)
- [License](LICENSE)

> [!NOTE]
> This repository repackages an Apache-2.0-licensed upstream codebase for Codex-centered workflows. Source attribution and modification notes are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## Why Engram Codex

Saving entire chat summaries creates the same problems over and over:

- unrelated details come back with the useful ones
- old information collides with newer facts
- precise retrieval gets harder as history grows
- tokens and context window space get burned on noise

Engram Codex stores memory as **small atomic fragments**, usually one to three sentences each. At retrieval time, it assembles only the fragments that fit the question, which makes the system easier to search, rank, and maintain inside Codex workflows.

---

## Core concepts

### 1) Fragment-based memory

Memory is stored as small fragments instead of one large summary.

Fragment types:

- `fact`
- `decision`
- `error`
- `preference`
- `procedure`
- `relation`

### 2) Hybrid retrieval

Search runs from cheaper layers to more expensive ones.

1. **L1 Redis**: keyword Set intersections
2. **L2 PostgreSQL**: structured search with GIN indexes
3. **L3 pgvector**: semantic search for natural-language queries

When needed, results are merged with RRF (Reciprocal Rank Fusion) and ranked again with importance, time proximity, and similarity.

### 3) Temporal memory

Memory carries time semantics.

- `valid_from`
- `valid_to`
- `superseded_by`
- `asOf`

When a new fragment replaces an older one, the system can preserve history while still answering with the current state.

### 4) Automatic maintenance

Memory quality is managed continuously in the background.

- importance decay
- TTL tier transitions
- deduplication
- contradiction detection
- orphan link cleanup
- session reflection cleanup

### 5) Optional AI enhancements

Optional components improve semantic search and evaluation quality.

- Redis: L1 indexing, session activity tracking, cache and queue optimization
- Embedding provider: semantic retrieval and automatic linking
- Gemini CLI: quality scoring, contradiction escalation, better reflection
- NLI model: low-cost logical contradiction detection

---

## Architecture

<p align="center">
  <img src="assets/images/engram_architecture.svg" alt="Engram Codex Architecture" width="100%" />
</p>

### Write path

1. `remember` stores a fragment
2. `EmbeddingWorker` generates embeddings asynchronously
3. `GraphLinker` creates relationships between similar fragments
4. `MemoryEvaluator` scores utility
5. `MemoryConsolidator` performs long-term maintenance

### Read path

1. `recall` or `context` collects retrieval constraints
2. Redis L1, PostgreSQL L2, and pgvector L3 are queried in order
3. Results are merged and ranked
4. Output is trimmed to the token budget

---

## Key features

- **Atomic memory**: stores memory as 1 to 3 sentence fragments
- **Hybrid search**: combines structured retrieval with semantic retrieval
- **Temporal history**: supports point-in-time lookup and supersession chains
- **Auto-linking**: creates relationships between similar fragments automatically
- **Session reflection**: turns session activity into structured memory on close
- **Maintenance pipeline**: handles decay, TTL, dedupe, and contradiction detection
- **Isolation**: supports memory isolation with `agent_id` and `key_id`
- **Observability**: exposes `/health`, `/metrics`, and audit logs
- **Security**: applies PII masking, hashed API key storage, and RLS

---

## MCP tools

| Tool | Role |
| ---- | ---- |
| `remember` | Store a new fragment |
| `recall` | Search by keyword, topic, type, or natural language |
| `context` | Restore the most relevant memory at session start |
| `reflect` | Convert session activity into structured fragments |
| `amend` | Update an existing fragment while preserving history |
| `forget` | Delete by fragment or topic |
| `link` | Create explicit relationships between fragments |
| `graph_explore` | Walk causal or related-fragment chains |
| `fragment_history` | Inspect edit history and superseded chains |
| `tool_feedback` | Record quality feedback for tools |
| `memory_stats` | Inspect system-level memory statistics |
| `memory_consolidate` | Run the maintenance pipeline manually |

> Internal DB access utilities exist, but they are not exposed directly to MCP clients.

---

## MCP resources and prompts

### Resources

| URI | Description |
| --- | --- |
| `memory://stats` | Memory system statistics |
| `memory://topics` | Stored topic list |
| `memory://config` | Current memory configuration |
| `memory://active-session` | Current session activity log |

### Prompts

| Name | Description |
| ---- | ----------- |
| `analyze-session` | Helps extract session details worth storing |
| `retrieve-relevant-memory` | Helps find the most relevant memory efficiently |
| `onboarding` | Explains tool usage and operating principles |

---

## Quick start

### Requirements

- Docker + Docker Compose
- Codex app or Codex CLI

### Docker Compose quickstart

```bash
cp .env.example .env
# Edit .env and set ENGRAM_ACCESS_KEY plus your PostgreSQL credentials
docker compose up --build
```

Basic verification:

```bash
curl -i http://localhost:57332/health
curl -i http://localhost:57332/ready
```

- `/health`: liveness probe. Returns `200` as long as the process can serve requests.
- `/ready`: readiness probe. Returns `200` only when PostgreSQL is reachable.
- When `REDIS_ENABLED=false`, Redis is reported as `disabled` and does not make readiness fail.
- `.env` is loaded automatically at runtime; no `source .env` step is required.

Codex app / CLI config:

```toml
[mcp_servers.engram-codex]
url = "http://localhost:57332/mcp"
bearer_token_env_var = "ENGRAM_ACCESS_KEY"
```

Shutdown / cleanup:

```bash
docker compose down -v
```

For installation details, manual migrations, and Codex app/CLI setup, see **[INSTALL.en.md](INSTALL.en.md)**.

### Manual installation

```bash
npm install
cp .env.example .env
npm run db:init
npm start
```

`.env` is auto-loaded on the manual path as well. Your PostgreSQL server still needs `pgvector` installed, and `npm run db:init` is the canonical bootstrap command for the extension and latest schema.

To enable semantic retrieval and automatic linking, add an embedding provider:

```env
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

If you need an emergency rollback from the in-process ONNX classifier without standing up an external NLI service, use:

```env
NLI_DISABLE_INPROCESS=true
```

---

## Useful commands

```bash
npm start
npm run db:init
npm lint
npm test
npm run test:db
npm run backfill:embeddings
```

- `npm run db:init`: ensures the `vector` extension, base schema, migrations 001-008, and flexible-dims migration when needed
- `npm test`: unit tests plus safe local integration tests
- `npm run test:db`: integration tests that require a PostgreSQL connection
- `npm run backfill:embeddings`: bulk-generate embeddings for existing fragments

---

## Deployment profiles

### PostgreSQL only

- store, update, and delete fragments
- structured retrieval with GIN indexes
- use the full baseline MCP toolset

### PostgreSQL + Redis

- L1 keyword retrieval
- session activity tracking
- cache and queue-based optimizations

> Redis is optional. Disabling Redis does not disable the baseline MCP toolset or PostgreSQL-backed retrieval.

### PostgreSQL + Redis + embeddings

- pgvector semantic retrieval
- automatic fragment linking
- better natural-language recall quality

### PostgreSQL + Redis + embeddings + Gemini CLI

- asynchronous quality evaluation
- contradiction escalation
- stronger automatic reflection

---

## HTTP endpoints

| Method | Path | Description |
| ------ | ---- | ----------- |
| `POST` | `/mcp` | Streamable HTTP JSON-RPC request |
| `GET` | `/mcp` | Streamable HTTP SSE stream |
| `DELETE` | `/mcp` | Streamable HTTP session close |
| `GET` | `/sse` | Legacy SSE session creation |
| `POST` | `/message` | Legacy SSE JSON-RPC request |
| `GET` | `/health` | Liveness probe |
| `GET` | `/ready` | PostgreSQL readiness probe |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/.well-known/oauth-authorization-server` | OAuth 2.0 authorization server metadata |
| `GET` | `/.well-known/oauth-protected-resource` | OAuth 2.0 protected resource metadata |
| `GET` | `/authorize` | OAuth 2.0 authorization endpoint |
| `POST` | `/token` | OAuth 2.0 token endpoint |

Admin API key dashboard endpoints are available under `/v1/internal/model/nothing/*`.

- `/health` includes dependency details, but a disabled Redis instance is not treated as a failure.
- `/ready` reflects required dependency readiness, which currently means PostgreSQL.

---

## Project structure

```text
server.js                 HTTP server entry point
lib/jsonrpc.js            JSON-RPC parsing and method dispatch
lib/tool-registry.js      MCP tool registration and routing
lib/tools/                MCP tool implementations
lib/memory/               Core memory system logic
lib/admin/                API key management
lib/http/                 HTTP/SSE utilities
lib/logging/              Audit logs and access history
config/memory.js          Ranking, TTL, GC, and pagination settings
scripts/                  Setup and support scripts
docs/skills/              Agent skill documents
INSTALL.md                Korean installation guide
docs/                     Additional design documents
```

---

## Design principles

- **Store small**: prefer small fragments over long summaries
- **Retrieve precisely**: inject only the memory that matters
- **Respect time**: treat current and historical memory as separate concerns
- **Forget intentionally**: memory needs maintenance, not just storage
- **Keep optional things optional**: the baseline should still work without Redis, embeddings, or Gemini

---

## Compatibility and stack

- MCP Protocol: `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`
- Advertised MCP capabilities: `tools`, `prompts`, `resources`
- Transport: Streamable HTTP, Legacy SSE
- Auth: Bearer Token, OAuth 2.0 PKCE
- Runtime: Node.js 20+
- Storage: PostgreSQL 14+ (`pgvector`), Redis 6+ (optional)
- AI/ML: OpenAI Embeddings, Gemini CLI, Hugging Face Transformers (optional)

---

## Testing

```bash
npm test

# Only when PostgreSQL and a test DB connection are available
npm run test:db
```

---

## Closing note

Engram Codex is less a server that stores memory and more a system that keeps memory retrievable, time-aware, and maintainable. If you need a long-term memory layer for Codex app and CLI that can pull back the right fragments instead of replaying whole conversations, this repository is a solid starting point.

---

<p align="center">
  Made by <a href="https://github.com/jinhyuk9714">Jinho Choi</a> &nbsp;|&nbsp;
  <a href="https://buymeacoffee.com/jinho.von.choi">Buy me a coffee</a>
</p>
