# One-shot bootstrap image for signals-dpg's database.
#
# WHY THIS EXISTS: signals-dpg's production API image (apps/api/Dockerfile) is
# pruned to prod-only dependencies, so it does NOT contain drizzle-kit or tsx
# and therefore cannot run migrations or the init/seed scripts. This image
# installs the FULL dependency set (dev included) so the compose can run, in one
# shot and on the correct linux/arm64|amd64 platform:
#
#   pnpm --filter api exec drizzle-kit push   (apply Drizzle schema)
#   pnpm --filter api db:init                 (extensions + items/actions/events tables)
#   pnpm --filter api db:seed:services        (OPTIONAL — only for integrating DPGs)
#
# Build context is the signals-dpg repo root (../ from this file, set as `..`
# in ../docker-compose.yml). It is a throwaway "tools" container: it runs to
# completion once, then exits 0. signals-api waits for it via
# `depends_on: condition: service_completed_successfully`.
#
# Installing here is independent of your host node_modules (which may be built
# for macOS), avoiding the classic bind-mount platform mismatch.

# syntax=docker/dockerfile:1.7
# Trivy DS-0002 (no USER) / DS-0026 (no HEALTHCHECK) are ACCEPTED here — see #548.
#
# This image never ships: it is a one-shot local-compose tools container that
# runs to completion and exits 0 (signals-api gates on
# `depends_on: condition: service_completed_successfully`). It is not published
# to GHCR and not deployed to any cluster.
#
# DS-0002: `pnpm install` writes the full dev dependency set into /repo, which
# COPY lands root-owned; switching to a non-root USER would fail the install.
# DS-0026: a container whose whole job is to exit has no steady state to health-check.
FROM node:24-alpine

RUN apk add --no-cache libc6-compat bash && corepack enable
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV TURBO_TELEMETRY_DISABLED=1
ENV CI=true

WORKDIR /repo
COPY . .

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Default command; overridden/echoed in docker-compose.yml for clarity.
# NOTE: `drizzle-kit push --force` (not the `db:push` script) because
# drizzle.config.ts may prompt for confirmation — there is no TTY here, so the
# plain script would hang / exit 1.
CMD ["sh", "-lc", "pnpm --filter api exec drizzle-kit push --force && pnpm --filter api db:init"]
