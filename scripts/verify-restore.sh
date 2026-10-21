#!/usr/bin/env bash
# Restore drill from the host: rebuild a basefyio backup archive into a
# throwaway database on the production cluster, count its tables, compare the
# counts with the ones recorded at dump time, and drop the database again.
#
# The platform runs the same drill on its own every Sunday (see
# docs/BACKUP_OFFSITE_AND_VERIFICATION.md); this script is for an operator who
# wants to prove a specific archive — or the newest one — right now, from a
# shell, with nothing but docker, unzip and (optionally) jq on the host.
#
# Usage:
#   DEPLOY_DIR=/path/to/deployment scripts/verify-restore.sh <archive.zip>
#   DEPLOY_DIR=/path/to/deployment scripts/verify-restore.sh --latest <projectId>
#
# --latest fetches the newest nightly archive of the project from the local
# MinIO through the minio/mc image (same network conventions as
# backup-offsite.sh). An encrypted archive (*.enc) is decrypted first with
# scripts/backup-decrypt.mjs, which needs BACKUP_ENC_KEY and node on the host.
#
# Exit codes: 0 PASSED (psql clean, every recorded table present with the same
# row count), 1 FAILED or could not run. The throwaway database is dropped on
# every exit path.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-}"
if [ -z "$DEPLOY_DIR" ]; then
  echo "DEPLOY_DIR is not set. Point it at the directory holding docker-compose.prod.yml." >&2
  exit 1
fi
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env.production}"
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.production"
DOCKER_NETWORK="${DOCKER_NETWORK:-kolaybase_web}"
MC_IMAGE="${MC_IMAGE:-minio/mc}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

val() {
  local name="$1" v="${!1:-}"
  if [ -n "$v" ]; then printf '%s' "$v"; return; fi
  if [ -f "$ENV_FILE" ]; then
    grep -E "^${name}=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
  fi
}

PG_USER="$(val POSTGRES_USER)"; PG_USER="${PG_USER:-postgres}"
command -v unzip >/dev/null 2>&1 || { echo "unzip is not installed." >&2; exit 1; }

cd "$DEPLOY_DIR"

work="$(mktemp -d /tmp/bf-verify-XXXXXX)"
verify_db=""
cleanup() {
  if [ -n "$verify_db" ]; then
    $COMPOSE exec -T postgres psql -U "$PG_USER" -d postgres -qAt \
      -c "DROP DATABASE IF EXISTS \"$verify_db\" WITH (FORCE)" >/dev/null 2>&1 || \
      echo "WARNING: could not drop $verify_db — drop it by hand" >&2
  fi
  rm -rf "$work"
}
trap cleanup EXIT

# ── 1. Obtain the archive ────────────────────────────────────────────────────
archive=""
if [ "${1:-}" = "--latest" ]; then
  project_id="${2:-}"
  [ -n "$project_id" ] || { echo "usage: $0 --latest <projectId>" >&2; exit 1; }
  MINIO_USER="$(val MINIO_ROOT_USER)"; MINIO_PASS="$(val MINIO_ROOT_PASSWORD)"
  [ -n "$MINIO_USER" ] && [ -n "$MINIO_PASS" ] || { echo "MINIO_ROOT_USER/PASSWORD not found." >&2; exit 1; }
  mc() {
    docker run --rm -i --network "$DOCKER_NETWORK" \
      -e "MC_HOST_local=http://${MINIO_USER}:${MINIO_PASS}@minio:9000" "$MC_IMAGE" "$@"
  }
  # Object keys carry the job id and a timestamp; the newest sorts last.
  key="$(mc ls "local/bf-platform-auto-backups/${project_id}/" 2>/dev/null | awk '{print $NF}' | sort | tail -1)"
  [ -n "$key" ] || { echo "No nightly archive found for project $project_id." >&2; exit 1; }
  echo "==> fetching bf-platform-auto-backups/${project_id}/${key}"
  archive="$work/$key"
  mc cat "local/bf-platform-auto-backups/${project_id}/${key}" > "$archive"
else
  archive="${1:-}"
  [ -n "$archive" ] && [ -f "$archive" ] || { echo "usage: $0 <archive.zip> | --latest <projectId>" >&2; exit 1; }
fi

case "$archive" in
  *.enc)
    command -v node >/dev/null 2>&1 || { echo "node is needed to decrypt an encrypted archive." >&2; exit 1; }
    [ -n "${BACKUP_ENC_KEY:-}" ] || BACKUP_ENC_KEY="$(val BACKUP_ENC_KEY)"
    [ -n "${BACKUP_ENC_KEY:-}" ] || { echo "BACKUP_ENC_KEY is required for an encrypted archive." >&2; exit 1; }
    echo "==> decrypting archive"
    BACKUP_ENC_KEY="$BACKUP_ENC_KEY" node "$SCRIPT_DIR/backup-decrypt.mjs" "$archive" "$work/archive.zip"
    archive="$work/archive.zip"
    ;;
esac

# ── 2. Extract only what the drill needs ─────────────────────────────────────
echo "==> extracting database/dump.sql"
unzip -q -o "$archive" 'database/dump.sql' 'database/tables.json' -d "$work/x" 2>/dev/null || true
dump="$work/x/database/dump.sql"
counts="$work/x/database/tables.json"
[ -f "$dump" ] || { echo "FAILED: the archive has no database/dump.sql" >&2; exit 1; }

# ── 3. Throwaway database ────────────────────────────────────────────────────
verify_db="bfverify_$(date +%s)_$(head -c 3 /dev/urandom | od -An -tx1 | tr -d ' \n')"
echo "==> creating $verify_db"
$COMPOSE exec -T postgres psql -U "$PG_USER" -d postgres -qAt \
  -c "CREATE DATABASE \"$verify_db\" TEMPLATE template0 ENCODING 'UTF8'" >/dev/null

# ── 4. Replay the dump the way the dashboard restore does ────────────────────
echo "==> replaying dump ($(du -h "$dump" | cut -f1))"
$COMPOSE exec -T postgres psql -U "$PG_USER" -d "$verify_db" -q -v ON_ERROR_STOP=0 \
  < "$dump" > /dev/null 2> "$work/psql.err" || true
errors=$(grep -cE '^(psql:)?.*ERROR:' "$work/psql.err" || true)
if [ "$errors" -gt 0 ]; then
  echo "    psql reported $errors error line(s); first few:"
  grep -E 'ERROR:' "$work/psql.err" | head -5 | sed 's/^/      /'
fi

# ── 5. Count the restored tables ─────────────────────────────────────────────
echo "==> counting tables"
$COMPOSE exec -T postgres psql -U "$PG_USER" -d "$verify_db" -qAt -F $'\t' <<'SQL' > "$work/actual.tsv"
select n.nspname, c.relname,
       (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r','p') and not c.relispartition
  and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg\_toast%'
order by 1, 2;
SQL
restored=$(grep -c . "$work/actual.tsv" || true)
echo "    $restored table(s) restored"

# ── 6. Compare with the counts recorded at dump time ─────────────────────────
mismatches=0; missing=0; compared=0
if [ -f "$counts" ] && command -v jq >/dev/null 2>&1; then
  while IFS=$'\t' read -r schema table expected; do
    actual=$(awk -F'\t' -v s="$schema" -v t="$table" '$1==s && $2==t {print $3}' "$work/actual.tsv")
    if [ -z "$actual" ]; then
      missing=$((missing + 1)); echo "    MISSING   $schema.$table"
    elif [ "$expected" != "null" ]; then
      compared=$((compared + 1))
      if [ "$expected" != "$actual" ]; then
        mismatches=$((mismatches + 1)); echo "    MISMATCH  $schema.$table expected $expected, got $actual"
      fi
    fi
  done < <(jq -r '.tables[] | [.schema, .table, (.rows // "null")] | @tsv' "$counts")
  echo "    $compared count(s) compared, $missing missing, $mismatches mismatched"
elif [ -f "$counts" ]; then
  echo "    tables.json present but jq is not installed — counts not compared"
else
  echo "    no dump-time counts in this archive (older backup) — only table presence checked"
fi

# ── 7. Verdict ───────────────────────────────────────────────────────────────
if [ "$errors" -eq 0 ] && [ "$missing" -eq 0 ] && [ "$mismatches" -eq 0 ] && [ "$restored" -gt 0 ]; then
  echo "PASSED: the archive restores cleanly ($restored tables)"
  exit 0
fi
echo "FAILED: errors=$errors missing=$missing mismatches=$mismatches restored=$restored" >&2
exit 1
