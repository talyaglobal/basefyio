#!/bin/bash
# Planned maintenance: rebuild the cluster image from the pinned base and
# recreate ONLY the postgres container.
#
# Why this is not an ordinary deploy. Changing docker/postgres/Dockerfile
# changes the hash the deploy workflow tags the image by, so the next deploy
# would rebuild the cluster image and recreate postgres at whatever moment
# someone happened to push. Doing it here, in the window the owner chose,
# keeps that out of a deploy — and `--no-deps` means Keycloak is not touched,
# so SSO sessions survive.
#
# The pin lives on its own branch, not on main: a change to this Dockerfile
# makes the deploy rebuild the cluster image, so merging it before this window
# would recreate postgres at whatever moment the next push happened. After
# this runs, the branch is merged and the next deploy finds the hash tag
# already built and skips the build entirely.
#
# Safe to re-run: if the image for the pinned hash already exists, it is not
# rebuilt, and postgres is only recreated when :latest actually moves.
set -u
set -o pipefail

DEPLOY_DIR="${BASEFYIO_DEPLOY_DIR:-/root/kolaybase}"
# The image the deploy workflow builds, tagged by the Dockerfile hash.
GHCR_OWNER_VALUE=$(grep -E "^GHCR_OWNER=" "$DEPLOY_DIR/.env.production" | cut -d= -f2- | tr -d "\"'")
PG_REF="ghcr.io/${GHCR_OWNER_VALUE:?GHCR_OWNER missing in .env.production}/basefyio-postgres"
LOG=/var/log/basefyio-postgres-pin.log
EVENTS=/var/lib/basefyio-autopilot/events.jsonl
ENV_FILE="$DEPLOY_DIR/.env.production"
export BASEFYIO_ENV_FILE="$ENV_FILE"
COMPOSE="docker compose -f $DEPLOY_DIR/docker-compose.prod.yml --env-file $ENV_FILE"

log() { echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') $*" | tee -a "$LOG"; }

# Report into the same file the root console reads, so the outcome shows up as
# a badge there and not only in a log nobody opens.
event() {
  severity=$1; title=$2; detail=$3
  python3 - "$severity" "$title" "$detail" "$EVENTS" <<'PY'
import json, os, sys, uuid
from datetime import datetime, timezone
severity, title, detail, path = sys.argv[1:5]
entry = {
    "id": str(uuid.uuid4()),
    "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
    "source": "postgres-maintenance",
    "kind": "postgres_base_pinned",
    "severity": severity,
    "title": title,
    "detail": detail,
    "metadata": {},
}
try:
    lines = open(path, encoding="utf-8").read().splitlines() if os.path.exists(path) else []
    lines.append(json.dumps(entry))
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines[-500:]) + "\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)
except OSError as err:
    print("could not record event:", err)
PY
}

mail() {
  subject=$1; body=$2
  python3 - "$subject" "$body" <<'PY'
import json, os, sys, urllib.error, urllib.request
subject, body = sys.argv[1], sys.argv[2]
env = {}
for line in open(os.environ["BASEFYIO_ENV_FILE"], encoding="utf-8"):
    line = line.strip()
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) > 1 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        env[k] = v
key = env.get("TSMART_SEND_API_KEY") or env.get("RESEND_API_KEY")
sender, to = env.get("RESEND_FROM_EMAIL"), os.environ.get("OPS_ALERT_TO") or env.get("OPS_ALERT_TO")
if not (key and sender):
    sys.exit(0)
base = env.get("RESEND_BASE_URL") or ("https://send.tsmart.ai" if key.startswith("ts_") else "https://api.resend.com")
payload = json.dumps({"from": sender, "to": [to], "subject": subject,
                      "html": "<pre style='font:13px/1.5 ui-monospace,monospace'>" + body + "</pre>"}).encode()
req = urllib.request.Request(base.rstrip("/") + "/emails", data=payload, method="POST",
                             headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                                      "User-Agent": "basefyio-postgres-maintenance/1"})
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        print("mail sent", r.status)
except (urllib.error.URLError, OSError) as err:
    print("mail failed:", err)
PY
}

finish() {
  systemctl disable --now basefyio-postgres-pin.timer >/dev/null 2>&1
  log "timer disabled; this maintenance runs once"
}

cd "$DEPLOY_DIR" || { log "FATAL: no $DEPLOY_DIR"; exit 1; }
log "=== postgres base pin: start ==="

OLD_IMAGE=$(docker inspect kolaybase-postgres-1 --format '{{.Image}}')
OLD_GLIBC=$(docker exec kolaybase-postgres-1 sh -c 'ldd --version | head -1')
KC_BEFORE=$(docker inspect kolaybase-keycloak-1 --format '{{.Id}}')
log "running image $OLD_IMAGE"
log "glibc before: $OLD_GLIBC"

# ── The pinned Dockerfile, taken from the trunk ──
PIN_BRANCH=${PIN_BRANCH:-main}
git fetch -q origin "$PIN_BRANCH" || { log "FATAL: git fetch of $PIN_BRANCH failed"; exit 1; }
WORK=$(mktemp -d)
mkdir -p "$WORK/docker/postgres"
git show "origin/$PIN_BRANCH:docker/postgres/Dockerfile" > "$WORK/docker/postgres/Dockerfile" || {
  log "FATAL: could not read the pinned Dockerfile from $PIN_BRANCH"; rm -rf "$WORK"; exit 1; }
if ! grep -q 'bookworm' "$WORK/docker/postgres/Dockerfile"; then
  log "FATAL: the Dockerfile on $PIN_BRANCH is not pinned to bookworm; refusing"
  rm -rf "$WORK"; exit 1
fi
# Identical to the deploy workflow's own computation, so the next deploy finds
# this tag and skips the build.
PG_HASH=$(sha256sum "$WORK/docker/postgres/Dockerfile" | cut -c1-12)
log "pinned Dockerfile hash: $PG_HASH"
log "base: $(grep '^FROM ' "$WORK/docker/postgres/Dockerfile")"

if docker image inspect "$PG_REF:$PG_HASH" >/dev/null 2>&1; then
  log "image for $PG_HASH already present; not rebuilding"
else
  log "building $PG_REF:$PG_HASH"
  if ! docker build --pull --label "io.basefyio.dockerfile-sha=$PG_HASH" \
        -t "$PG_REF:$PG_HASH" "$WORK/docker/postgres" >>"$LOG" 2>&1; then
    log "FATAL: build failed; nothing was changed"
    rm -rf "$WORK"
    event critical "Postgres base pin: build failed" \
      "The planned rebuild of the cluster image failed. Nothing was changed and postgres is untouched. See $LOG."
    mail "[basefyio] Postgres maintenance: build failed, nothing changed" "Build of $PG_REF:$PG_HASH failed. Postgres was not touched."
    finish; exit 1
  fi
fi
rm -rf "$WORK"

NEW_IMAGE=$(docker image inspect "$PG_REF:$PG_HASH" --format '{{.Id}}')
log "new image $NEW_IMAGE"

# The image the new container will actually use is whatever :latest points at.
if [ "$NEW_IMAGE" = "$OLD_IMAGE" ]; then
  log "the rebuilt image is identical to the running one; only re-tagging"
  docker tag "$PG_REF:$PG_HASH" "$PG_REF:latest"
  event warning "Postgres base pinned, no restart needed" \
    "The cluster image was rebuilt from the pinned base and came out identical to the running one, so postgres was not recreated."
  finish; exit 0
fi

docker tag "$PG_REF:latest" "$PG_REF:rollback-$(date -u +%Y%m%d)" 2>/dev/null
docker tag "$PG_REF:$PG_HASH" "$PG_REF:latest"
log "recreating postgres only (--no-deps; Keycloak is left running)"

IMAGE_TAG=$(docker inspect kolaybase-platform-api-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^IMAGE_TAG=' | cut -d= -f2)
export IMAGE_TAG
if ! $COMPOSE up -d --no-deps postgres >>"$LOG" 2>&1; then
  log "compose up failed; rolling back :latest"
  docker tag "$OLD_IMAGE" "$PG_REF:latest"
  $COMPOSE up -d --no-deps postgres >>"$LOG" 2>&1
  event critical "Postgres base pin: recreate failed, rolled back" \
    "Recreating the postgres container with the pinned image failed; the previous image was restored. See $LOG."
  mail "[basefyio] Postgres maintenance FAILED, rolled back" "compose up failed. Rolled back to $OLD_IMAGE."
  finish; exit 1
fi

# ── Verify ──
ok=1
for i in $(seq 1 60); do
  state=$(docker inspect kolaybase-postgres-1 --format '{{.State.Health.Status}}' 2>/dev/null || echo unknown)
  [ "$state" = "healthy" ] && break
  sleep 5
done
log "postgres health: ${state:-unknown}"
[ "${state:-}" = "healthy" ] || ok=0

ROWS=$(docker exec kolaybase-postgres-1 psql -U kolaybase -X -tA -d kolaybase -c 'select count(*) from projects' 2>&1)
log "projects row count: $ROWS"
echo "$ROWS" | grep -qE '^[0-9]+$' || ok=0

NEW_GLIBC=$(docker exec kolaybase-postgres-1 sh -c 'ldd --version | head -1' 2>&1)
log "glibc after: $NEW_GLIBC"
[ "$NEW_GLIBC" = "$OLD_GLIBC" ] || { log "WARNING: the C library changed — text indexes need a REINDEX"; ok=0; }

# PGOPTIONS, not a SET statement: psql echoes "SET" for each statement and
# that line was captured along with the count, so the comparison below could
# never match and the maintenance rolled itself back.
MISS=$(docker exec -e PGOPTIONS="-c enable_seqscan=off" kolaybase-postgres-1 \
  psql -U kolaybase -X -tA -d keycloak -c \
  "select count(*) from (select name from realm) s where not exists (select 1 from realm r where r.name = s.name)" 2>&1)
log "realm lookups that the index misses: $MISS"
[ "$MISS" = "0" ] || ok=0

sleep 20
API=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 https://api.basefyio.com/api/health)
APP=$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 25 https://app.basefyio.com)
SITE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 https://basefyio.com)
AUTH=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 https://auth.basefyio.com/realms/master/.well-known/openid-configuration)
log "https: api=$API app=$APP site=$SITE auth=$AUTH"
[ "$API" = "200" ] && [ "$APP" = "200" ] && [ "$SITE" = "200" ] && [ "$AUTH" = "200" ] || ok=0

KC_AFTER=$(docker inspect kolaybase-keycloak-1 --format '{{.Id}}')
[ "$KC_BEFORE" = "$KC_AFTER" ] && KC="unchanged (sessions kept)" || KC="RECREATED (sessions lost)"
log "keycloak: $KC"

SUMMARY="image $OLD_IMAGE -> $NEW_IMAGE
hash $PG_HASH
glibc $NEW_GLIBC (was $OLD_GLIBC)
postgres health ${state:-unknown}, projects rows $ROWS, realm index misses $MISS
https api=$API app=$APP site=$SITE auth=$AUTH
keycloak $KC"

if [ "$ok" = "1" ]; then
  log "=== verified; pin complete ==="
  event warning "Postgres cluster image pinned to its Debian release" \
    "The cluster image now builds from pgvector 0.8.7 on Debian bookworm, so an upstream move to a newer C library can no longer reorder text indexes. Postgres was recreated in the planned window; Keycloak was not touched. $SUMMARY"
  mail "[basefyio] Postgres base pinned successfully" "$SUMMARY"
else
  log "=== verification FAILED; rolling back ==="
  docker tag "$OLD_IMAGE" "$PG_REF:latest"
  $COMPOSE up -d --no-deps postgres >>"$LOG" 2>&1
  sleep 20
  log "after rollback: api=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 https://api.basefyio.com/api/health)"
  event critical "Postgres base pin rolled back after failed verification" \
    "The pinned image started but did not pass verification, so the previous image was restored. $SUMMARY"
  mail "[basefyio] Postgres maintenance rolled back" "Verification failed, rolled back to $OLD_IMAGE.
$SUMMARY"
fi
finish
