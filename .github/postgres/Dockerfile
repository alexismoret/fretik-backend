# The CI database, as close to production as an image gets.
#
# The migrations `CREATE EXTENSION IF NOT EXISTS` four things — pg_trgm,
# pgcrypto, postgis and vector — so a plain `postgres:17` image fails on the
# first migration rather than on a test, and the whole integration job says
# nothing about the code. pg_trgm and pgcrypto ship with contrib; postgis and
# pgvector do not, and no public image carries both.
#
# Production runs PostgreSQL 17 with postgis 3.6 and vector 0.8. This tracks the
# major version, which is what the SQL depends on; the extension minors follow
# whatever the PGDG repository has, because pinning them here would rot silently
# against a database nobody pins.
FROM postgis/postgis:17-3.5

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-17-pgvector \
  && rm -rf /var/lib/apt/lists/*
