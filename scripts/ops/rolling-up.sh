#!/usr/bin/env bash
# Replace the container of a stateless service without a gap in service.
#
# `docker compose up -d` stops the old container before it starts the new one.
# While the new one boots, the proxy has nothing to send traffic to: Traefik
# answers a bare "404 page not found" first (the router leaves with the
# container) and 502/503 afterwards. That is what a customer saw during the
# v4.3.4 deploy.
#
# Here the new container starts BESIDE the old one, takes over once it answers,
# and only then is the old one stopped (the API drains on SIGTERM). Nothing is
# ever removed before its replacement serves.
#
#   scripts/ops/rolling-up.sh <service> [<service> …]
#
# Run from the directory that holds docker-compose.prod.yml, with IMAGE_TAG in
# the environment (the deploy workflow sets it). Needs no Docker or Traefik
# change beyond the labels already in the compose file.
#
# Per service, a service is rolled only if its running container differs from
# the one compose would create now (same config hash → nothing happens). If the
# new container does not become ready, it is removed, the old one keeps running
# and the script exits non-zero. The caller then falls back to a plain `up -d`.
#
# Tunables (environment): ROLL_READY_TIMEOUT (default 180 s), ROLL_SETTLE (15 s:
# one Traefik health-check interval and a margin, so the proxy has the new
# container before the old one goes), ROLL_STOP_TIMEOUT (35 s: longer than the
# API's 25 s drain), COMPOSE_FILE_PATH, ENV_FILE.
set -uo pipefail

COMPOSE_FILE_PATH="${COMPOSE_FILE_PATH:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:---env-file .env.production}"
DRY_RUN="${ROLL_DRY_RUN:-0}"
READY_TIMEOUT="${ROLL_READY_TIMEOUT:-180}"
SETTLE="${ROLL_SETTLE:-15}"
STOP_TIMEOUT="${ROLL_STOP_TIMEOUT:-35}"

# shellcheck disable=SC2206
COMPOSE=(docker compose -f "$COMPOSE_FILE_PATH" $ENV_FILE)

log() { printf '[rolling-up] %s\n' "$*"; }

# The routing labels of the running container and of the one compose would create now, one per line.
# Traefik refuses a router that two containers define differently (the route answers 404 for as long
# as both run), so a service whose routing labels changed cannot be rolled; it is replaced the plain way.
routing_labels_want() {
  "${COMPOSE[@]}" config --format json 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
l = d.get("services", {}).get(sys.argv[1], {}).get("labels", {}) or {}
for k, v in sorted(l.items()):
    if k.startswith("traefik."):
        print(f"{k}={v}")
' "$1"
}
routing_labels_have() {
  docker inspect -f '{{json .Config.Labels}}' "$1" 2>/dev/null | python3 -c '
import json, sys
l = json.load(sys.stdin) or {}
for k, v in sorted(l.items()):
    if k.startswith("traefik."):
        print(f"{k}={v}")
'
}

# What each service answers once it is really serving (the same paths Traefik probes).
probe_for() {
  case "$1" in
    platform-api) echo "4000 /api/health/ready" ;;
    admin-ui) echo "3000 /login" ;;
    website) echo "3000 /" ;;
    *) echo "" ;;
  esac
}

container_ips() {
  docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$1" 2>/dev/null
}

is_ready() {
  local id="$1" port="$2" path="$3" ip
  [ "$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null)" = "true" ] || return 1
  for ip in $(container_ips "$id"); do
    [ -n "$ip" ] || continue
    if curl -fsS -m 3 -o /dev/null "http://$ip:$port$path" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

roll() {
  local svc="$1" spec port path
  spec="$(probe_for "$svc")"
  if [ -z "$spec" ]; then
    log "$svc: no probe is defined for it; not rolled"
    return 2
  fi
  port="${spec%% *}"
  path="${spec#* }"

  # Old and new API code run side by side for a minute, so the schema they share must only grow.
  # The release script writes deploy/components.env; anything but none/additive is rolled the plain way.
  if [ "$svc" = "platform-api" ] && [ -f deploy/components.env ]; then
    local dbc
    dbc="$(sed -n 's/^BASEFYIO_DB_CHANGES=//p' deploy/components.env | tr -d "\"' ")"
    case "$dbc" in
      none|additive|"") ;;
      *) log "$svc: database changes are '$dbc'; old and new code must not share that schema, not rolled"; return 3 ;;
    esac
  fi

  local old
  old="$("${COMPOSE[@]}" ps -q "$svc" | sort)"
  if [ -z "$old" ]; then
    log "$svc: not running, starting it"
    "${COMPOSE[@]}" up -d --no-deps "$svc" || return 1
    return 0
  fi

  local want have first
  want="$("${COMPOSE[@]}" config --hash "$svc" 2>/dev/null | awk 'NR==1{print $2}')"
  first="$(echo "$old" | head -n 1)"
  have="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$first" 2>/dev/null)"
  if [ -n "$want" ] && [ "$want" = "$have" ]; then
    log "$svc: already current"
    return 0
  fi

  local lw lh
  if ! lw="$(routing_labels_want "$svc")" || ! lh="$(routing_labels_have "$first")"; then
    log "$svc: could not compare the routing labels; not rolled"
    return 3
  fi
  if [ "$lw" != "$lh" ]; then
    log "$svc: its routing labels changed; two containers would define the route differently and Traefik drops it. Not rolled, the plain up -d replaces it"
    diff <(echo "$lh") <(echo "$lw") | sed 's/^/[rolling-up]   /' | head -12
    return 3
  fi

  local count
  count="$(echo "$old" | wc -l | tr -d ' ')"
  if [ "$DRY_RUN" = "1" ]; then
    log "$svc: would roll ($count running now); dry run, nothing changed"
    return 0
  fi
  log "$svc: starting a new container beside $count running"
  # --no-recreate keeps the running ones; the extra one is created from the current config.
  "${COMPOSE[@]}" up -d --no-deps --no-recreate --scale "$svc=$((count + 1))" "$svc" || return 1

  local new
  new="$(comm -13 <(echo "$old") <("${COMPOSE[@]}" ps -q "$svc" | sort) | head -n 1)"
  if [ -z "$new" ]; then
    log "$svc: no new container appeared"
    return 1
  fi

  local waited=0
  until is_ready "$new" "$port" "$path"; do
    if [ "$waited" -ge "$READY_TIMEOUT" ]; then
      log "$svc: the new container did not answer $path within ${READY_TIMEOUT}s; removing it, the old one keeps serving"
      docker logs --tail 30 "$new" 2>&1 | sed 's/^/[rolling-up]   /' || true
      docker rm -f "$new" >/dev/null 2>&1 || true
      return 1
    fi
    sleep 3
    waited=$((waited + 3))
  done
  log "$svc: new container answers after ${waited}s; letting the proxy pick it up (${SETTLE}s)"
  sleep "$SETTLE"
  # It must still be up after the proxy's first probes.
  if ! is_ready "$new" "$port" "$path"; then
    log "$svc: the new container stopped answering; removing it, the old one keeps serving"
    docker rm -f "$new" >/dev/null 2>&1 || true
    return 1
  fi

  local o
  for o in $old; do
    log "$svc: stopping the old container ${o:0:12} (graceful, up to ${STOP_TIMEOUT}s)"
    docker stop -t "$STOP_TIMEOUT" "$o" >/dev/null 2>&1 || true
    docker rm "$o" >/dev/null 2>&1 || true
  done
  # Compose's own bookkeeping: the service is back to its configured size.
  "${COMPOSE[@]}" up -d --no-deps --no-recreate --scale "$svc=$count" "$svc" >/dev/null 2>&1 || true
  # Compose numbers replicas upwards (…-1, …-2, …-3). Tools and runbooks address the
  # container by the name it always had, so a lone survivor takes that name back.
  if [ "$count" = "1" ]; then
    local project canonical
    project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$new" 2>/dev/null)"
    canonical="${project}-${svc}-1"
    if [ -n "$project" ] && [ "$(docker inspect -f '{{.Name}}' "$new" 2>/dev/null)" != "/$canonical" ]; then
      docker rename "$new" "$canonical" >/dev/null 2>&1 || log "$svc: could not rename $new to $canonical (harmless)"
    fi
  fi
  log "$svc: done"
  return 0
}

[ "$#" -gt 0 ] || { echo "usage: $0 <service> [<service> …]" >&2; exit 64; }

status=0
for s in "$@"; do
  roll "$s" || status=1
done
exit "$status"
