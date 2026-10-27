#!/usr/bin/env bash
# =============================================================================
# basefyio installer — install, reconfigure, upgrade, roll back.
#
#   scripts/install.sh [install]            ask the questions, write the env file, start the stack
#   scripts/install.sh upgrade              back up, move to a newer release, roll back on failure
#   scripts/install.sh rollback             return to the release before the last upgrade
#   scripts/install.sh restore <backup-dir> put a database backup back (replaces current data)
#   scripts/install.sh status               what runs, which release, which options
#
# Options:
#   --answers FILE     answers as KEY=VALUE lines (same names as below)
#   --yes              non-interactive: take the default for every unanswered question
#   --version vX.Y.Z   release to install (or "current" for this checkout as it is)
#   --dry-run          print the plan and the files that would be written; change nothing
#
# Every question has a default, and the default is what an installation does
# today, so running the installer without choosing anything reproduces the
# current setup. Answers can come from the environment, from --answers, or
# interactively; they are stored in the env file as BASEFYIO_* so upgrades
# ask nothing that was answered before.
#
#   BASEFYIO_BASE            selfhost | prod      compose file: docker-compose.yml (builds from source)
#                                                 or docker-compose.prod.yml (registry images, TLS by Let's Encrypt)
#   BASEFYIO_VERSION         vX.Y.Z | current     release to run (default: newest release)
#   BASEFYIO_IMAGES          build | pull | bundle  where the platform images come from
#   BASEFYIO_BUNDLE          path                 image bundle for BASEFYIO_IMAGES=bundle (scripts/bundle-images.sh)
#   BASEFYIO_KEYCLOAK        24 | 26 | external   identity server (default 24)
#   BASEFYIO_DB_ADMIN_ROLE   no | yes             a direct Postgres role with CREATEDB/CREATEROLE (default no)
#   BASEFYIO_PGBOUNCER_BIND  all | local | closed where PgBouncer listens (default all)
#   BASEFYIO_DOCSTORE        yes | no             document store for the Data Engine (default yes)
#   BASEFYIO_AI              on | off             hosted AI models and embeddings (default on)
#   BASEFYIO_MAIL            resend | smtp        how platform mail leaves (default resend)
#   BASEFYIO_OFFLINE         no | yes             host without internet access (default no)
#   BASEFYIO_PIN_COMPONENTS  yes | no             pin component images to deploy/components.env
#                                                 (default: yes for a new installation, no for an existing one)
#
# Component settings asked when an option needs them: KEYCLOAK_URL,
# KEYCLOAK_PUBLIC_URL, KEYCLOAK_ADMIN_USER, KEYCLOAK_ADMIN_PASSWORD, SMTP_HOST,
# SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_SECURE, MAIL_FROM,
# KEYCLOAK_REALM_SMTP, POSTGRES_APP_ADMIN_USER, POSTGRES_APP_ADMIN_PASSWORD,
# POSTGRES_DIRECT_BIND, POSTGRES_DIRECT_PORT.
#
# Requirements: Docker Engine with Compose 2.24+, git, bash 4+.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MIN_VERSION="v2.9.6"          # the first release that carries this installer
HEALTH_TIMEOUT_S="${BASEFYIO_HEALTH_TIMEOUT:-900}"

COMMAND="install"
ANSWERS_FILE=""
NONINTERACTIVE="${BASEFYIO_NONINTERACTIVE:-0}"
DRY_RUN=0
RESTORE_DIR=""
INTERNAL_ROLE=""             # rollback-apply, set when the installer re-runs itself

# ── output ────────────────────────────────────────────────────────────────────
log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,46p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

# ── arguments ─────────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    install|upgrade|rollback|status) COMMAND="$1" ;;
    restore) COMMAND="restore"; RESTORE_DIR="${2:-}"; shift ;;
    rollback-apply) COMMAND="install"; INTERNAL_ROLE="rollback-apply" ;;
    --answers) ANSWERS_FILE="${2:?--answers needs a file}"; shift ;;
    --yes|-y|--non-interactive) NONINTERACTIVE=1 ;;
    --version) export BASEFYIO_VERSION="${2:?--version needs a value}"; shift ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

# ── small helpers ─────────────────────────────────────────────────────────────
have() { command -v "$1" >/dev/null 2>&1; }

# vX.Y.Z >= vA.B.C
ver_ge() {
  local a="${1#v}" b="${2#v}"
  [ "$(printf '%s\n%s\n' "$a" "$b" | sort -t. -k1,1n -k2,2n -k3,3n | head -n1)" = "$b" ]
}

gen_secret() {
  if have openssl; then openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32
  else tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32; fi
}
gen_key_b64() {
  if have openssl; then openssl rand -base64 32
  else head -c 32 /dev/urandom | base64; fi
}

# Read KEY from an env file: the last assignment wins, surrounding quotes removed.
env_get() {
  local key="$1" file="${2:-$ENV_FILE}"
  [ -f "$file" ] || return 0
  awk -v k="$key" '
    $0 ~ "^[[:space:]]*" k "=" {
      v = $0; sub("^[[:space:]]*" k "=", "", v)
      if (v ~ /^".*"$/ || v ~ /^'"'"'.*'"'"'$/) v = substr(v, 2, length(v) - 2)
      last = v
    }
    END { if (last != "") print last }' "$file"
}

# Quote a value so that both Compose and a line-by-line parser read it back
# verbatim. Values with < > & | spaces or $ must be quoted: an unquoted "<"
# once silently truncated a production env file for every tool after it.
quote_env() {
  local v="$1"
  if [[ "$v" =~ ^[A-Za-z0-9_./:@+=,%-]*$ ]]; then printf '%s' "$v"
  elif [[ "$v" != *"'"* ]]; then printf "'%s'" "$v"
  else
    v="${v//\\/\\\\}"; v="${v//\"/\\\"}"; v="${v//\$/\\\$}"; v="${v//\`/\\\`}"
    printf '"%s"' "$v"
  fi
}

env_set() {
  local key="$1" value="$2" file="${3:-$ENV_FILE}"
  local line; line="$key=$(quote_env "$value")"
  if [ "$DRY_RUN" = 1 ]; then printf '   would set %s\n' "$key"; return 0; fi
  touch "$file"
  if grep -qE "^[[:space:]]*$key=" "$file"; then
    awk -v k="$key" -v l="$line" '
      $0 ~ "^[[:space:]]*" k "=" { if (!done) { print l; done = 1 }; next }
      { print }' "$file" > "$file.tmp" && cat "$file.tmp" > "$file" && rm -f "$file.tmp"
  else
    printf '%s\n' "$line" >> "$file"
  fi
}

env_unset() {
  local key="$1" file="${2:-$ENV_FILE}"
  [ "$DRY_RUN" = 1 ] && return 0
  [ -f "$file" ] || return 0
  grep -vE "^[[:space:]]*$key=" "$file" > "$file.tmp" || true
  cat "$file.tmp" > "$file" && rm -f "$file.tmp"
}

# Answers file: KEY=VALUE lines only, never executed.
load_answers() {
  local file="$1" key value
  [ -f "$file" ] || die "answers file not found: $file"
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^[[:space:]]*([A-Z_][A-Z0-9_]*)=(.*)$ ]] || { warn "ignored line in $file: $line"; continue; }
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
    if [ -z "${!key+x}" ]; then export "$key=$value"; fi   # the real environment wins over the file
  done < "$file"
}

can_prompt() { [ "$NONINTERACTIVE" != 1 ] && [ -r /dev/tty ] && [ -w /dev/tty ]; }

# ask VAR "question" default "choice1 choice2 …" — keeps an answer that is already set.
ask() {
  local var="$1" question="$2" default="$3" choices="${4:-}" answer
  if [ -n "${!var:-}" ]; then
    answer="${!var}"
  elif ! can_prompt; then
    answer="$default"
  else
    while :; do
      if [ -n "$choices" ]; then printf '%s [%s] (%s): ' "$question" "${choices// /\/}" "$default" > /dev/tty
      else printf '%s (%s): ' "$question" "${default:-empty}" > /dev/tty; fi
      IFS= read -r answer < /dev/tty || answer=""
      answer="${answer:-$default}"
      if [ -z "$choices" ] || [[ " $choices " == *" $answer "* ]]; then break; fi
      printf '   choose one of: %s\n' "$choices" > /dev/tty
    done
  fi
  if [ -n "$choices" ] && [[ " $choices " != *" $answer "* ]]; then
    die "$var=$answer is not one of: $choices"
  fi
  printf -v "$var" '%s' "$answer"; export "${var?}"
}

ask_secret() {
  local var="$1" question="$2" default="$3" answer
  if [ -n "${!var:-}" ]; then answer="${!var}"
  elif ! can_prompt; then answer="$default"
  else
    printf '%s (%s): ' "$question" "$( [ -n "$default" ] && echo 'enter keeps the generated one' || echo 'empty' )" > /dev/tty
    IFS= read -rs answer < /dev/tty || answer=""; printf '\n' > /dev/tty
    answer="${answer:-$default}"
  fi
  printf -v "$var" '%s' "$answer"; export "${var?}"
}

confirm() {
  local question="$1" env_override="$2"
  if [ "${!env_override:-}" = "yes" ]; then return 0; fi
  if ! can_prompt; then die "$question — set $env_override=yes to confirm non-interactively"; fi
  local answer; printf '%s Type "yes" to continue: ' "$question" > /dev/tty
  IFS= read -r answer < /dev/tty || answer=""
  [ "$answer" = "yes" ] || die "stopped; nothing was changed after this point"
}

# ── environment checks ────────────────────────────────────────────────────────
need_tools() {
  have docker || die "docker is not installed"
  docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin (docker compose) is not installed"
  local cv; cv="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
  ver_ge "v$cv" "v2.24.0" || die "Docker Compose $cv is too old; 2.24 or newer is required"
  have git || die "git is not installed"
}

# The basefyio cloud's own production host deploys through the release
# workflow; this script must never reconfigure it.
guard_cloud_host() {
  local domain; domain="$(env_get DOMAIN)"
  if [ "$domain" = "basefyio.com" ]; then
    die "this is the basefyio cloud production host (DOMAIN=basefyio.com); it deploys through the release workflow, not this script"
  fi
}

# ── versions ──────────────────────────────────────────────────────────────────
release_tags() {
  git tag -l 'v*' --sort=-v:refname 2>/dev/null | grep -E '^v[0-9]+\.[0-9]\.[0-9]$' | while read -r t; do
    ver_ge "$t" "$MIN_VERSION" && echo "$t"
  done || true
}

checkout_version() {
  local label; label="$(package_version)"
  printf '%s' "v$label"
}

package_version() {
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' apps/platform-api/package.json | head -n1
}

# ── state of an existing installation ────────────────────────────────────────
detect_project() {
  # The compose project an existing stack in this directory runs under. Using a
  # different name would start a second, empty stack beside the real one.
  docker ps -a --filter "label=com.docker.compose.project.working_dir=$ROOT" \
    --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | sort -u | grep -v '^$' || true
}

stack_running() {
  [ -n "$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.ID}}' 2>/dev/null | head -n1)" ]
}

dc() { docker compose -p "$PROJECT" --project-directory "$ROOT" --env-file "$ENV_FILE" "${FILE_ARGS[@]}" "$@"; }

# ── configuration ─────────────────────────────────────────────────────────────
resolve_base_and_env() {
  if [ -z "${BASEFYIO_BASE:-}" ]; then
    if [ -f .env.production ] && [ ! -f .env ]; then BASEFYIO_BASE=prod
    elif [ -f .env ]; then BASEFYIO_BASE=selfhost
    else BASEFYIO_BASE=""; fi
  fi
  ask BASEFYIO_BASE "Compose file: self-host (builds from source) or production-shaped (registry images, Let's Encrypt)" selfhost "selfhost prod"
  if [ "$BASEFYIO_BASE" = prod ]; then BASE_FILE=docker-compose.prod.yml; DEFAULT_ENV=.env.production
  else BASE_FILE=docker-compose.yml; DEFAULT_ENV=.env; fi
  ENV_FILE="${BASEFYIO_ENV_FILE:-$DEFAULT_ENV}"
  EXISTING=0
  if [ -f "$ENV_FILE" ]; then EXISTING=1; fi
}

# Defaults for every question come from the env file when the installer ran
# before, otherwise from what the stack does today.
stored() { local v; v="$(env_get "$1")"; printf '%s' "${v:-$2}"; }

read_previous_answers() {
  PREV_KEYCLOAK="$(env_get BASEFYIO_KEYCLOAK)"
  if [ -z "$PREV_KEYCLOAK" ] && [ "$EXISTING" = 1 ]; then
    case "$(env_get KEYCLOAK_IMAGE)" in *:26*) PREV_KEYCLOAK=26 ;; *) PREV_KEYCLOAK=24 ;; esac
  fi
}

new_env_file() {
  [ "$EXISTING" = 1 ] && return 0
  log "creating $ENV_FILE from .env.example with generated passwords"
  [ "$DRY_RUN" = 1 ] && return 0
  cp .env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE" || true
  local k
  for k in POSTGRES_PASSWORD KEYCLOAK_ADMIN_PASSWORD MINIO_ROOT_PASSWORD PGBOUNCER_ADMIN_PASSWORD \
           RABBITMQ_PASSWORD NOSQL_PASSWORD METRICS_TOKEN PLATFORM_STATUS_PROBE_TOKEN; do
    env_set "$k" "$(gen_secret)"
  done
  env_set DB_CRED_ENC_KEY "$(gen_key_b64)"
  env_set BACKUP_ENC_KEY "$(gen_key_b64)"
}

ask_everything() {
  local tags newest
  tags="$(release_tags)"
  newest="$(printf '%s\n' "$tags" | head -n1)"
  [ -n "$newest" ] || newest=current
  [ -n "${BASEFYIO_VERSION:-}" ] || BASEFYIO_VERSION=""
  if [ -n "$tags" ] && can_prompt && [ -z "$BASEFYIO_VERSION" ]; then
    printf 'Releases: %s\n' "$(printf '%s ' $tags)" > /dev/tty
  fi
  ask BASEFYIO_VERSION "basefyio release" "$newest"

  local images_default=build; [ "$BASEFYIO_BASE" = prod ] && images_default=pull
  ask BASEFYIO_IMAGES "Platform images: build from source, pull from the registry, or load a bundle" "$(stored BASEFYIO_IMAGES "$images_default")" "build pull bundle"
  if [ "$BASEFYIO_IMAGES" = pull ] && [ "$BASEFYIO_BASE" = selfhost ]; then
    die "the self-host file builds the platform images; choose build or bundle (pull needs BASEFYIO_BASE=prod)"
  fi
  if [ "$BASEFYIO_IMAGES" = bundle ]; then ask BASEFYIO_BUNDLE "Path of the image bundle (.tar.gz)" "$(stored BASEFYIO_BUNDLE "")"; fi

  ask BASEFYIO_KEYCLOAK "Keycloak: bundled 24, bundled 26, or an external server" "$(stored BASEFYIO_KEYCLOAK "${PREV_KEYCLOAK:-24}")" "24 26 external"
  if [ "$BASEFYIO_KEYCLOAK" = external ]; then
    ask KEYCLOAK_URL "External Keycloak URL the API calls (e.g. https://sso.example.com)" "$(stored KEYCLOAK_URL "")"
    ask KEYCLOAK_PUBLIC_URL "Keycloak URL browsers see and tokens are issued for" "$(stored KEYCLOAK_PUBLIC_URL "$KEYCLOAK_URL")"
    ask KEYCLOAK_ADMIN_USER "Master-realm admin user the API signs in with" "$(stored KEYCLOAK_ADMIN_USER admin)"
    ask_secret KEYCLOAK_ADMIN_PASSWORD "Its password" "$(stored KEYCLOAK_ADMIN_PASSWORD "")"
    ask KEYCLOAK_HEALTH_URL "Readiness URL of that Keycloak (empty = <url>/health/ready; 25+ answers on port 9000)" "$(stored KEYCLOAK_HEALTH_URL "")"
  fi

  ask BASEFYIO_DB_ADMIN_ROLE "Create a direct Postgres role with CREATEDB/CREATEROLE that bypasses PgBouncer" "$(stored BASEFYIO_DB_ADMIN_ROLE no)" "no yes"
  if [ "$BASEFYIO_DB_ADMIN_ROLE" = yes ]; then
    ask POSTGRES_APP_ADMIN_USER "Role name" "$(stored POSTGRES_APP_ADMIN_USER basefyio_app_admin)"
    ask_secret POSTGRES_APP_ADMIN_PASSWORD "Role password" "$(stored POSTGRES_APP_ADMIN_PASSWORD "$(gen_secret)")"
    ask POSTGRES_DIRECT_BIND "Interface Postgres listens on (127.0.0.1 = this host only)" "$(stored POSTGRES_DIRECT_BIND 127.0.0.1)"
    ask POSTGRES_DIRECT_PORT "Port Postgres listens on" "$(stored POSTGRES_DIRECT_PORT 5432)"
  fi

  ask BASEFYIO_PGBOUNCER_BIND "PgBouncer port: all interfaces, this host only, or not published" "$(stored BASEFYIO_PGBOUNCER_BIND all)" "all local closed"
  ask BASEFYIO_DOCSTORE "Run the document store for the Data Engine" "$(stored BASEFYIO_DOCSTORE yes)" "yes no"
  ask BASEFYIO_AI "AI features (hosted models, embeddings); off sends nothing to OpenAI, Anthropic or other providers" "$(stored BASEFYIO_AI "$( [ "$(env_get AI_ENABLED)" = false ] && echo off || echo on )")" "on off"

  local mail_default=resend; [ "$(env_get MAIL_TRANSPORT)" = smtp ] && mail_default=smtp
  ask BASEFYIO_MAIL "Platform mail: Resend-compatible HTTP API or an SMTP server" "$(stored BASEFYIO_MAIL "$mail_default")" "resend smtp"
  if [ "$BASEFYIO_MAIL" = smtp ]; then
    ask SMTP_HOST "SMTP server" "$(stored SMTP_HOST "")"
    ask SMTP_PORT "SMTP port" "$(stored SMTP_PORT 587)"
    ask SMTP_SECURE "Encryption: starttls (587), tls (465) or none (trusted relay only)" "$(stored SMTP_SECURE starttls)" "starttls tls none"
    ask SMTP_USER "SMTP user (empty = no login)" "$(stored SMTP_USER "")"
    if [ -n "$SMTP_USER" ]; then ask_secret SMTP_PASSWORD "SMTP password" "$(stored SMTP_PASSWORD "")"; fi
    ask MAIL_FROM "Sender, as Name <address>" "$(stored MAIL_FROM "$(stored RESEND_FROM_EMAIL "basefyio <noreply@localhost>")")"
    if [ "$BASEFYIO_KEYCLOAK" != external ]; then
      ask KEYCLOAK_REALM_SMTP "Let Keycloak's own mail (password reset, verification) use this server too" "$(stored KEYCLOAK_REALM_SMTP true)" "true false"
    fi
  fi

  ask BASEFYIO_OFFLINE "Is this host without internet access" "$(stored BASEFYIO_OFFLINE no)" "no yes"
  if [ "$BASEFYIO_OFFLINE" = yes ] && [ "$BASEFYIO_IMAGES" != bundle ]; then
    warn "an offline host cannot build or pull; images must already be loaded (scripts/load-images.sh) or come from a bundle"
  fi

  ask BASEFYIO_PIN_COMPONENTS "Pin component images (Keycloak, MinIO, Redis, …) to this release's tested versions" "$(stored BASEFYIO_PIN_COMPONENTS "$( [ "$EXISTING" = 1 ] && echo no || echo yes )")" "yes no"
}

# ── the release to run ────────────────────────────────────────────────────────
# A release other than this checkout: check it out and hand over to that
# release's own installer, so its compose files and questions are the ones used.
switch_release_if_needed() {
  [ "$BASEFYIO_VERSION" = current ] && return 0
  local here; here="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"
  [ "$here" = "$BASEFYIO_VERSION" ] && return 0
  [ "$DRY_RUN" = 1 ] && { log "would check out $BASEFYIO_VERSION and continue with its installer"; return 0; }
  ver_ge "$BASEFYIO_VERSION" "$MIN_VERSION" || die "$BASEFYIO_VERSION predates this installer (first release with it: $MIN_VERSION)"
  if ! git diff --quiet || ! git diff --cached --quiet; then
    die "this checkout has local changes to tracked files; commit or stash them before switching releases"
  fi
  if ! git rev-parse -q --verify "refs/tags/$BASEFYIO_VERSION" >/dev/null; then
    [ "$BASEFYIO_OFFLINE" = yes ] || git fetch --tags --quiet origin 2>/dev/null || warn "could not fetch tags"
  fi
  git rev-parse -q --verify "refs/tags/$BASEFYIO_VERSION" >/dev/null || die "release $BASEFYIO_VERSION is not known to this checkout"
  log "checking out $BASEFYIO_VERSION"
  git -c advice.detachedHead=false checkout --quiet "$BASEFYIO_VERSION"
  export BASEFYIO_RELEASE_LABEL="$BASEFYIO_VERSION" BASEFYIO_VERSION=current
  export BASEFYIO_NONINTERACTIVE="$NONINTERACTIVE"
  exec bash "$ROOT/scripts/install.sh" "${COMMAND}" ${INTERNAL_ROLE:+rollback-apply}
}

compose_files() {
  FILE_ARGS=(-f "$BASE_FILE")
  OVERLAYS=()
  case "$BASEFYIO_KEYCLOAK" in
    26) OVERLAYS+=(deploy/compose/keycloak-26.yml) ;;
    external) OVERLAYS+=(deploy/compose/keycloak-external.yml) ;;
  esac
  [ "$BASEFYIO_DB_ADMIN_ROLE" = yes ] && OVERLAYS+=(deploy/compose/postgres-direct.yml)
  case "$BASEFYIO_PGBOUNCER_BIND" in
    local) OVERLAYS+=(deploy/compose/pgbouncer-local.yml) ;;
    closed) OVERLAYS+=(deploy/compose/pgbouncer-closed.yml) ;;
  esac
  [ "$BASEFYIO_DOCSTORE" = no ] && OVERLAYS+=("deploy/compose/$BASEFYIO_BASE/no-docstore.yml")
  [ "$BASEFYIO_OFFLINE" = yes ] && OVERLAYS+=(deploy/compose/offline.yml)
  [ "$BASEFYIO_BASE" = prod ] && [ "$BASEFYIO_IMAGES" = build ] && OVERLAYS+=(deploy/compose/prod/build.yml)
  local extra
  for extra in ${BASEFYIO_EXTRA_COMPOSE:-}; do OVERLAYS+=("$extra"); done
  local o; for o in "${OVERLAYS[@]}"; do [ -f "$o" ] || die "missing compose overlay $o"; FILE_ARGS+=(-f "$o"); done
}

write_settings() {
  log "writing $ENV_FILE"
  if [ "$DRY_RUN" != 1 ] && [ -f "$ENV_FILE" ]; then cp -p "$ENV_FILE" "$ENV_FILE.bak-$(date -u +%Y%m%dT%H%M%SZ)"; fi
  local label="${BASEFYIO_RELEASE_LABEL:-v$(package_version)}"
  env_set BASEFYIO_VERSION "$label"
  env_set BASEFYIO_BASE "$BASEFYIO_BASE"
  env_set BASEFYIO_PROJECT "$PROJECT"
  local k
  for k in BASEFYIO_IMAGES BASEFYIO_KEYCLOAK BASEFYIO_DB_ADMIN_ROLE BASEFYIO_PGBOUNCER_BIND BASEFYIO_DOCSTORE \
           BASEFYIO_AI BASEFYIO_MAIL BASEFYIO_OFFLINE BASEFYIO_PIN_COMPONENTS; do env_set "$k" "${!k}"; done
  [ -n "${BASEFYIO_BUNDLE:-}" ] && env_set BASEFYIO_BUNDLE "$BASEFYIO_BUNDLE"
  env_set BASEFYIO_COMPOSE_FILES "${OVERLAYS[*]:-}"

  # The image tag the stack runs and reports on /api/health.
  if [ "$BASEFYIO_BASE" = prod ] && [ "$BASEFYIO_IMAGES" = pull ]; then
    # The release pipeline tags each deployed image with the commit it was built from.
    env_set IMAGE_TAG "$(git rev-parse --short=12 HEAD)"
  else
    env_set IMAGE_TAG "$label"
  fi

  case "$BASEFYIO_KEYCLOAK" in
    external)
      local k2; for k2 in KEYCLOAK_URL KEYCLOAK_PUBLIC_URL KEYCLOAK_ADMIN_USER KEYCLOAK_ADMIN_PASSWORD KEYCLOAK_HEALTH_URL; do env_set "$k2" "${!k2:-}"; done ;;
  esac

  if [ "$BASEFYIO_DB_ADMIN_ROLE" = yes ]; then
    for k in POSTGRES_APP_ADMIN_USER POSTGRES_APP_ADMIN_PASSWORD POSTGRES_DIRECT_BIND POSTGRES_DIRECT_PORT; do env_set "$k" "${!k}"; done
  fi

  if [ "$BASEFYIO_DOCSTORE" = no ]; then
    case "$(env_get DATA_ENGINE_PROVIDER)" in mongodb|nosql|couchdb|"") env_set DATA_ENGINE_PROVIDER postgres ;; esac
  fi

  if [ "$BASEFYIO_AI" = off ]; then env_set AI_ENABLED false; else env_set AI_ENABLED true; fi

  if [ "$BASEFYIO_MAIL" = smtp ]; then
    env_set MAIL_TRANSPORT smtp
    for k in SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER MAIL_FROM; do env_set "$k" "${!k:-}"; done
    [ -n "${SMTP_PASSWORD:-}" ] && env_set SMTP_PASSWORD "$SMTP_PASSWORD"
    env_set KEYCLOAK_REALM_SMTP "${KEYCLOAK_REALM_SMTP:-false}"
  else
    env_set MAIL_TRANSPORT resend
    env_set KEYCLOAK_REALM_SMTP false
  fi

  pin_components
}

# Pin component images to deploy/components.env — never over a value the
# operator set, and never MinIO on an existing installation (its data stays
# with the server build that wrote it unless MINIO_IMAGE is set by hand).
pin_components() {
  # shellcheck disable=SC1091
  ( set -a; . deploy/components.env; set +a
    printf '%s\n' "$KEYCLOAK_IMAGE_24|$KEYCLOAK_IMAGE_26|$POSTGRES_IMAGE|$MINIO_IMAGE|$MINIO_IMAGE_PUBLIC|$PGBOUNCER_IMAGE|$REDIS_IMAGE|$RABBITMQ_IMAGE|$MONGO_IMAGE|$TRAEFIK_IMAGE|$CURL_IMAGE|$COUCHBASE_IMAGE|$COUCHDB_IMAGE"
  ) > /tmp/basefyio-components.$$
  IFS='|' read -r C_KC24 C_KC26 C_PG C_MINIO C_MINIO_PUBLIC C_PGB C_REDIS C_RMQ C_MONGO C_TRAEFIK C_CURL C_CB C_COUCH < /tmp/basefyio-components.$$
  rm -f /tmp/basefyio-components.$$

  # Keycloak follows the chosen version, always: the 26 overlay must never run a 24 image or the reverse.
  case "$BASEFYIO_KEYCLOAK" in
    26) env_set KEYCLOAK_IMAGE "$C_KC26" ;;
    24) if [ "$BASEFYIO_PIN_COMPONENTS" = yes ]; then env_set KEYCLOAK_IMAGE "$C_KC24"
        else case "$(env_get KEYCLOAK_IMAGE)" in *:26*) env_unset KEYCLOAK_IMAGE ;; esac; fi ;;
  esac

  [ "$BASEFYIO_PIN_COMPONENTS" = yes ] || return 0
  pin() { [ -n "$(env_get "$1")" ] || env_set "$1" "$2"; }
  [ "$BASEFYIO_BASE" = selfhost ] && pin POSTGRES_IMAGE "$C_PG"
  pin PGBOUNCER_IMAGE "$C_PGB"
  pin REDIS_IMAGE "$C_REDIS"
  pin RABBITMQ_IMAGE "$C_RMQ"
  pin TRAEFIK_IMAGE "$C_TRAEFIK"
  if [ "$BASEFYIO_BASE" = prod ]; then pin MONGO_IMAGE "$C_MONGO"; else pin CURL_IMAGE "$C_CURL"; pin COUCHBASE_IMAGE "$C_CB"; pin COUCHDB_IMAGE "$C_COUCH"; fi
  if [ "$EXISTING" = 0 ] && [ -z "$(env_get MINIO_IMAGE)" ]; then
    if [ "$BASEFYIO_IMAGES" = pull ]; then env_set MINIO_IMAGE "$C_MINIO"; else env_set MINIO_IMAGE "$C_MINIO_PUBLIC"; fi
  fi
}

write_wrapper() {
  local wrapper="$ROOT/basefyio"
  [ "$DRY_RUN" = 1 ] && { log "would write ./basefyio (docker compose with this installation's files)"; return 0; }
  {
    printf '#!/usr/bin/env bash\n'
    printf '# Written by scripts/install.sh — docker compose with this installation'"'"'s files. Re-run the installer to change it.\n'
    printf 'cd "$(dirname "$0")"\n'
    printf 'exec docker compose -p %q --env-file %q' "$PROJECT" "$ENV_FILE"
    local a; for a in "${FILE_ARGS[@]}"; do printf ' %q' "$a"; done
    printf ' "$@"\n'
  } > "$wrapper"
  chmod +x "$wrapper"
  ok "./basefyio runs docker compose for this installation (./basefyio ps, ./basefyio logs -f platform-api)"
}

# ── backups ───────────────────────────────────────────────────────────────────
backup_database() {
  local label="$1"
  local dir; dir="$ROOT/backups/$(date -u +%Y%m%dT%H%M%SZ)-$label"
  stack_running || { warn "the stack is not running; no database backup taken"; LAST_BACKUP=""; return 0; }
  local pg_user; pg_user="$(env_get POSTGRES_USER)"; pg_user="${pg_user:-kolaybase}"
  local size_kb free_kb
  size_kb="$(dc exec -T postgres psql -U "$pg_user" -d postgres -Atc 'select coalesce(sum(pg_database_size(datname)),0)/1024 from pg_database' 2>/dev/null | tr -d '[:space:]')" || size_kb=0
  mkdir -p "$ROOT/backups"
  free_kb="$(df -Pk "$ROOT/backups" | awk 'NR==2{print $4}')"
  if [ "${size_kb:-0}" -gt 0 ] && [ "$free_kb" -lt "$size_kb" ]; then
    die "not enough free disk for the backup (${free_kb} KB free, databases hold ${size_kb} KB); free space or point backups/ elsewhere"
  fi
  log "backing up every database to $dir (this may take a while)"
  [ "$DRY_RUN" = 1 ] && { LAST_BACKUP="$dir"; return 0; }
  mkdir -p "$dir"
  cp -p "$ENV_FILE" "$dir/env"
  printf '%s\n' "${FILE_ARGS[@]}" > "$dir/compose-files"
  printf '%s\n' "$(env_get BASEFYIO_VERSION)" > "$dir/version"
  git rev-parse HEAD > "$dir/commit"
  dc images --format json > "$dir/images.json" 2>/dev/null || dc images > "$dir/images.txt" 2>/dev/null || true
  dc exec -T postgres pg_dumpall -U "$pg_user" --clean --if-exists | gzip -c > "$dir/cluster.sql.gz"
  gzip -t "$dir/cluster.sql.gz" || die "the backup in $dir is not readable; stopping before anything changes"
  [ "$(gzip -cd "$dir/cluster.sql.gz" | head -c 100000 | wc -c)" -gt 1000 ] || die "the backup in $dir is empty; stopping before anything changes"
  ok "database backup: $dir/cluster.sql.gz ($(du -h "$dir/cluster.sql.gz" | cut -f1))"
  LAST_BACKUP="$dir"
}

# Keep a copy of the images that run now, so a rollback needs no build or network.
keep_current_images() {
  local label="$1" svc img
  for svc in platform-api admin-ui website; do
    img="$(dc images -q "$svc" 2>/dev/null | head -n1)"
    [ -n "$img" ] || continue
    if docker tag "$img" "basefyio-rollback/$svc:$label" 2>/dev/null; then ok "kept $svc as basefyio-rollback/$svc:$label"; fi
  done
}

# ── images ────────────────────────────────────────────────────────────────────
prepare_images() {
  case "$BASEFYIO_IMAGES" in
    bundle)
      [ -f "${BASEFYIO_BUNDLE:-}" ] || die "bundle not found: ${BASEFYIO_BUNDLE:-unset}"
      log "loading images from $BASEFYIO_BUNDLE"
      [ "$DRY_RUN" = 1 ] || bash scripts/load-images.sh "$BASEFYIO_BUNDLE" ;;
    pull)
      log "pulling images"
      [ "$DRY_RUN" = 1 ] || dc pull --ignore-buildable ;;
    build)
      [ "$BASEFYIO_OFFLINE" = yes ] && warn "building offline needs every base image and npm package already cached"
      log "building the platform images from this checkout (several minutes)"
      [ "$DRY_RUN" = 1 ] || dc build
      [ "$DRY_RUN" = 1 ] || [ "$BASEFYIO_OFFLINE" = yes ] || dc pull --ignore-buildable --quiet || warn "some component images could not be pulled"
      ;;
  esac
}

# ── start and wait ────────────────────────────────────────────────────────────
start_stack() {
  log "starting the stack"
  [ "$DRY_RUN" = 1 ] && return 0
  # Services an option switched off keep their volumes; only their containers go.
  if [ "$BASEFYIO_DOCSTORE" = no ]; then
    local s; for s in mongodb nosql nosql-init; do
      dc --profile docstore rm -sf "$s" >/dev/null 2>&1 || true
    done
  fi
  if [ "$BASEFYIO_KEYCLOAK" = external ]; then
    dc --profile bundled-keycloak rm -sf keycloak >/dev/null 2>&1 || true
  fi
  local pull_flag=(); { [ "$BASEFYIO_OFFLINE" = yes ] || [ "$BASEFYIO_IMAGES" = bundle ]; } && pull_flag=(--pull never)
  dc up -d --remove-orphans "${pull_flag[@]}"
}

api_ready() {
  dc exec -T platform-api node -e "fetch('http://127.0.0.1:4000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}

wait_healthy() {
  [ "$DRY_RUN" = 1 ] && return 0
  log "waiting for the API to answer (up to $((HEALTH_TIMEOUT_S / 60)) minutes)"
  local waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT_S" ]; do
    if api_ready; then ok "the API is ready"; return 0; fi
    sleep 10; waited=$((waited + 10))
  done
  warn "the API did not become ready in time"
  dc ps || true
  dc logs --tail 60 platform-api 2>/dev/null || true
  return 1
}

create_db_admin_role() {
  [ "$BASEFYIO_DB_ADMIN_ROLE" = yes ] || return 0
  [ "$DRY_RUN" = 1 ] && { log "would create the Postgres role $POSTGRES_APP_ADMIN_USER"; return 0; }
  local pg_user; pg_user="$(env_get POSTGRES_USER)"; pg_user="${pg_user:-kolaybase}"
  log "creating the Postgres role $POSTGRES_APP_ADMIN_USER (CREATEDB, CREATEROLE, not a superuser)"
  dc exec -T postgres psql -v ON_ERROR_STOP=1 -U "$pg_user" -d postgres \
    -v role="$POSTGRES_APP_ADMIN_USER" -v pw="$POSTGRES_APP_ADMIN_PASSWORD" <<'SQL' >/dev/null
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L CREATEDB CREATEROLE NOSUPERUSER', :'role', :'pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L CREATEDB CREATEROLE NOSUPERUSER', :'role', :'pw') \gexec
SQL
  ok "role $POSTGRES_APP_ADMIN_USER: connect to ${POSTGRES_DIRECT_BIND}:${POSTGRES_DIRECT_PORT} directly (not through PgBouncer)"
}

print_manifest() {
  # shellcheck disable=SC1091
  ( set -a; . deploy/components.env; set +a
    printf '\n\033[1mRelease %s\033[0m  (database changes since the previous release: %s)\n' "${BASEFYIO_RELEASE_LABEL:-v$(package_version)}" "$BASEFYIO_DB_CHANGES"
    printf '  %-12s %-8s %s\n' "Component" "Default" "Supported / pinned"
    printf '  %-12s %-8s %s\n' "Keycloak" "$KEYCLOAK_DEFAULT" "$KEYCLOAK_SUPPORTED"
    printf '  %-12s %-8s %s\n' "PostgreSQL" "16" "$POSTGRES_IMAGE (self-host); docker/postgres (production-shaped)"
    printf '  %-12s %-8s %s\n' "MinIO" "" "$MINIO_IMAGE | $MINIO_IMAGE_PUBLIC"
    printf '  %-12s %-8s %s\n' "PgBouncer" "" "$PGBOUNCER_IMAGE"
    printf '  %-12s %-8s %s\n' "Redis" "" "$REDIS_IMAGE"
    printf '  %-12s %-8s %s\n' "RabbitMQ" "" "$RABBITMQ_IMAGE"
    printf '  %-12s %-8s %s\n' "MongoDB" "" "$MONGO_IMAGE"
    printf '  %-12s %-8s %s\n' "Traefik" "" "$TRAEFIK_IMAGE"
  )
}

print_summary() {
  printf '\n\033[1mbasefyio %s\033[0m — %s, project "%s", env %s\n' "$(env_get BASEFYIO_VERSION)" "$BASE_FILE" "$PROJECT" "$ENV_FILE"
  printf '  Keycloak: %s · PgBouncer: %s · document store: %s · AI: %s · mail: %s · direct Postgres role: %s\n' \
    "$BASEFYIO_KEYCLOAK" "$BASEFYIO_PGBOUNCER_BIND" "$BASEFYIO_DOCSTORE" "$BASEFYIO_AI" "$BASEFYIO_MAIL" "$BASEFYIO_DB_ADMIN_ROLE"
  [ -n "${LAST_BACKUP:-}" ] && printf '  Backup taken before this change: %s\n' "$LAST_BACKUP"
  print_manifest
}

# ── commands ──────────────────────────────────────────────────────────────────
setup_common() {
  [ -n "$ANSWERS_FILE" ] && load_answers "$ANSWERS_FILE"
  need_tools
  resolve_base_and_env
  guard_cloud_host
  local found; found="$(detect_project)"
  if [ -n "${BASEFYIO_PROJECT:-}" ]; then PROJECT="$BASEFYIO_PROJECT"
  elif [ -n "$(env_get BASEFYIO_PROJECT)" ]; then PROJECT="$(env_get BASEFYIO_PROJECT)"
  elif [ "$(printf '%s\n' "$found" | grep -c .)" = 1 ]; then PROJECT="$found"
  elif [ -n "$found" ]; then die "several compose projects run from this directory ($found); set BASEFYIO_PROJECT"
  elif [ -n "$(env_get COMPOSE_PROJECT_NAME)" ]; then PROJECT="$(env_get COMPOSE_PROJECT_NAME)"
  elif [ "$BASEFYIO_BASE" = prod ]; then PROJECT="$(basename "$ROOT" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
  else PROJECT=basefyio; fi
  read_previous_answers
}

cmd_install() {
  setup_common
  ask_everything
  switch_release_if_needed

  # Keycloak only moves forward: 26 migrates its database and 24 cannot read it back.
  if [ "${PREV_KEYCLOAK:-}" = 26 ] && [ "$BASEFYIO_KEYCLOAK" = 24 ]; then
    die "Keycloak cannot go back from 26 to 24; restore a backup taken before the switch (scripts/install.sh restore <dir>)"
  fi
  compose_files
  if [ "$EXISTING" = 1 ] && [ "$BASEFYIO_KEYCLOAK" = 26 ] && [ "${PREV_KEYCLOAK:-24}" = 24 ] && [ "$INTERNAL_ROLE" != rollback-apply ]; then
    warn "moving Keycloak from 24 to 26 is one-way: it migrates its database, and every user signs in again"
    confirm "A database backup is taken first." BASEFYIO_CONFIRM_KEYCLOAK_26
    [ -n "${BASEFYIO_UPGRADE_BACKUP:-}" ] || backup_database "before-keycloak-26"
  fi

  new_env_file
  write_settings
  write_wrapper
  if [ "${BASEFYIO_SKIP_START:-0}" = 1 ]; then
    ok "settings written; images and containers left alone (BASEFYIO_SKIP_START=1)"
    print_summary
    return 0
  fi
  [ "$INTERNAL_ROLE" = rollback-apply ] || prepare_images
  start_stack
  if ! wait_healthy; then
    if [ -n "${BASEFYIO_UPGRADE_FROM:-}" ] && [ "$INTERNAL_ROLE" != rollback-apply ]; then
      warn "the new release did not come up; rolling back to $BASEFYIO_UPGRADE_FROM"
      roll_back_to "$BASEFYIO_UPGRADE_FROM" "${BASEFYIO_UPGRADE_BACKUP:-}" "${BASEFYIO_UPGRADE_FROM_COMMIT:-}"
    fi
    die "the stack is not healthy; nothing else was changed (see the logs above)"
  fi
  create_db_admin_role
  # The images this release runs, kept for a later rollback.
  [ "$DRY_RUN" = 1 ] || keep_current_images "$(env_get BASEFYIO_VERSION)"
  LAST_BACKUP="${BASEFYIO_UPGRADE_BACKUP:-${LAST_BACKUP:-}}"
  print_summary
}

cmd_upgrade() {
  setup_common
  [ "$EXISTING" = 1 ] || die "no installation found ($ENV_FILE is missing); run scripts/install.sh first"
  local current; current="$(env_get BASEFYIO_VERSION)"
  [ -n "$current" ] || die "this installation was not made by the installer; run scripts/install.sh once to adopt it"
  [ "${BASEFYIO_OFFLINE:-$(env_get BASEFYIO_OFFLINE)}" = yes ] || git fetch --tags --quiet origin 2>/dev/null || warn "could not fetch release tags"
  local newer; newer="$(release_tags | while read -r t; do ver_ge "$t" "$current" && [ "$t" != "$current" ] && echo "$t"; done || true)"
  [ -n "$newer" ] || { ok "already on the newest release ($current)"; exit 0; }
  can_prompt && printf 'Installed: %s · newer releases: %s\n' "$current" "$(printf '%s ' $newer)" > /dev/tty
  local target="${BASEFYIO_TARGET_VERSION:-}"
  ask target "Upgrade to" "$(printf '%s\n' "$newer" | head -n1)"
  ver_ge "$target" "$current" || die "$target is older than $current; use scripts/install.sh rollback"

  # Everything the installed release needs to run again, before anything moves.
  local k; for k in $(grep -oE '^BASEFYIO_[A-Z_]+' "$ENV_FILE" | sort -u); do
    [ -n "${!k:-}" ] || export "$k=$(env_get "$k")"
  done
  compose_files
  backup_database "$current"
  keep_current_images "$current"
  env_set BASEFYIO_PREVIOUS_VERSION "$current"
  env_set BASEFYIO_LAST_BACKUP "${LAST_BACKUP:-}"
  BASEFYIO_UPGRADE_FROM_COMMIT="$(git rev-parse HEAD)"
  export BASEFYIO_UPGRADE_FROM="$current" BASEFYIO_UPGRADE_FROM_COMMIT BASEFYIO_UPGRADE_BACKUP="${LAST_BACKUP:-}"
  export BASEFYIO_VERSION="$target"
  log "upgrading $current → $target"
  COMMAND=install
  switch_release_if_needed
  cmd_install
}

# Return to a release: its checkout, its env file, its images.
roll_back_to() {
  local version="$1" backup="$2" commit="$3"
  [ "$DRY_RUN" = 1 ] && { log "would roll back to $version"; return 0; }
  if [ -n "$backup" ] && [ -f "$backup/env" ]; then cp -p "$backup/env" "$ENV_FILE"; fi
  local svc
  for svc in platform-api admin-ui website; do
    docker image inspect "basefyio-rollback/$svc:$version" >/dev/null 2>&1 || continue
    # Point the name the compose file uses back at the kept image.
    local want; want="$(dc config --images "$svc" 2>/dev/null | head -n1)"
    [ -n "$want" ] && docker tag "basefyio-rollback/$svc:$version" "$want"
  done
  git -c advice.detachedHead=false checkout --quiet "${commit:-$version}"
  export BASEFYIO_NONINTERACTIVE=1 BASEFYIO_VERSION=current BASEFYIO_RELEASE_LABEL="$version"
  unset BASEFYIO_UPGRADE_FROM BASEFYIO_UPGRADE_BACKUP BASEFYIO_UPGRADE_FROM_COMMIT
  bash "$ROOT/scripts/install.sh" rollback-apply || true
  if [ -n "$backup" ] && [ -f "$backup/env" ] && [ "$(env_get BASEFYIO_KEYCLOAK "$backup/env")" != "$(env_get BASEFYIO_KEYCLOAK)" ]; then
    warn "Keycloak changed version during the failed upgrade; its database may need the backup: scripts/install.sh restore $backup"
  fi
}

cmd_rollback() {
  setup_common
  local prev backup
  prev="$(env_get BASEFYIO_PREVIOUS_VERSION)"; backup="$(env_get BASEFYIO_LAST_BACKUP)"
  [ -n "$prev" ] || die "no previous release recorded; nothing to roll back to"
  confirm "Roll back from $(env_get BASEFYIO_VERSION) to $prev (application images and settings; the database is kept)." BASEFYIO_CONFIRM_ROLLBACK
  compose_files
  roll_back_to "$prev" "$backup" "$( [ -f "$backup/commit" ] && cat "$backup/commit" || echo "$prev")"
  if [ -n "$backup" ] && [ "$(env_get BASEFYIO_KEYCLOAK "$backup/env" 2>/dev/null)" != "$BASEFYIO_KEYCLOAK" ]; then
    warn "the release you left ran a different Keycloak; restore the database backup to match: scripts/install.sh restore $backup"
  fi
}

cmd_restore() {
  [ -n "$RESTORE_DIR" ] && [ -f "$RESTORE_DIR/cluster.sql.gz" ] || die "usage: scripts/install.sh restore <backup-dir> (a directory with cluster.sql.gz)"
  setup_common
  [ -n "$(env_get BASEFYIO_COMPOSE_FILES)" ] || true
  export BASEFYIO_KEYCLOAK="${BASEFYIO_KEYCLOAK:-$(env_get BASEFYIO_KEYCLOAK)}"
  local k; for k in BASEFYIO_DB_ADMIN_ROLE BASEFYIO_PGBOUNCER_BIND BASEFYIO_DOCSTORE BASEFYIO_OFFLINE BASEFYIO_IMAGES; do
    [ -n "${!k:-}" ] || export "$k=$(env_get "$k")"
  done
  compose_files
  confirm "This REPLACES every database (platform, Keycloak, every project) with the backup in $RESTORE_DIR. Data written since that backup is lost." BASEFYIO_CONFIRM_RESTORE
  local pg_user; pg_user="$(env_get POSTGRES_USER)"; pg_user="${pg_user:-kolaybase}"
  log "stopping everything except Postgres"
  local services; services="$(dc config --services | grep -vx postgres || true)"
  # shellcheck disable=SC2086
  dc stop $services
  log "restoring $RESTORE_DIR/cluster.sql.gz"
  gzip -cd "$RESTORE_DIR/cluster.sql.gz" | dc exec -T postgres psql -U "$pg_user" -d postgres -q >/dev/null 2>"$RESTORE_DIR/restore.log" || true
  ok "restore finished; messages in $RESTORE_DIR/restore.log"
  dc up -d
  wait_healthy || die "the stack is not healthy after the restore; see the logs above and $RESTORE_DIR/restore.log"
}

cmd_status() {
  setup_common
  local k; for k in BASEFYIO_KEYCLOAK BASEFYIO_DB_ADMIN_ROLE BASEFYIO_PGBOUNCER_BIND BASEFYIO_DOCSTORE BASEFYIO_OFFLINE BASEFYIO_IMAGES BASEFYIO_AI BASEFYIO_MAIL; do
    export "$k=$(env_get "$k")"
  done
  compose_files
  printf 'release %s (previous: %s, last backup: %s)\n' "$(env_get BASEFYIO_VERSION)" "$(env_get BASEFYIO_PREVIOUS_VERSION)" "$(env_get BASEFYIO_LAST_BACKUP)"
  dc ps
  if api_ready; then ok "API ready"; else warn "API not ready"; fi
}

case "$COMMAND" in
  install) cmd_install ;;
  upgrade) cmd_upgrade ;;
  rollback) cmd_rollback ;;
  restore) cmd_restore ;;
  status) cmd_status ;;
esac
