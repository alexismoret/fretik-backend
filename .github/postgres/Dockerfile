# The CI database, as close to production as an image gets.
#
# The migrations `CREATE EXTENSION IF NOT EXISTS` four things — pg_trgm,
# pgcrypto, postgis and vector — so a plain `postgres:17` image fails on the
# first migration rather than on a test, and the whole integration job says
# nothing about the code. pg_trgm and pgcrypto ship with contrib; postgis and
# pgvector do not, and no public image carries both.
#
# So one of them is installed on top of the other, and WHICH ONE IS ON TOP is
# the decision this file exists to record.
#
# It used to be `FROM postgis/postgis:17-3.5` + pgvector from apt. That broke
# on 2026-09-08, and not because of a commit: `postgis/postgis` publishes no
# bookworm or trixie variant for 17-3.5 (only alpine), so its Debian line sits
# on bullseye, whose LTS ended 2026-08-31. The `bullseye-security` Release
# file's `Valid-Until` then lapsed, apt rates an expired Release file `E:`
# rather than a warning, and `apt-get update` exited 100 — every CI run past
# that timestamp died at image build, on every branch, saying nothing about
# the code. A base whose distro is EOL is a scheduled outage.
#
# Inverting the layering removes the whole class: pgvector's image is built
# `FROM postgres:$PG_MAJOR-bookworm`, a base that is supported and rebuilt,
# and it inherits the PGDG apt repo the official postgres image configures
# (`/etc/apt/sources.list.d/pgdg.list`), which is where postgis comes from.
#
# It also lands CLOSER to production, which runs PostgreSQL 17 with postgis
# 3.6 and vector 0.8: PGDG bookworm carries postgresql-17-postgis-3 at 3.6.x,
# where the old base pinned 3.5.
#
# Neither version is pinned here, deliberately — the tag tracks the PG major,
# which is what the SQL depends on, and the extension minors follow upstream.
# Pinning them in this file would rot silently against a database nobody pins.
FROM pgvector/pgvector:pg17-bookworm

# `postgresql-17-postgis-3-scripts` carries the SQL that `CREATE EXTENSION
# postgis` runs, and it is a hard `Depends` of the package below — so it is
# installed even under `--no-install-recommends`. Do not add it by hand; a
# second name here would be a second thing to keep true.
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-17-postgis-3 \
  && rm -rf /var/lib/apt/lists/*
