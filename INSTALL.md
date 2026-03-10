# 설치 가이드

## 빠른 시작 (대화형 설치 스크립트)

```bash
bash scripts/setup.sh

# 호환 경로
# bash setup.sh
```

.env 생성, npm install, DB 스키마 적용까지 단계별로 안내한다.
스크립트는 Node.js/`npm`/`python3`를 먼저 점검하고, `psql`이 없으면 스키마 단계를 건너뛸 수 있게 안내한다.

---

## 수동 설치

## 의존성 설치

```bash
npm install

# (선택) CUDA 11 환경에서 설치 오류 발생 시 CPU 전용으로 설치
# npm install --onnxruntime-node-install-cuda=skip
```

### 주의사항: ONNX Runtime 및 CUDA

CUDA 11이 설치된 시스템에서 `@huggingface/transformers`의 의존성인 `onnxruntime-node`가 GPU 바인딩을 시도하다 설치에 실패할 수 있습니다. 이 프로젝트는 CPU 전용으로 최적화되어 있으므로, 설치 시 `--onnxruntime-node-install-cuda=skip` 플래그를 사용하면 문제 없이 설치됩니다.

## PostgreSQL 스키마 적용

신규 설치는 base schema를 적용한 뒤, 최신 코드가 요구하는 컬럼/테이블까지 deterministic migration sequence를 모두 실행한다.

```bash
# 신규 설치: base schema + 최신 migration 전체 적용
psql -U $POSTGRES_USER -d $POSTGRES_DB -f lib/memory/memory-schema.sql
psql $DATABASE_URL -f lib/memory/migration-001-temporal.sql      # Temporal 컬럼 추가
psql $DATABASE_URL -f lib/memory/migration-002-decay.sql         # last_decay_at 컬럼 추가
psql $DATABASE_URL -f lib/memory/migration-003-api-keys.sql      # API 키 관리 테이블 추가
psql $DATABASE_URL -f lib/memory/migration-004-key-isolation.sql # fragments.key_id 격리 컬럼 추가
psql $DATABASE_URL -f lib/memory/migration-005-gc-columns.sql    # GC 정책 인덱스 추가
psql $DATABASE_URL -f lib/memory/migration-006-superseded-by-constraint.sql # fragment_links CHECK에 superseded_by 추가
psql $DATABASE_URL -f lib/memory/migration-007-link-weight.sql   # 링크 weight 컬럼 추가
psql $DATABASE_URL -f lib/memory/migration-008-morpheme-dict.sql # 형태소 사전 테이블 추가
```

## 업그레이드 (기존 설치)

기존 설치 업그레이드는 아래 migration sequence만 실행한다.

```bash
psql $DATABASE_URL -f lib/memory/migration-001-temporal.sql      # Temporal 컬럼 추가
psql $DATABASE_URL -f lib/memory/migration-002-decay.sql         # last_decay_at 컬럼 추가
psql $DATABASE_URL -f lib/memory/migration-003-api-keys.sql      # API 키 관리 테이블 추가
psql $DATABASE_URL -f lib/memory/migration-004-key-isolation.sql # fragments.key_id 격리 컬럼 추가
psql $DATABASE_URL -f lib/memory/migration-005-gc-columns.sql    # GC 정책 인덱스 추가
psql $DATABASE_URL -f lib/memory/migration-006-superseded-by-constraint.sql # fragment_links CHECK에 superseded_by 추가
psql $DATABASE_URL -f lib/memory/migration-007-link-weight.sql   # 링크 weight 컬럼 추가
psql $DATABASE_URL -f lib/memory/migration-008-morpheme-dict.sql # 형태소 사전 테이블 추가
```

> **v1.1.0 이전에서 업그레이드하는 경우**: migration-006 미실행 시 `amend`, `memory_consolidate`, GraphLinker 자동 관계 생성에서 DB 제약 에러가 발생한다(`superseded_by` INSERT 실패). 기존 DB를 유지하며 업그레이드할 때 반드시 실행해야 한다.

```bash
# 기본 임베딩(1536차원) 사용 시: migration-007 불필요
# 2000차원 초과 모델(Gemini gemini-embedding-001 등) 사용 시:
# EMBEDDING_DIMENSIONS=3072 DATABASE_URL=$DATABASE_URL node lib/memory/migration-007-flexible-embedding-dims.js

DATABASE_URL=$DATABASE_URL node lib/memory/normalize-vectors.js  # 임베딩 L2 정규화 (1회)

# 기존 파편 임베딩 백필 (임베딩 API 키 필요, 1회성)
npm run backfill:embeddings
```

## 환경 변수 설정

```bash
cp .env.example .env
# .env 파일에서 DATABASE_URL, MEMENTO_ACCESS_KEY 등 필수 값 입력
```

환경 변수 전체 목록은 [README.md — 환경 변수](README.md#환경-변수) 참조.

운영 중 in-process ONNX NLI를 긴급 우회해야 하면 `.env`에 `NLI_DISABLE_INPROCESS=true`를 추가한다. 이는 외부 `NLI_SERVICE_URL`이 없을 때만 적용되며, 정상 기본값은 `false`다.

## 서버 실행

```bash
node server.js
```

## 서버 확인

```bash
curl -i http://localhost:57332/health
curl -i http://localhost:57332/ready
curl -i http://localhost:57332/metrics
```

- `/health`는 liveness probe다. 프로세스가 살아 있으면 `200`을 반환한다.
- `/ready`는 readiness probe다. PostgreSQL 연결이 실제로 성공할 때만 `200`을 반환한다.
- `REDIS_ENABLED=false`인 경우 Redis는 `disabled`로 보고되며 readiness 실패로 간주되지 않는다.
- `NLI_DISABLE_INPROCESS=true`를 쓰면 shutdown 안정화용으로 in-process NLI preload/추론을 건너뛸 수 있다.

## 테스트

```bash
npm test

# PostgreSQL과 DATABASE_URL이 준비된 경우만
npm run test:db
```

`npm test`는 로컬에서 바로 검증 가능한 테스트만 실행한다. temporal 통합 테스트는 Postgres 의존성이 있으므로 `npm run test:db`로 분리되어 있다.

## Codex app / CLI 연결

Codex app과 CLI는 MCP 설정을 공유한다. 먼저 셸에 접근 키를 노출한다.

```bash
export MEMENTO_ACCESS_KEY='YOUR_MEMENTO_ACCESS_KEY'
```

그 다음 `~/.codex/config.toml`에 아래를 추가한다.

```toml
[mcp_servers.engram-codex]
url = "http://localhost:57332/mcp"
bearer_token_env_var = "MEMENTO_ACCESS_KEY"
```

프로젝트별로만 켜고 싶다면 신뢰된 저장소의 `.codex/config.toml`에서 같은 서버를 override해도 된다. Codex app과 CLI는 이 MCP 설정을 함께 사용한다.

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
