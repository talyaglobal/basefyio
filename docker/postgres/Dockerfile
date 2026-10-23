# The cluster every project database lives in.
#
# pgvector alone was not enough: an imported schema can declare geometry
# columns, and without PostGIS those tables fail to create at all — taking
# their indexes, policies and foreign keys with them, and leaving the
# application to error on every query against them.
#
# Built on the pgvector image rather than the PostGIS one so the data
# directory stays byte-compatible with the running cluster: same upstream
# postgres, same major, one more extension available.
#
# Pinned to a Debian release, not just to pg16. The operating system decides
# the C library, and the C library decides how text sorts. When this image
# moved from Alpine (musl) to Debian (glibc) on 2026-05-21, every btree index
# on a text column that had been built before the move was left in the wrong
# order: equality lookups silently missed rows that were plainly there, and
# unique constraints stopped being enforced. Three Keycloak realms answered
# 404 while their rows sat in the table, 188 users could not be found by
# e-mail, and duplicate rows accumulated behind unique indexes that could no
# longer see the conflict. It took a REINDEX of 2,878 indexes across 139
# databases on 2026-10-23 to undo.
#
# `pgvector/pgvector:pg16` is a floating tag and trixie builds already exist,
# so leaving it unpinned meant that jump — glibc 2.36 to 2.41 — would happen
# on some ordinary rebuild, with no warning and the same consequences.
#
# Changing this line changes the Dockerfile hash, which makes the deploy
# rebuild the cluster image and recreate the postgres container. Do that in a
# planned window, never as part of an application deploy. After any change
# that moves the C library, REINDEX every index on a text column in every
# database before trusting a lookup again.
FROM pgvector/pgvector:0.8.7-pg16-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-16-postgis-3 \
      postgresql-16-postgis-3-scripts \
 && rm -rf /var/lib/apt/lists/*
