#!/usr/bin/env bash
# Enable point-in-time recovery on an existing deployment.
#
# Two things change, and both need a database restart:
#   * PostgreSQL starts archiving WAL (wal_level=replica, archive_mode=on).
#   * MongoDB starts running as a single-node replica set, so an oplog exists.
#
# Converting Mongo to a replica set is effectively one-way: clients must then
# either know the set or connect with directConnection=true. This script adds
# that parameter to NOSQL_CONNSTR *before* restarting, so the running platform
# keeps talking to Mongo exactly as it did.
#
# Safe to re-run — every step checks whether it has already been applied.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/root/kolaybase}"
ENV_FILE="$DEPLOY_DIR/.env.production"
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.production"

cd "$DEPLOY_DIR"

echo "==> 1/5 Generating the MongoDB replica-set keyfile (once)"
./scripts/init-mongo-keyfile.sh "$DEPLOY_DIR/secrets/mongo-keyfile"

echo "==> 2/5 Making sure NOSQL_CONNSTR uses directConnection=true"
if grep -q '^NOSQL_CONNSTR=' "$ENV_FILE"; then
  if grep -q '^NOSQL_CONNSTR=.*directConnection=true' "$ENV_FILE"; then
    echo "    already set — leaving it alone"
  else
    cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%s)"
    # Append the parameter, respecting whether a query string already exists.
    if grep -q '^NOSQL_CONNSTR=[^[:space:]]*?' "$ENV_FILE"; then
      sed -i 's|^\(NOSQL_CONNSTR=.*\)$|\1\&directConnection=true|' "$ENV_FILE"
    else
      sed -i 's|^\(NOSQL_CONNSTR=.*\)$|\1?directConnection=true|' "$ENV_FILE"
    fi
    echo "    updated (backup written next to the env file)"
  fi
else
  echo "    NOSQL_CONNSTR not found — skipping (Mongo may be unused here)"
fi

echo "==> 3/5 Recreating PostgreSQL with WAL archiving"
$COMPOSE up -d postgres
# The container entrypoint creates this directory owned by postgres, but fix it
# here too for deployments whose volume predates that change — archive_command
# runs as the postgres user and silently fails against a root-owned directory.
$COMPOSE exec -T -u root postgres \
  install -d -o postgres -g postgres /var/lib/postgresql/wal_archive || true

echo "    waiting for PostgreSQL to accept connections"
for _ in $(seq 1 30); do
  if $COMPOSE exec -T postgres pg_isready >/dev/null 2>&1; then break; fi
  sleep 2
done

# Physical base backups connect in replication mode, and pg_hba never matches
# those against a plain "host all all" rule — "replication" is a keyword, not a
# database name. Without this line pg_basebackup fails with "no pg_hba.conf entry
# for replication connection" and only logical dumps get taken.
echo "    allowing replication connections from the compose network"
$COMPOSE exec -T -u postgres postgres sh -c '
  HBA=/var/lib/postgresql/data/pg_hba.conf
  grep -qE "^host[[:space:]]+replication[[:space:]]+all[[:space:]]+samenet" "$HBA" ||
    echo "host    replication     all             samenet                 scram-sha-256" >> "$HBA"
' || true
# Reload rather than restart — the rule takes effect without dropping sessions.
$COMPOSE exec -T postgres psql -U "${POSTGRES_USER:-postgres}" -d postgres \
  -tAc "select pg_reload_conf()" >/dev/null 2>&1 || true

echo "==> 4/5 Recreating MongoDB as a single-node replica set"
$COMPOSE up -d mongodb

echo "    waiting for the replica set to report a primary"
for _ in $(seq 1 45); do
  if $COMPOSE exec -T mongodb mongosh --quiet \
      -u "$(grep '^NOSQL_USERNAME=' "$ENV_FILE" | cut -d= -f2-)" \
      -p "$(grep '^NOSQL_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)" \
      --authenticationDatabase admin \
      --eval 'db.hello().isWritablePrimary' 2>/dev/null | grep -q true; then
    echo "    primary is up"
    break
  fi
  sleep 2
done

echo "==> 5/5 Restarting the API so it picks up the new connection string"
$COMPOSE up -d platform-api

echo
echo "PITR enabled. Verify with:"
echo "  docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres psql -U \$POSTGRES_USER -c 'SHOW archive_mode;'"
echo "  docker compose -f docker-compose.prod.yml --env-file .env.production exec -T mongodb mongosh --quiet --eval 'rs.status().ok'"
