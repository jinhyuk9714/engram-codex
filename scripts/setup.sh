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

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if (( NODE_MAJOR < 20 )); then
  error "Node.js 20+ is required. Current version: $(node -v)"
  exit 1
fi
success "Node.js $(node -v) detected"

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
LOG_DIR=$(ask "Log directory" "tmp/logs")
ENGRAM_ACCESS_KEY=$(ask_secret "Access key (ENGRAM_ACCESS_KEY, leave blank to disable auth)")

echo

# PostgreSQL
info "PostgreSQL"
PG_HOST=$(ask "Host" "localhost")
PG_PORT=$(ask "Port" "5432")
PG_DB=$(ask "Database name")
PG_USER=$(ask "User")
PG_PASSWORD=$(ask_secret "Password")
DB_MAX_CONNECTIONS=$(ask "Max connections" "20")

DATABASE_URL="postgresql://${PG_USER}:$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$PG_PASSWORD")@${PG_HOST}:${PG_PORT}/${PG_DB}"

echo

# Redis
info "Redis"
if ask_yn "Enable Redis?" "n"; then
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
echo "  1) none     (disable semantic search)"
echo "  2) openai   (text-embedding-3-small, 1536 dims)"
echo "  3) gemini   (gemini-embedding-001, 3072 dims)"
echo "  4) ollama   (local, nomic-embed-text)"
echo "  5) localai  (local OpenAI-compatible)"
echo "  6) custom   (manual configuration)"
EMBED_CHOICE=$(ask "Choice" "1")

EMBEDDING_PROVIDER=""; EMBEDDING_API_KEY=""; EMBEDDING_MODEL=""
EMBEDDING_DIMENSIONS=""; EMBEDDING_BASE_URL=""

case "$EMBED_CHOICE" in
  1)
    EMBEDDING_PROVIDER=""
    ;;
  2)
    EMBEDDING_PROVIDER="openai"
    EMBEDDING_API_KEY=$(ask_secret "OpenAI API Key")
    EMBEDDING_MODEL=$(ask "Model" "text-embedding-3-small")
    EMBEDDING_DIMENSIONS=$(ask "Dimensions" "1536")
    ;;
  3)
    EMBEDDING_PROVIDER="gemini"
    EMBEDDING_API_KEY=$(ask_secret "Gemini API Key")
    EMBEDDING_MODEL=$(ask "Model" "gemini-embedding-001")
    EMBEDDING_DIMENSIONS=$(ask "Dimensions" "3072")
    warn "3072 dims requires migration-007 on first use."
    ;;
  4)
    EMBEDDING_PROVIDER="ollama"
    EMBEDDING_MODEL=$(ask "Model" "nomic-embed-text")
    EMBEDDING_DIMENSIONS=$(ask "Dimensions" "768")
    ;;
  5)
    EMBEDDING_PROVIDER="localai"
    EMBEDDING_MODEL=$(ask "Model" "text-embedding-ada-002")
    EMBEDDING_DIMENSIONS=$(ask "Dimensions" "1536")
    ;;
  6)
    EMBEDDING_PROVIDER="custom"
    EMBEDDING_BASE_URL=$(ask "Base URL (e.g. http://localhost:8080/v1)")
    EMBEDDING_API_KEY=$(ask_secret "API Key")
    EMBEDDING_MODEL=$(ask "Model name")
    EMBEDDING_DIMENSIONS=$(ask "Dimensions")
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

if [[ -n "$ENGRAM_ACCESS_KEY" ]]; then
  echo "ENGRAM_ACCESS_KEY=${ENGRAM_ACCESS_KEY}" >> "$ENV_FILE"
else
  echo "# ENGRAM_ACCESS_KEY=" >> "$ENV_FILE"
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
CACHE_ENABLED=${REDIS_ENABLED}
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
if ask_yn "Run npm run db:init now?" "y"; then
  info "Running npm run db:init..."
  npm run db:init
  success "Database bootstrap completed."

  if [[ -n "$EMBEDDING_PROVIDER" ]]; then
    if ask_yn "Run L2 normalization on existing vectors? (one-time)" "y"; then
      node lib/memory/normalize-vectors.js
      success "L2 normalization done."
    fi
  fi
fi

echo
echo -e "${GREEN}${BOLD}------------------------------------------${RESET}"
echo -e "${GREEN}${BOLD}  Setup complete. Start: node server.js${RESET}"
echo -e "${GREEN}${BOLD}------------------------------------------${RESET}"
echo
echo "Verification"
echo "  1) Start the server: node server.js"
echo "     .env is loaded automatically; no 'source .env' step is required."
echo "  2) Liveness probe:  curl -i http://localhost:${PORT}/health"
echo "     Expected: HTTP 200. Redis shows 'disabled' when REDIS_ENABLED=false."
echo "  3) Readiness probe: curl -i http://localhost:${PORT}/ready"
echo "     Expected: HTTP 200 only when PostgreSQL is reachable."
echo "  4) Metrics probe:   curl -i http://localhost:${PORT}/metrics"
echo
