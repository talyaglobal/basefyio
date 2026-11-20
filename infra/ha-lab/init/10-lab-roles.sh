#!/bin/bash
# Runs once, on initdb of the first primary only (a standby is seeded by
# pg_basebackup and never runs initdb scripts). 01-init.sql, mounted before
# this file, is the production scripts/init-db.sql (creates the keycloak DB).
#
# Adds what Stage 2 of the HA plan adds on the production primary:
#   - a replication role (prod: CREATE ROLE replicator REPLICATION LOGIN);
#   - the pg_hba replication line, the same one prod already has:
#       host replication all samenet scram-sha-256
#   - a monitoring role for pg-role-check (pg_monitor, no data access);
#   - a lab database for the smoke test.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v repl_pw="$LAB_REPL_PASSWORD" -v check_pw="$LAB_CHECK_PASSWORD" <<'SQL'
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD :'repl_pw';
CREATE ROLE rolecheck WITH LOGIN PASSWORD :'check_pw';
GRANT pg_monitor TO rolecheck;
CREATE DATABASE labdb;
SQL

# The image's entrypoint has already written `host all all all scram-sha-256`
# (which does not match replication connections); append prod's line.
echo "host replication all samenet scram-sha-256" >> "$PGDATA/pg_hba.conf"
