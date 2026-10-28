#!/bin/bash
# Basefyio disk guard — keeps the host disk healthy and emails an alert when it
# crosses 90%. Prunes ONLY reproducible Docker data (build cache, unused images,
# stopped containers, oversized logs). NEVER touches volumes -> no data loss.
set -u
DEPLOY_DIR="${BASEFYIO_DEPLOY_DIR:-/root/kolaybase}"
ENV_FILE="$DEPLOY_DIR/.env.production"
LOG=/var/log/basefyio-disk-guard.log
THRESHOLD=90

log() { echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') $*" >> "$LOG"; }
pct_of() { df "$1" 2>/dev/null | awk 'NR==2{gsub(/%/,"",$5); print $5}'; }

# A prune can take the name off an image a running container still uses; the
# next deploy would then try to pull it (see restore-image-names.sh).
restore_names() {
  local script="$DEPLOY_DIR/scripts/ops/restore-image-names.sh"
  [ -f "$script" ] || return 0
  bash "$script" 2>&1 | while read -r line; do log "$line"; done
}

# Docker's data sits on an attached volume, so the filesystem that actually
# matters is wherever the data root points -- not necessarily /.
DOCKER_ROOT=$(docker info 2>/dev/null | awk -F': ' '/Docker Root Dir/{print $2}' | tr -d ' ')
[ -n "$DOCKER_ROOT" ] || DOCKER_ROOT=/var/lib/docker

# The pre-migration copy is kept on / deliberately as a rollback path, so / can
# sit near full with nothing actually wrong. Report that instead of paging.
KEPT_COPY=no
if [ "$DOCKER_ROOT" != "/var/lib/docker" ] && [ -d /var/lib/docker/volumes ]; then
  KEPT_COPY=yes
fi

BEFORE=$(pct_of "$DOCKER_ROOT")
ROOT_PCT=$(pct_of /)
log "check: docker-disk ${BEFORE}%, root ${ROOT_PCT}% (data-root=${DOCKER_ROOT}, kept-copy=${KEPT_COPY})"

# Routine cleanup (safe, no volumes)
docker builder prune -af --filter "until=12h" >/dev/null 2>&1
docker image prune -af --filter "until=24h" >/dev/null 2>&1
docker container prune -f >/dev/null 2>&1
restore_names
find "${DOCKER_ROOT}/containers/" -name '*-json.log' -size +50M -exec truncate -s 0 {} \; 2>/dev/null
journalctl --vacuum-size=200M >/dev/null 2>&1
apt-get clean >/dev/null 2>&1

MID=$(pct_of "$DOCKER_ROOT")
if [ "$MID" -ge "$THRESHOLD" ]; then
  log "still ${MID}% >= ${THRESHOLD}% -- aggressive prune"
  docker builder prune -af >/dev/null 2>&1
  docker image prune -af >/dev/null 2>&1
  restore_names
fi

AFTER=$(pct_of "$DOCKER_ROOT")
log "after cleanup: docker-disk ${AFTER}% (was ${BEFORE}%)"

# Alerting moved to basefyio-storage-autopilot (every minute, mail + root console
# badge). This guard only prunes reproducible data.
log "alerting is handled by basefyio-storage-autopilot"
