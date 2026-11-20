# CloudNativePG operand image for basefyio on ts_cluster: PostgreSQL 16 +
# pgvector + PostGIS, the same extension set as docker/postgres/Dockerfile.
# The stock CNPG image has neither `vector` nor `postgis`; project databases
# and imported schemas need both. Built and pushed by
# .github/workflows/build-cnpg-image.yml; the cluster adopts a build only when
# ts_cluster's projects/basefyio/data/cnpg/cluster.yaml `imageName` (and the
# pg-bootstrap Job's image, kept identical) changes.
#
# PostgreSQL 16 on purpose: the API image ships postgresql16-client, and
# pg_dump must be at least the server's major. Moving the major is a planned
# change on both sides, never a side effect of a rebuild.
#
# Pinned to Debian bookworm (glibc 2.36), the same C library as the compose
# host's docker/postgres image. The C library decides how text sorts: when the
# compose image moved from Alpine (musl) to Debian (glibc) on 2026-05-21, every
# btree index on a text column built before the move was left in the wrong
# order (realms answering 404, users not found by e-mail, unique constraints no
# longer enforced) and it took a REINDEX of 2,878 indexes across 139 databases
# to undo. A trixie base (glibc 2.41) would do the same on some ordinary
# rebuild. The data moves into this cluster logically (pg_dump -> psql, so
# indexes are rebuilt on load); the pin protects every rebuild after that.
# Never change the Debian release without a REINDEX plan.
#
# `16-system-bookworm` is the floating 16.x tag of the `system` type (16.16,
# built 2026-11-16, when this was written). It must be `system`: the cluster's
# in-core barmanObjectStore backups need barman-cloud, which the `standard`
# and `minimal` types do not ship. The old `16-bookworm` tag is deprecated and
# frozen at 16.10 (the postgres-containers README says such rolling tags are
# no longer generated and will be removed). Floating within the major is
# deliberate, as in ts_cluster's nfyio Dockerfile.pgvector: the extension
# packages must match the server minor the base installed, and the apt index
# of an old pinned minor points at PGDG packages that have since been removed.
FROM ghcr.io/cloudnative-pg/postgresql:16-system-bookworm

USER root
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      postgresql-16-pgvector \
      postgresql-16-postgis-3 \
      postgresql-16-postgis-3-scripts; \
    rm -rf /var/lib/apt/lists/*

# CNPG runs the instance manager as uid 26 (postgres in this image).
USER 26
