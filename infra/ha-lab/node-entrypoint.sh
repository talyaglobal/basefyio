#!/bin/bash
# Entrypoint of both lab Postgres nodes (infra/ha-lab, never deployed).
#
# Follows docker-compose.prod.yml's convention: prepare the WAL archive
# directory as root, then exec the image's own docker-entrypoint.sh with the
# compose `command:`. On top of that, a node whose data directory is empty and
# whose /lab-state/<node>.upstream file names another node is seeded as a
# streaming standby with pg_basebackup -R, which writes standby.signal plus
# primary_conninfo and primary_slot_name into postgresql.auto.conf.
set -euo pipefail

PGDATA=${PGDATA:-/var/lib/postgresql/data}
NODE=${LAB_NODE:?LAB_NODE is not set}
SLOT="slot_${NODE//-/_}"

# Same as prod: a named volume is root-owned, archive_command runs as postgres.
install -d -o postgres -g postgres /var/lib/postgresql/wal_archive

# Fencing: lab.sh promote marks the node it took the primary role away from.
# A fenced node that still holds its old data directory must never start,
# because it would come back as a second writable primary (split brain).
# `lab.sh failback` wipes it, reseeds it as a standby and clears the mark.
if [ -e "/lab-state/${NODE}.fenced" ] && [ -s "$PGDATA/PG_VERSION" ]; then
  echo "[lab] $NODE is fenced (it was the primary before a promotion); refusing to start." >&2
  echo "[lab] run ./lab.sh failback to rebuild it as a standby." >&2
  exit 78
fi

upstream=""
if [ -s "/lab-state/${NODE}.upstream" ]; then
  upstream=$(tr -d '[:space:]' < "/lab-state/${NODE}.upstream")
fi

if [ -n "$upstream" ] && [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "[lab] $NODE: empty data directory, seeding a standby from $upstream (slot $SLOT)"
  install -d -o postgres -g postgres -m 700 "$PGDATA"
  export PGPASSWORD="${LAB_REPL_PASSWORD:?}"
  for _ in $(seq 1 120); do
    pg_isready -q -h "$upstream" -p 5432 -d postgres && break
    sleep 1
  done
  pg_isready -h "$upstream" -p 5432 -d postgres

  # A slot left over from an earlier seed of this node would make -C fail and,
  # while inactive, pin WAL on the upstream. Drop it first (REPLICATION roles
  # may manage slots).
  gosu postgres psql -h "$upstream" -U replicator -d postgres -v ON_ERROR_STOP=1 -qAt \
    -c "SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = '${SLOT}' AND NOT active" >/dev/null

  gosu postgres pg_basebackup \
    -h "$upstream" -p 5432 -U replicator \
    -D "$PGDATA" \
    --wal-method=stream \
    --create-slot --slot="$SLOT" \
    --write-recovery-conf \
    --checkpoint=fast \
    --progress
  chmod 700 "$PGDATA"
  echo "[lab] $NODE: seeded; primary_conninfo + primary_slot_name written by pg_basebackup -R"
  unset PGPASSWORD
fi

exec docker-entrypoint.sh "$@" -c "cluster_name=${NODE}"
