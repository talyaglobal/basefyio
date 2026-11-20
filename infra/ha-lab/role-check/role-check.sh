#!/bin/bash
# One HTTP request per invocation (socat fork + EXEC): stdin is the request,
# stdout the response. Kept deliberately small; see the Dockerfile header for
# the contract.
set -uo pipefail

respond() { # status text body
  local body="$3"
  printf 'HTTP/1.1 %s %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s' \
    "$1" "$2" "${#body}" "$body"
  exit 0
}

IFS=' ' read -r -t 3 method target _ || respond 400 "Bad Request" '{"error":"no request line"}'
# Drain the headers so the client never sees a reset before the response.
while IFS= read -r -t 1 line; do
  line=${line%$'\r'}
  [ -z "$line" ] && break
done

path=${target%%\?*}
query=""
[ "$target" != "$path" ] && query=${target#*\?}
max_lag=""
if [[ "$query" =~ (^|&)lag=([0-9]+)($|&) ]]; then max_lag=${BASH_REMATCH[2]}; fi

[ "$method" = GET ] || [ "$method" = HEAD ] || [ "$method" = OPTIONS ] || \
  respond 405 "Method Not Allowed" '{"error":"method"}'

export PGPASSWORD="${CHECK_PASSWORD:-}" PGCONNECT_TIMEOUT=2
row=$(psql -h "${PG_HOST:?}" -p "${PG_PORT:-5432}" -U "${CHECK_USER:-rolecheck}" -d postgres \
  -XqAt -F '|' -c "SELECT pg_is_in_recovery(),
         COALESCE((SELECT status FROM pg_stat_wal_receiver LIMIT 1), ''),
         CASE WHEN pg_is_in_recovery()
              THEN COALESCE(pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()), 0)::bigint
              ELSE 0 END,
         current_setting('cluster_name')" 2>/dev/null) \
  || respond 503 "Service Unavailable" "{\"node\":\"${PG_HOST}\",\"state\":\"unreachable\"}"

IFS='|' read -r in_recovery receiver lag node <<<"$row"
if [ "$in_recovery" = t ]; then role=replica; else role=primary; fi
body="{\"node\":\"${node:-$PG_HOST}\",\"role\":\"${role}\",\"wal_receiver\":\"${receiver}\",\"replay_lag_bytes\":${lag:-0}}"

case "$path" in
  /primary|/master|/read-write|/leader)
    [ "$role" = primary ] && respond 200 OK "$body"
    respond 503 "Service Unavailable" "$body" ;;
  /replica|/read-only)
    if [ "$role" = replica ] && [ "$receiver" = streaming ] \
       && { [ -z "$max_lag" ] || [ "${lag:-0}" -le "$max_lag" ]; }; then
      respond 200 OK "$body"
    fi
    respond 503 "Service Unavailable" "$body" ;;
  /health|/)
    respond 200 OK "$body" ;;
  *)
    respond 404 "Not Found" '{"error":"unknown path"}' ;;
esac
