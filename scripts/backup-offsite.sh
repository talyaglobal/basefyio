#!/usr/bin/env bash
# Copy basefyio backups to an off-site S3-compatible bucket — from the host.
#
# The platform can do this itself (BACKUP_S3_* in the API environment; see
# docs/BACKUP_OFFSITE_AND_VERIFICATION.md). This script is for operators who
# prefer a host cron job, or who want a second, independent copy. It mirrors
# the two local MinIO buckets that hold backups:
#
#   bf-platform-auto-backups  → <prefix>auto-backups/…   nightly archives
#   bf-platform-pitr          → <prefix>pitr/…           base backups + WAL
#
# Every object is encrypted with `age -r <recipient>` before it leaves, and
# lands as <key>.age. Decrypt with `age -d -i key.txt <file>.age > <file>`.
# Without BACKUP_AGE_RECIPIENT the script refuses to run unless
# BACKUP_OFFSITE_ALLOW_PLAINTEXT=true says plainly that unencrypted copies are
# wanted (for example because the bucket itself encrypts at rest).
#
# Idempotent: objects already present in the bucket are skipped, so running it
# every night only ships the night's new artifacts. It never deletes anything
# remotely — retention is the bucket's lifecycle rule, and the credentials can
# be write-only.
#
# Needs on the host: docker (talks to MinIO through the compose network with
# the minio/mc image) and, for encryption, age (https://age-encryption.org).
#
# Configuration comes from the environment, falling back to .env.production in
# DEPLOY_DIR (read line by line — the file is never sourced):
#   DEPLOY_DIR                       deployment directory (required)
#   BACKUP_S3_ENDPOINT               e.g. https://fsn1.your-objectstorage.com
#   BACKUP_S3_BUCKET                 remote bucket
#   BACKUP_S3_ACCESS_KEY / BACKUP_S3_SECRET_KEY
#   BACKUP_S3_PREFIX                 default basefyio/
#   BACKUP_AGE_RECIPIENT             age public key (age1…) — encrypt with this
#   BACKUP_OFFSITE_ALLOW_PLAINTEXT   "true" to allow unencrypted copies
#   MINIO_ROOT_USER / MINIO_ROOT_PASSWORD   local MinIO credentials
#   DOCKER_NETWORK                   compose network MinIO is on (default kolaybase_web)
#   MC_IMAGE                         minio/mc image (default minio/mc; pin a release tag in production)
#
# Example cron line (nightly at 05:17 UTC, after the 03:00 backups):
#   17 5 * * * DEPLOY_DIR=/path/to/deployment /path/to/deployment/scripts/backup-offsite.sh >> /var/log/basefyio-backup-offsite.log 2>&1
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-}"
if [ -z "$DEPLOY_DIR" ]; then
  echo "DEPLOY_DIR is not set. Point it at the directory holding docker-compose.prod.yml." >&2
  exit 1
fi
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env.production}"

# Read one variable: the environment wins, then the env file. Quotes around the
# value are stripped; the file is never sourced (a stray "<" in a value would
# otherwise silently truncate everything after it).
val() {
  local name="$1" v="${!1:-}"
  if [ -n "$v" ]; then printf '%s' "$v"; return; fi
  if [ -f "$ENV_FILE" ]; then
    grep -E "^${name}=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
  fi
}

S3_ENDPOINT="$(val BACKUP_S3_ENDPOINT)"
S3_BUCKET="$(val BACKUP_S3_BUCKET)"
S3_ACCESS_KEY="$(val BACKUP_S3_ACCESS_KEY)"
S3_SECRET_KEY="$(val BACKUP_S3_SECRET_KEY)"
S3_PREFIX="$(val BACKUP_S3_PREFIX)"; S3_PREFIX="${S3_PREFIX:-basefyio/}"
AGE_RECIPIENT="$(val BACKUP_AGE_RECIPIENT)"
ALLOW_PLAINTEXT="$(val BACKUP_OFFSITE_ALLOW_PLAINTEXT)"
MINIO_USER="$(val MINIO_ROOT_USER)"
MINIO_PASS="$(val MINIO_ROOT_PASSWORD)"
DOCKER_NETWORK="${DOCKER_NETWORK:-kolaybase_web}"
MC_IMAGE="${MC_IMAGE:-minio/mc}"

for pair in "BACKUP_S3_ENDPOINT:$S3_ENDPOINT" "BACKUP_S3_BUCKET:$S3_BUCKET" \
            "BACKUP_S3_ACCESS_KEY:$S3_ACCESS_KEY" "BACKUP_S3_SECRET_KEY:$S3_SECRET_KEY" \
            "MINIO_ROOT_USER:$MINIO_USER" "MINIO_ROOT_PASSWORD:$MINIO_PASS"; do
  if [ -z "${pair#*:}" ]; then
    echo "${pair%%:*} is not set (environment or $ENV_FILE)." >&2
    exit 1
  fi
done

if [ -n "$AGE_RECIPIENT" ]; then
  command -v age >/dev/null 2>&1 || { echo "age is not installed; install it or unset BACKUP_AGE_RECIPIENT." >&2; exit 1; }
elif [ "$ALLOW_PLAINTEXT" != "true" ]; then
  echo "Refusing to copy backups off the server unencrypted. Set BACKUP_AGE_RECIPIENT (an age public key)" >&2
  echo "or, if the bucket encrypts at rest and that is acceptable, BACKUP_OFFSITE_ALLOW_PLAINTEXT=true." >&2
  exit 1
fi

# mc is run from its image on the compose network, so "minio" resolves to the
# local MinIO. Aliases are passed as MC_HOST_* so no state is written anywhere.
# (Credentials are visible in the container's environment while it runs.)
case "$S3_ENDPOINT" in
  http://*|https://*) ;;
  *) S3_ENDPOINT="https://$S3_ENDPOINT" ;;
esac
S3_SCHEME="${S3_ENDPOINT%%://*}"
S3_HOST="${S3_ENDPOINT#*://}"; S3_HOST="${S3_HOST%%/*}"
MC_LOCAL="http://${MINIO_USER}:${MINIO_PASS}@minio:9000"
MC_OFFSITE="${S3_SCHEME}://${S3_ACCESS_KEY}:${S3_SECRET_KEY}@${S3_HOST}"

mc() {
  docker run --rm -i --network "$DOCKER_NETWORK" \
    -e "MC_HOST_local=$MC_LOCAL" -e "MC_HOST_offsite=$MC_OFFSITE" \
    "$MC_IMAGE" "$@"
}

copied=0; skipped=0; failed=0
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "==> backup-offsite: $started → ${S3_HOST}/${S3_BUCKET}/${S3_PREFIX} ($([ -n "$AGE_RECIPIENT" ] && echo encrypted with age || echo PLAINTEXT))"

ship_bucket() {
  local bucket="$1" remote_sub="$2" key remote
  # `mc ls --recursive` prints "[date] [time] [tz] [size] [tier] name"; backup
  # keys never contain spaces, so the last field is the key.
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    remote="offsite/${S3_BUCKET}/${S3_PREFIX}${remote_sub}/${key}"
    [ -n "$AGE_RECIPIENT" ] && remote="${remote}.age"
    if mc stat "$remote" >/dev/null 2>&1; then
      skipped=$((skipped + 1))
      continue
    fi
    if [ -n "$AGE_RECIPIENT" ]; then
      if mc cat "local/${bucket}/${key}" | age -r "$AGE_RECIPIENT" | mc pipe "$remote"; then
        copied=$((copied + 1)); echo "    copied  ${bucket}/${key} (encrypted)"
      else
        failed=$((failed + 1)); echo "    FAILED  ${bucket}/${key}" >&2
      fi
    else
      if mc cp --quiet "local/${bucket}/${key}" "$remote" >/dev/null; then
        copied=$((copied + 1)); echo "    copied  ${bucket}/${key}"
      else
        failed=$((failed + 1)); echo "    FAILED  ${bucket}/${key}" >&2
      fi
    fi
  done < <(mc ls --recursive "local/${bucket}/" 2>/dev/null | awk '{print $NF}')
}

ship_bucket bf-platform-auto-backups auto-backups
ship_bucket bf-platform-pitr pitr

echo "==> backup-offsite: done — ${copied} copied, ${skipped} already present, ${failed} failed"
[ "$failed" -eq 0 ]
