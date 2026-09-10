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
FROM pgvector/pgvector:pg16

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-16-postgis-3 \
      postgresql-16-postgis-3-scripts \
 && rm -rf /var/lib/apt/lists/*
