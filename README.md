# engram-codex

`engram-codex`는 Codex app/CLI 워크플로를 위해 재구성한 **fragment-based memory MCP server**입니다. Codex 세션에서 반복되는 사실, 결정, 에러 패턴, 선호, 절차를 작은 기억 파편으로 저장하고, 다음 작업에서 필요한 기억만 다시 꺼내 쓰는 장기 컨텍스트 계층을 제공합니다.

> 이 저장소는 Apache-2.0 기반 코드베이스를 Codex 중심 워크플로에 맞게 재구성한 파생 저장소입니다. 출처와 변경 고지는 `THIRD_PARTY_NOTICES.md`에 정리되어 있습니다.

## 문제의식

Codex 작업은 여러 세션에 걸쳐 이어지는 경우가 많습니다. 긴 대화 요약을 통째로 저장하면 토큰을 많이 쓰고, 오래된 정보가 최신 결정을 덮거나, 관련 없는 맥락이 함께 주입될 수 있습니다. Engram Codex는 기억을 1~3문장 단위의 파편으로 나누고, 시간 정보와 검색 계층을 붙여 필요한 조각만 반환하도록 설계했습니다.

## 핵심 개념

- **Fragment-based memory**: `fact`, `decision`, `error`, `preference`, `procedure`, `relation` 유형의 작은 파편을 저장합니다.
- **Hybrid retrieval**: Redis L1, PostgreSQL GIN L2, pgvector L3 검색 결과를 조합합니다.
- **Temporal memory**: `valid_from`, `valid_to`, `superseded_by`, `asOf`로 변경 이력을 보존합니다.
- **Automatic maintenance**: decay, TTL 이동, 중복 병합, 모순 탐지, 고아 링크 정리, 세션 reflect 정리를 수행합니다.
- **Codex-first operations**: Docker Compose quickstart, `.env` 자동 로드, `/health`와 `/ready` probe를 제공합니다.

## MCP 도구

| 도구 | 역할 |
| --- | --- |
| `remember` | 새 기억 파편 저장 |
| `recall` | 키워드, 주제, 유형, 자연어 기반 검색 |
| `context` | 세션 시작 시 핵심 기억 복원 |
| `reflect` | 세션 활동을 구조화된 기억으로 반영 |
| `amend` | 기존 파편 수정과 이력 보존 |
| `forget` | 파편 또는 주제 단위 삭제 |
| `link` | 파편 간 명시적 관계 설정 |
| `graph_explore` | 관계 체인 탐색 |
| `fragment_history` | 수정 이력과 supersede 체인 조회 |
| `tool_feedback` | 도구 품질 피드백 기록 |
| `memory_stats` | 시스템 통계 조회 |
| `memory_consolidate` | 유지보수 파이프라인 수동 실행 |

## 빠른 시작

요구 사항:

- Docker + Docker Compose
- Codex app 또는 Codex CLI

```bash
cp .env.example .env
docker compose up --build
```

기본 확인:

```bash
curl -i http://localhost:57332/health
curl -i http://localhost:57332/ready
```

- `/health`: 프로세스가 요청을 처리할 수 있으면 `200`을 반환합니다.
- `/ready`: PostgreSQL이 응답할 때만 `200`을 반환합니다.
- Redis는 선택 구성입니다. `REDIS_ENABLED=false`이면 disabled 상태로 보고되며 readiness 실패 사유로 취급하지 않습니다.

Codex 설정 예시:

```toml
[mcp_servers.engram-codex]
url = "http://localhost:57332/mcp"
bearer_token_env_var = "ENGRAM_ACCESS_KEY"
```

정리:

```bash
docker compose down -v
```

## 수동 설치

```bash
npm install
cp .env.example .env
npm run db:init
npm start
```

PostgreSQL 서버에는 `pgvector`가 설치되어 있어야 하며, `npm run db:init`이 `vector` extension과 최신 스키마를 맞춥니다. 시맨틱 검색과 자동 링크를 쓰려면 임베딩 provider를 추가로 설정합니다.

```env
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

## 구성별 동작 범위

PostgreSQL만 있는 경우:

- 파편 저장/수정/삭제
- GIN 기반 구조 검색
- 기본 MCP 도구 전체 사용

Redis까지 있는 경우:

- L1 키워드 검색
- 세션 활동 추적
- 캐시/큐 기반 최적화

임베딩 provider까지 있는 경우:

- pgvector 시맨틱 검색
- 자동 링크 생성
- 자연어 recall 품질 향상

Gemini CLI까지 있는 경우:

- 비동기 품질 평가
- 모순 탐지 에스컬레이션
- 자동 reflect 품질 향상

## HTTP 엔드포인트

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/mcp` | Streamable HTTP JSON-RPC 요청 |
| `GET` | `/mcp` | Streamable HTTP SSE 스트림 |
| `DELETE` | `/mcp` | Streamable HTTP 세션 종료 |
| `GET` | `/sse` | Legacy SSE 세션 생성 |
| `POST` | `/message` | Legacy SSE JSON-RPC 요청 |
| `GET` | `/health` | Liveness probe |
| `GET` | `/ready` | PostgreSQL readiness probe |
| `GET` | `/metrics` | Prometheus 메트릭 |
| `GET` | `/.well-known/oauth-authorization-server` | OAuth 2.0 인가 서버 메타데이터 |
| `GET` | `/.well-known/oauth-protected-resource` | OAuth 2.0 보호 리소스 메타데이터 |
| `GET` | `/authorize` | OAuth 2.0 인가 엔드포인트 |
| `POST` | `/token` | OAuth 2.0 토큰 엔드포인트 |

관리용 API 키 대시보드 엔드포인트는 `/v1/internal/model/nothing/*` 아래에 제공됩니다.

## 기술 스택

| 영역 | 기술 |
| --- | --- |
| Runtime | Node.js 20+ |
| MCP/HTTP | `@modelcontextprotocol/sdk`, JSON-RPC, Streamable HTTP, Legacy SSE |
| Storage | PostgreSQL 14+, pgvector, Redis optional |
| Search/AI | OpenAI embeddings, Hugging Face Transformers, Gemini CLI optional |
| Observability | Prometheus metrics, Winston logging, audit log |
| Quality | Node test runner, ESLint |

## 프로젝트 구조

```text
server.js              # HTTP 서버 진입점
compose.yaml           # PostgreSQL/Redis 포함 로컬 실행
lib/jsonrpc.js         # JSON-RPC 파싱 및 dispatch
lib/tools/             # MCP 도구 구현
lib/memory/            # 기억 저장, 검색, 유지보수 핵심 로직
lib/admin/             # API key 관리
lib/http/              # HTTP/SSE 유틸리티
lib/logging/           # 감사 로그와 접근 이력
config/memory.js       # 랭킹, TTL, GC, pagination 설정
docs/skills/           # 에이전트 스킬 문서
```

## 검증

```bash
npm run lint
npm test
npm run test:db
npm run backfill:embeddings
```

`npm run test:db`는 PostgreSQL 연결이 필요한 통합 테스트입니다.

## 라이선스

Apache-2.0
