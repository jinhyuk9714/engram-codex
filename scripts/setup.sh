#!/usr/bin/env bash
# Engram Codex Setup

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}${BOLD}[setup]${RESET} $*"; }
success() { echo -e "${GREEN}${BOLD}[ok]${RESET} $*"; }
warn()    { echo -e "${YELLOW}${BOLD}[!]${RESET} $*"; }
error()   { echo -e "${RED}${BOLD}[x]${RESET} $*" >&2; }

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_command() {
  local cmd="$1" message="${2:-}"
  if ! command_exists "$cmd"; then
    error "${cmd} is required. ${message}"
    exit 1
  fi
}

run_sql_migration() {
  local file="$1"
  info "Applying $(basename "$file")..."
  psql "$DATABASE_URL" -f "$file"
  success "$(basename "$file") done."
}

ask() {
  local prompt="$1" default="${2:-}" var
  if [[ -n "$default" ]]; then
    read -rp "$(echo -e "${BOLD}${prompt}${RESET} [${default}]: ")" var
    echo "${var:-$default}"
  else
    read -rp "$(echo -e "${BOLD}${prompt}${RESET}: ")" var
    echo "$var"
  fi
}

ask_secret() {
  local prompt="$1" var
  read -rsp "$(echo -e "${BOLD}${prompt}${RESET}: ")" var
  echo
  echo "$var"
}

ask_yn() {
  local prompt="$1" default="${2:-y}" ans
  read -rp "$(echo -e "${BOLD}${prompt}${RESET} [${default}]: ")" ans
  ans="${ans:-$default}"
  [[ "$ans" =~ ^[Yy] ]]
}

echo
echo -e "${BOLD}------------------------------------------${RESET}"
echo -e "${BOLD}  Engram Codex -- Interactive Setup${RESET}"
echo -e "${BOLD}------------------------------------------${RESET}"
echo

info "Preflight checks"
require_command node "Install Node.js 20+ first."
require_command npm "Install npm before running setup."
require_command python3 "python3 is used to safely encode DATABASE_URL credentials."

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if (( NODE_MAJOR < 20 )); then
  error "Node.js 20+ is required. Current version: $(node -v)"
  exit 1
fi
success "Node.js $(node -v) detected"

HAS_PSQL="false"
if command_exists psql; then
  HAS_PSQL="true"
  success "psql detected"
else
  warn "psql not found. Schema and migration steps can be skipped now and run later."
fi

echo

# .env check
ENV_FILE=".env"

if [[ -f "$ENV_FILE" ]]; then
  warn ".env already exists."
  if ! ask_yn "Overwrite?" "n"; then
    info "Keeping existing .env. Exiting."
    exit 0
  fi
  cp "$ENV_FILE" "${ENV_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
  success "Backed up existing .env."
fi

echo

# Server
info "Server"
PORT=$(ask "Port" "57332")
SESSION_TTL=$(ask "Session TTL (minutes)" "60")
LOG_DIR=$(ask "Log directory" "/var/log/mcp")
MEMENTO_ACCESS_KEY=$(ask_secret "Access key (MEMENTO_ACCESS_KEY, leave blank to disable auth)")

echo

# PostgreSQL
info "PostgreSQL"
PG_HOST=$(ask "Host" "localhost")
PG_PORT=$(ask "Port" "5432")
PG_DB=$(ask "Database name")
PG_USER=$(ask "User")
PG_PASSWORD=$(ask_secret "Password")
DB_MAX_CONNECTIONS=$(ask "Max connections" "20")

DATABASE_URL="postgresql://${PG_USER}:$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$PG_PASSWORD")@${PG_HOST}:${PG_PORT}/${PG_DB}"

echo

# Redis
info "Redis"
if ask_yn "Enable Redis?" "y"; then
  REDIS_ENABLED="true"
  REDIS_HOST=$(ask "Host" "localhost")
  REDIS_PORT=$(ask "Port" "6379")
  REDIS_PASSWORD=$(ask_secret "Password (leave blank if none)")
  REDIS_DB=$(ask "DB index" "0")
else
  REDIS_ENABLED="false"
  REDIS_HOST="localhost"; REDIS_PORT="6379"; REDIS_PASSWORD=""; REDIS_DB="0"
fi

echo

# Embedding provider
info "Embedding Provider"
echo "  1) openai   (text-embedding-3-small, 1536 dims)"
echo "  2) gemini   (gemini-embedding-001, 3072 dims)"
echo "  3) ollama   (local, nomic-embed-text)"
echo "  4) localai  (local OpenAI-compatible)"
echo "  5) custom   (manual configuration)"
echo "  6) none     (disable semantic search)"
EMBED_CHOICE=$(ask "Choice" "1")

EMBEDDING_PROVIDER=""; EMBEDDING_API_KEY=""; EMBEDDING_MODEL=""
EMBEDDING_DIMENSIONS=""; EMBEDDING_BASE_URL=""

case "$EMBED_CHOICE" in
  1)
    EMBEDDING_PROVIDER="openai"
    EMBEDDING_API_KEY=$(ask_secret "OpenAI API Key")
    EMBEDDING_MODEL=$(ask "Model" "text-embedding-3-small")
    EMBEDDING_DIMENSIONS=$(ask "Dimensions" "1536")
    ;;
  2)
    EMBEDDING_PROVIDER="gemini"
    EMBEDDING_API_KEY=$(ask_secret "Gemini API Key")
    EMBEDDING_MODEL=$(ask "Model" "gemini-embedding-001")
    EMBEDDING_DIMENSIONS=$(ask "Dimensions" "3072")
    warn "3072 dims requires migration-007 on first use."
    ;;
  3)
    EMBEDDING_PROVIDER="ollama"
    EMBEDDING_MODEL=$(ask "Model" "nomic-embed-text")
    EMBEDDING_DIMENSIONS=$(ask "Dimensions" "768")
    ;;
  4)
    EMBEDDING_PROVIDER="localai"
    EMBEDDING_MODEL=$(ask "Model" "text-embedding-ada-002")
    EMBEDDING_DIMENSIONS=$(ask "Dimensions" "1536")
    ;;
  5)
    EMBEDDING_PROVIDER="custom"
    EMBEDDING_BASE_URL=$(ask "Base URL (e.g. http://localhost:8080/v1)")
    EMBEDDING_API_KEY=$(ask_secret "API Key")
    EMBEDDING_MODEL=$(ask "Model name")
    EMBEDDING_DIMENSIONS=$(ask "Dimensions")
    ;;
  6)
    EMBEDDING_PROVIDER=""
    ;;
esac

echo

# Write .env
info "Writing .env..."

cat > "$ENV_FILE" <<EOF
# Engram Codex environment variables
# Generated: $(date '+%Y-%m-%d %H:%M:%S')

# --- Server ----------------------------------------------------------
PORT=${PORT}
SESSION_TTL_MINUTES=${SESSION_TTL}
LOG_DIR=${LOG_DIR}
EOF

if [[ -n "$MEMENTO_ACCESS_KEY" ]]; then
  echo "MEMENTO_ACCESS_KEY=${MEMENTO_ACCESS_KEY}" >> "$ENV_FILE"
else
  echo "# MEMENTO_ACCESS_KEY=" >> "$ENV_FILE"
fi

cat >> "$ENV_FILE" <<EOF

# --- PostgreSQL ------------------------------------------------------
POSTGRES_HOST=${PG_HOST}
POSTGRES_PORT=${PG_PORT}
POSTGRES_DB=${PG_DB}
POSTGRES_USER=${PG_USER}
POSTGRES_PASSWORD=${PG_PASSWORD}
DATABASE_URL=${DATABASE_URL}
DB_MAX_CONNECTIONS=${DB_MAX_CONNECTIONS}
DB_IDLE_TIMEOUT_MS=30000
DB_CONN_TIMEOUT_MS=10000
DB_QUERY_TIMEOUT=30000

# --- Redis -----------------------------------------------------------
REDIS_ENABLED=${REDIS_ENABLED}
REDIS_HOST=${REDIS_HOST}
REDIS_PORT=${REDIS_PORT}
EOF

if [[ -n "$REDIS_PASSWORD" ]]; then
  echo "REDIS_PASSWORD=${REDIS_PASSWORD}" >> "$ENV_FILE"
else
  echo "# REDIS_PASSWORD=" >> "$ENV_FILE"
fi

cat >> "$ENV_FILE" <<EOF
REDIS_DB=${REDIS_DB}
CACHE_ENABLED=true
CACHE_DB_TTL=300
EOF

if [[ -n "$EMBEDDING_PROVIDER" ]]; then
  cat >> "$ENV_FILE" <<EOF

# --- Embedding -------------------------------------------------------
EMBEDDING_PROVIDER=${EMBEDDING_PROVIDER}
EOF
  if [[ "$EMBEDDING_PROVIDER" == "openai" ]]; then
    echo "OPENAI_API_KEY=${EMBEDDING_API_KEY}" >> "$ENV_FILE"
  elif [[ "$EMBEDDING_PROVIDER" == "gemini" ]]; then
    echo "GEMINI_API_KEY=${EMBEDDING_API_KEY}" >> "$ENV_FILE"
  elif [[ "$EMBEDDING_PROVIDER" == "custom" ]]; then
    echo "EMBEDDING_BASE_URL=${EMBEDDING_BASE_URL}" >> "$ENV_FILE"
    echo "EMBEDDING_API_KEY=${EMBEDDING_API_KEY}" >> "$ENV_FILE"
  fi
  [[ -n "$EMBEDDING_MODEL"      ]] && echo "EMBEDDING_MODEL=${EMBEDDING_MODEL}" >> "$ENV_FILE"
  [[ -n "$EMBEDDING_DIMENSIONS" ]] && echo "EMBEDDING_DIMENSIONS=${EMBEDDING_DIMENSIONS}" >> "$ENV_FILE"
fi

success ".env written."
chmod 600 "$ENV_FILE"

echo

# npm install
if ask_yn "Run npm install?" "y"; then
  info "Running npm install..."
  npm install
  success "Packages installed."
fi

echo

# DB schema
if [[ "$HAS_PSQL" == "true" ]] && ask_yn "Apply PostgreSQL schema?" "y"; then
  echo "  1) Fresh install (base schema + deterministic migrations)"
  echo "  2) Upgrade existing (deterministic migrations only)"
  SCHEMA_CHOICE=$(ask "Choice" "1")

  export DATABASE_URL
  SQL_MIGRATIONS=(
    "lib/memory/migration-001-temporal.sql"
    "lib/memory/migration-002-decay.sql"
    "lib/memory/migration-003-api-keys.sql"
    "lib/memory/migration-004-key-isolation.sql"
    "lib/memory/migration-005-gc-columns.sql"
    "lib/memory/migration-006-superseded-by-constraint.sql"
    "lib/memory/migration-007-link-weight.sql"
    "lib/memory/migration-008-morpheme-dict.sql"
  )

  if [[ "$SCHEMA_CHOICE" == "1" ]]; then
    info "Applying base schema snapshot..."
    psql "$DATABASE_URL" -f lib/memory/memory-schema.sql
    success "Base schema applied."

    info "Applying latest migrations on top of the base schema..."
    for file in "${SQL_MIGRATIONS[@]}"; do
      run_sql_migration "$file"
    done
  else
    info "Running deterministic migration sequence..."
    for file in "${SQL_MIGRATIONS[@]}"; do
      run_sql_migration "$file"
    done
  fi

  if [[ -n "$EMBEDDING_PROVIDER" ]] && [[ "${EMBEDDING_DIMENSIONS:-0}" -gt 2000 ]]; then
    warn "Dimensions ${EMBEDDING_DIMENSIONS} > 2000 require the JS dimension migration."
    if ask_yn "Run migration-007?" "y"; then
      EMBEDDING_DIMENSIONS="$EMBEDDING_DIMENSIONS" DATABASE_URL="$DATABASE_URL" \
        node lib/memory/migration-007-flexible-embedding-dims.js
      success "migration-007 done."
    else
      warn "Remember to run: EMBEDDING_DIMENSIONS=${EMBEDDING_DIMENSIONS} DATABASE_URL=\$DATABASE_URL node lib/memory/migration-007-flexible-embedding-dims.js"
    fi
  fi

  if [[ -n "$EMBEDDING_PROVIDER" ]]; then
    if ask_yn "Run L2 normalization on existing vectors? (one-time)" "y"; then
      node lib/memory/normalize-vectors.js
      success "L2 normalization done."
    fi
  fi
elif [[ "$HAS_PSQL" != "true" ]]; then
  warn "Skipping schema step because psql is not available."
fi

echo
echo -e "${GREEN}${BOLD}------------------------------------------${RESET}"
echo -e "${GREEN}${BOLD}  Setup complete. Start: node server.js${RESET}"
echo -e "${GREEN}${BOLD}------------------------------------------${RESET}"
echo
echo "Verification"
echo "  1) Start the server: node server.js"
echo "  2) Liveness probe:  curl -i http://localhost:${PORT}/health"
echo "     Expected: HTTP 200. Redis shows 'disabled' when REDIS_ENABLED=false."
echo "  3) Readiness probe: curl -i http://localhost:${PORT}/ready"
echo "     Expected: HTTP 200 only when PostgreSQL is reachable."
echo "  4) Metrics probe:   curl -i http://localhost:${PORT}/metrics"
echo
