# Postgres 17 with pgvector AND PostGIS — the extension set signals-dpg needs.
#
# WHY: signals-dpg's `db:init` applies apps/api/db/postgres/schema.sql, which runs
#   CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector (item_search embeddings)
#   CREATE EXTENSION IF NOT EXISTS postgis;     -- geo
#   CREATE EXTENSION IF NOT EXISTS cube;         -- earthdistance dep (bundled)
#   CREATE EXTENSION IF NOT EXISTS earthdistance;-- distance sort (bundled)
#   CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- (bundled)
# No single stock image ships both pgvector and PostGIS, and the official
# `postgis/postgis` image has NO arm64 build (breaks on Apple Silicon). So we
# base on `pgvector/pgvector:pg17` (multi-arch, already has pgvector) and add
# PostGIS from the PGDG apt repo the base image already configures. cube /
# earthdistance / pgcrypto are contrib modules bundled with the base image.
# Trivy DS-0002 (no USER) / DS-0026 (no HEALTHCHECK) are ACCEPTED here, not
# oversights — see #548.
#
# DS-0002: the image intentionally starts as root. postgres's docker-entrypoint.sh
# must chown $PGDATA and /var/run/postgresql to the `postgres` user before the
# server can start on a fresh volume, then hands off with `exec gosu postgres`
# (line ~343 of that script). So the database process does NOT run as root; only
# the short init phase does. Pinning `USER postgres` here breaks first-boot
# initialisation on any volume not already owned by uid 999.
#
# DS-0026: this image is never deployed to Kubernetes — helm/signals/charts/
# contains api, ui, notification-service, search, search-embeddings and
# s3-export, and no Postgres component (the clusters use an external/managed
# Postgres). Its only consumers already health-check it at their own layer:
# local-setup/docker-compose.yml runs a `pg_isready` healthcheck, and CI builds
# it as `dpg-ci-db` (.github/workflows/ci.yaml) and polls for readiness
# explicitly. A Docker HEALTHCHECK here would duplicate both.
FROM pgvector/pgvector:pg17

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-17-postgis-3 \
  && rm -rf /var/lib/apt/lists/*
