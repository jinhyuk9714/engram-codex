# 설치 가이드

## 빠른 시작 (Docker Compose)

가장 쉬운 로컬 체험 경로다. 기본 스택은 `postgres + engram-codex`만 포함한다.

```bash
cp .env.example .env
# .env에서 ENGRAM_ACCESS_KEY와 PostgreSQL 계정을 원하는 값으로 수정
docker compose up --build
```

확인:

```bash
curl -i http://localhost:57332/health
curl -i http://localhost:57332/ready
curl -i http://localhost:57332/metrics
```

- `/health`는 liveness probe다. 프로세스가 살아 있으면 `200`을 반환한다.
- `/ready`는 readiness probe다. PostgreSQL 연결이 실제로 성공할 때만 `200`을 반환한다.
- `REDIS_ENABLED=false`인 경우 Redis는 `disabled`로 보고되며 readiness 실패로 간주되지 않는다.
- `.env`는 자동 로드되므로 `source .env`가 필요 없다.

종료/정리:

```bash
docker compose down -v
```

## Codex app / CLI 연결

Codex app과 CLI는 MCP 설정을 공유한다. 먼저 셸에 접근 키를 노출한다.

```bash
export ENGRAM_ACCESS_KEY='YOUR_ENGRAM_ACCESS_KEY'
```

그 다음 `~/.codex/config.toml`에 아래를 추가한다.

```toml
[mcp_servers.engram-codex]
url = "http://localhost:57332/mcp"
bearer_token_env_var = "ENGRAM_ACCESS_KEY"
```

## 브레이킹 체인지 주의

- 기존 `MEMENTO_ACCESS_KEY`와 `memento-access-key`는 더 이상 동작하지 않는다.
- 기존 운영 환경은 셸 환경변수, Codex 설정, reverse proxy 헤더 전달, 배포 스크립트를 `ENGRAM_ACCESS_KEY`와 `engram-access-key` 기준으로 업데이트해야 한다.
- Redis를 쓰고 있었다면 임베딩 큐 키가 `engram:embedding_queue`로 바뀌므로, 업그레이드 후에는 예전 `memento:embedding_queue` 적재분이 자동 소비되지 않는다.

프로젝트별로만 켜고 싶다면 신뢰된 저장소의 `.codex/config.toml`에서 같은 서버를 override해도 된다. Codex app과 CLI는 이 MCP 설정을 함께 사용한다.

---

## 수동 설치

### 대화형 설치 스크립트

```bash
bash scripts/setup.sh

# 호환 경로
# bash setup.sh
```

.env 생성, `npm install`, `npm run db:init`까지 단계별로 안내한다.

### 의존성 설치

```bash
npm install

# (선택) CUDA 11 환경에서 설치 오류 발생 시 CPU 전용으로 설치
# npm install --onnxruntime-node-install-cuda=skip
```

### 주의사항: ONNX Runtime 및 CUDA

CUDA 11이 설치된 시스템에서 `@huggingface/transformers`의 의존성인 `onnxruntime-node`가 GPU 바인딩을 시도하다 설치에 실패할 수 있습니다. 이 프로젝트는 CPU 전용으로 최적화되어 있으므로, 설치 시 `--onnxruntime-node-install-cuda=skip` 플래그를 사용하면 문제 없이 설치됩니다.

### PostgreSQL 준비

수동 경로에서는 PostgreSQL 14+와 `pgvector`가 필요하다. DB 서버에 확장이 설치되어 있어야 `npm run db:init`이 `CREATE EXTENSION vector`를 성공시킬 수 있다.

### DB bootstrap / 업그레이드

```bash
npm run db:init
```

`npm run db:init`은 아래를 순서대로 수행한다.
- `CREATE EXTENSION IF NOT EXISTS vector`
- `memory-schema.sql`
- migration `001` ~ `008`
- `EMBEDDING_DIMENSIONS > 2000`인 경우 flexible-dims JS migration

기존 설치 업그레이드에도 같은 명령을 사용하면 된다. idempotent하게 설계되어 있어 새 DB와 기존 DB 모두 같은 최신 상태로 맞춘다.

```bash
# 임베딩 차원 전환 후 기존 벡터를 재정규화해야 하는 경우
node lib/memory/normalize-vectors.js

# 기존 파편 임베딩 백필 (임베딩 API 키 필요, 1회성)
npm run backfill:embeddings
```

### 환경 변수 설정

```bash
cp .env.example .env
# .env 파일에서 DATABASE_URL, ENGRAM_ACCESS_KEY 등 필수 값 입력
```

- `DATABASE_URL`은 `npm run db:init`과 maintenance 스크립트의 canonical DSN이다.
- 런타임은 `POSTGRES_*`와 `DATABASE_URL`을 모두 지원한다.
- `.env`는 자동 로드되므로 `source .env`가 필요 없다.

운영 중 in-process ONNX NLI를 긴급 우회해야 하면 `.env`에 `NLI_DISABLE_INPROCESS=true`를 추가한다. 이는 외부 `NLI_SERVICE_URL`이 없을 때만 적용되며, 정상 기본값은 `false`다.

### 서버 실행

```bash
npm start
```

### 서버 확인

```bash
curl -i http://localhost:57332/health
curl -i http://localhost:57332/ready
curl -i http://localhost:57332/metrics
```

- `/health`는 liveness probe다. 프로세스가 살아 있으면 `200`을 반환한다.
- `/ready`는 readiness probe다. PostgreSQL 연결이 실제로 성공할 때만 `200`을 반환한다.
- `REDIS_ENABLED=false`인 경우 Redis는 `disabled`로 보고되며 readiness 실패로 간주되지 않는다.
- `NLI_DISABLE_INPROCESS=true`를 쓰면 shutdown 안정화용으로 in-process NLI preload/추론을 건너뛸 수 있다.

### 테스트

```bash
npm test

# PostgreSQL과 DATABASE_URL이 준비된 경우만
npm run test:db
```

`npm test`는 로컬에서 바로 검증 가능한 테스트만 실행한다. temporal 통합 테스트는 Postgres 의존성이 있으므로 `npm run test:db`로 분리되어 있다.

## 세션 시작 규칙 권장

`initialize` 응답의 `instructions` 필드는 `context`, `recall`, `reflect` 사용을 권장하지만, 저장소별 습관은 `AGENTS.md`에 두는 편이 가장 안정적이다.

```markdown
## Memory Rules
- 세션 시작 시 `context` 도구를 호출하여 Core Memory와 Working Memory를 로드한다.
- 에러 해결이나 코드 작업 전에는 `recall(keywords=[관련_키워드], type="error")`로 관련 기억을 먼저 확인한다.
- 중요한 결정이 확정되면 `remember`를 호출하고, 작업 마일스톤이나 종료 전에는 `reflect`를 호출한다.
```

`context`는 중요도 높은 파편만 캡슐화해서 주입하므로 컨텍스트 오염을 줄인다. `recall`은 현재 작업과 관련된 파편을 키워드/시맨틱 검색으로 추가 로드한다. `AGENTS.md`에 이 규칙을 두면 Codex가 매 세션마다 같은 기억 습관을 재사용할 수 있다.

외부에서 접속할 때는 nginx 리버스 프록시를 통해 노출한다. 내부 IP나 내부 포트를 외부 문서에 직접 기재하지 않는다.
