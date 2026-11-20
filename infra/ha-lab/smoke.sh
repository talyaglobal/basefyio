#!/usr/bin/env bash
# Stage 0 smoke test for the HA lab (infra/ha-lab). Needs a running lab
# (./lab.sh up) with the original roles. It:
#   1. writes on the primary through pg-rw and through PgBouncer;
#   2. reads the rows on the replica through pg-ro and checks it is read-only;
#   3. logs in to Keycloak and records its container start time;
#   4. promotes the standby (./lab.sh promote; SMOKE_MODE=--crash kills the
#      primary instead of a clean stop);
#   5. writes again through pg-rw and PgBouncer, finds every earlier row on
#      the new primary;
#   6. shows Keycloak still answers without a restart: same container start,
#      same restart count, health ready, the pre-promotion session refreshes,
#      a new login works and an admin write (create user) reaches the new
#      primary.
# Exit 0 only when every check passes. Leaves the lab promoted; run
# ./lab.sh failback afterwards.
set -euo pipefail
DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lab.sh
. "$DIR/lab.sh"
guard
ensure_state

KC="http://127.0.0.1:${LAB_KEYCLOAK_PORT:-18080}"
KC_CONTAINER="${PROJECT}-keycloak-1"
TOKEN_ID="smoke-$(date +%s)-$$"
FAILS=0
pass() { printf '\033[1;32m  PASS\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m  FAIL\033[0m %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # description command...
  local what=$1
  shift
  if "$@"; then pass "$what"; else fail "$what"; fi
}
json_field() { sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p"; }

kc_login() {
  curl -fsS -m 10 "$KC/realms/master/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=admin-cli -d username=admin \
    --data-urlencode "password=$LAB_KC_ADMIN_PASSWORD"
}
kc_refresh() {
  curl -fsS -m 10 "$KC/realms/master/protocol/openid-connect/token" \
    -d grant_type=refresh_token -d client_id=admin-cli --data-urlencode "refresh_token=$1"
}
kc_create_user() { # access_token username → HTTP status
  curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST "$KC/admin/realms/master/users" \
    -H "Authorization: Bearer $1" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$2\",\"enabled\":true}"
}
kc_started() { docker inspect -f '{{.State.StartedAt}}|{{.RestartCount}}|{{.State.Running}}' "$KC_CONTAINER"; }

insert_row() { # host phase → node that took the write
  q "$1" -d labdb -c "insert into smoke(token, phase, node) values ('$TOKEN_ID', '$2', current_setting('cluster_name')) returning node"
}
count_rows() { q "$1" -d labdb -c "select count(*) from smoke where token = '$TOKEN_ID'"; }
rows_visible() { [ "$(count_rows "$1" 2>/dev/null)" = "$2" ]; }
wait_soft() { # timeout_s command... (like wait_until, but returns instead of exiting)
  local t=$1 i
  shift
  for ((i = 0; i < t; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
retry_insert() { # host phase timeout → prints "node attempts seconds"
  local host=$1 phase=$2 t=$3 i node t0
  t0=$(date +%s)
  for ((i = 1; i <= t; i++)); do
    if node=$(insert_row "$host" "$phase" 2>/dev/null); then
      echo "$node $i $(($(date +%s) - t0))"
      return 0
    fi
    sleep 1
  done
  return 1
}

echo "== preflight"
[ "$(role_of pg-primary)" = primary ] || die "pg-primary is not the primary; run ./lab.sh failback (or down + up) first"
[ "$(role_of pg-replica)" = replica ] || die "pg-replica is not a standby"
is_streaming pg-replica || die "pg-replica is not streaming"
keycloak_ready || die "Keycloak is not ready"

echo "== 1. write on the primary"
q pg-rw -d labdb -c "create table if not exists smoke (id bigserial primary key, token text not null, phase text not null, node text not null, at timestamptz not null default now())"
n=$(insert_row pg-rw before-rw)
check "write through pg-rw landed on pg-primary (got $n)" [ "$n" = pg-primary ]
n=$(insert_row pgbouncer before-pgbouncer)
check "write through PgBouncer (6432 → pg-rw) landed on pg-primary (got $n)" [ "$n" = pg-primary ]

echo "== 2. read on the replica"
ro=$(q pg-ro -d labdb -c "select current_setting('cluster_name') || '|' || pg_is_in_recovery()")
check "pg-ro routes to the standby (got $ro)" [ "$ro" = "pg-replica|t" ]
if wait_soft 15 rows_visible pg-ro 2; then
  pass "both rows are readable on the replica through pg-ro"
else
  fail "rows did not reach the replica within 15 s"
fi
if q pg-ro -d labdb -c "insert into smoke(token, phase, node) values ('$TOKEN_ID', 'must-fail', 'x')" >/dev/null 2>&1; then
  fail "the replica accepted a write"
else
  pass "the replica refuses writes (read-only transaction)"
fi

echo "== 3. Keycloak before the promotion"
kc_before=$(kc_started)
login=$(kc_login) || die "Keycloak login failed before the promotion"
refresh_token=$(printf '%s' "$login" | json_field refresh_token)
[ -n "$refresh_token" ] || die "no refresh token from Keycloak"
pass "admin login works (container ${kc_before})"

echo "== 4. promote"
cmd_promote "${SMOKE_MODE:-clean}"

echo "== 5. writes after the promotion"
if r=$(retry_insert pg-rw after-rw 60); then
  read -r n a s <<<"$r"
  check "write through pg-rw landed on pg-replica (got $n; attempt $a, ${s}s)" [ "$n" = pg-replica ]
else
  fail "no write through pg-rw within 60 s"
fi
if r=$(retry_insert pgbouncer after-pgbouncer 60); then
  read -r n a s <<<"$r"
  check "write through PgBouncer landed on pg-replica without a RELOAD (got $n; attempt $a, ${s}s)" [ "$n" = pg-replica ]
else
  fail "no write through PgBouncer within 60 s"
fi
c=$(count_rows pg-rw)
check "all 4 rows of this run are on the new primary (got $c)" [ "$c" = 4 ]
ro=$(q pg-ro -d labdb -c "select current_setting('cluster_name') || '|' || pg_is_in_recovery()" 2>/dev/null || echo unreachable)
check "pg-ro falls back to the primary while no standby exists (got $ro)" [ "$ro" = "pg-replica|f" ]

echo "== 6. Keycloak after the promotion (no restart)"
kc_after=$(kc_started)
check "Keycloak container was not restarted (before $kc_before, after $kc_after)" [ "$kc_before" = "$kc_after" ]
check "Keycloak /health/ready" keycloak_ready
if kc_refresh "$refresh_token" >/dev/null; then
  pass "the pre-promotion session still refreshes (sessions survived)"
else
  fail "the pre-promotion session could not be refreshed"
fi
t0=$(date +%s)
created=""
for ((i = 1; i <= 90; i++)); do
  if login=$(kc_login 2>/dev/null); then
    at=$(printf '%s' "$login" | json_field access_token)
    if [ "$(kc_create_user "$at" "$TOKEN_ID")" = 201 ]; then
      created=$(($(date +%s) - t0))
      break
    fi
  fi
  sleep 1
done
if [ -n "$created" ]; then
  pass "new login + admin write (create user $TOKEN_ID) succeeded after ${created}s"
  u=$(q pg-rw -d keycloak -c "select count(*) from user_entity where username = '$TOKEN_ID'")
  check "the Keycloak write is on the new primary (user_entity rows: $u)" [ "$u" = 1 ]
else
  fail "Keycloak could not log in and write within 90 s (Agroal did not reconnect?)"
fi

echo
if [ "$FAILS" -eq 0 ]; then
  log "SMOKE PASS ($TOKEN_ID). The lab is now promoted; ./lab.sh failback restores the roles."
else
  die "SMOKE FAIL: $FAILS check(s) failed ($TOKEN_ID). Logs: docker compose -p $PROJECT logs keycloak pgbouncer haproxy"
fi
