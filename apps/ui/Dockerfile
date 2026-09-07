# syntax=docker/dockerfile:1.7
# Build stages use the DHI *dev* variant — the only one carrying a shell, apk,
# corepack and npm. The runtime stage below is hardened nginx; see it for why the
# entrypoint and port had to change.
FROM dhi.io/node:24-alpine-dev AS base
# libc6-compat is kept here, unlike apps/api/Dockerfile which drops it. The api's
# dependency closure is pure JS; the UI build is not — Vite/rolldown and esbuild
# ship prebuilt platform binaries. This is a build stage that never ships, so the
# package costs nothing in the final image and removing it would be risk without
# benefit.
RUN apk add --no-cache libc6-compat && corepack enable
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV TURBO_TELEMETRY_DISABLED=1
ENV CI=true

FROM base AS pruner
WORKDIR /repo
COPY . .
RUN pnpm dlx turbo@2.9.4 prune ui --docker

FROM base AS deps
WORKDIR /app
COPY --from=pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /repo/out/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=pruner /repo/out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/ ./
COPY --from=pruner /repo/out/full/ ./
# `turbo prune ui --docker` doesn't pull in examples/schemas/, but the
# brand-theme Vite plugin (apps/ui/vite.config.ts) reads each network's
# brand.json from that tree to emit [data-network=<id>]{...} CSS blocks
# into index.html at build time. Without these files the deployed UI has
# no per-network token block and every network falls back to the default
# :root palette (blue-leaning) — visible as "Blue Dots" colours on the
# Orange Dots deployment. Copy the brand.json files explicitly.
COPY examples/schemas/ /app/examples/schemas/
# `turbo prune` also omits the root tsconfig files. Vite 8 / rolldown's TS
# transform walks up to the root tsconfig (which `extends ./tsconfig.base.json`)
# when bundling workspace-source imports (@dpg/*), so the build fails with
# "Tsconfig not found /app/tsconfig.base.json" without these. Copy them like
# examples/ above.
COPY tsconfig.base.json tsconfig.json /app/
ARG VITE_API_URL
ARG VITE_NETWORK_NAME
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_NETWORK_NAME=$VITE_NETWORK_NAME

# NOTE: there are deliberately no VITE_AUTH_PROVIDER / VITE_KEYCLOAK_* build
# args. Which login screen to render, and the OIDC connection details, come from
# GET /api/v1/auth/config at runtime — see apps/ui/src/lib/keycloak-config.ts.
# Baking them in once caused a bundle built for Keycloak to redirect every user
# into an OIDC flow while the API was still on better-auth. They can still be
# overridden per-deployment through window.__DPG_UI_CONFIG__ (/config.js), which
# cannot go stale inside an image.
# Build BOTH UI variants into one image:
#   - signals (default `build`)        -> apps/ui/dist            (served at /)
#   - orange tourist (`build:tourist`) -> apps/ui/dist/tourist    (served at /tourist)
# Order matters: the signals build empties dist/ (Vite emptyOutDir); the tourist
# build only empties dist/tourist, so running signals first preserves both.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm turbo run build --filter=ui \
  && pnpm --filter ui run build:tourist

FROM dhi.io/nginx:1.31-alpine AS runner
# Hardened nginx. Three things differ from the stock nginx image and all three
# are load-bearing below:
#   1. ENTRYPOINT is ["nginx"] — the official image's docker-entrypoint.sh, and
#      with it the /docker-entrypoint.d/*.sh hook mechanism, exists ONLY in the
#      `-dev` variant. Our startup hook therefore becomes the ENTRYPOINT itself.
#   2. It runs as the unprivileged `nginx` user (uid 65532), which cannot bind a
#      privileged port on a host with the traditional sysctl. In practice the
#      nodes we deploy to set net.ipv4.ip_unprivileged_port_start=0 (also the
#      Docker default), so uid 65532 CAN bind 80 — verified serving HTTP 200
#      with all capabilities dropped. So the port contract stays 80, unchanged
#      from the pre-hardening image. If a host ever restores the traditional
#      sysctl, FOUR places move to 8080 together: the chart's service.targetPort,
#      `EXPOSE 80` below, the entrypoint's `listen 80;`, and the HEALTHCHECK's
#      http://127.0.0.1:80/ (HEALTHCHECK does not expand ${...}, so it cannot be
#      derived from an ENV without switching to shell form). Missing the last one
#      leaves the probe hitting a dead port and flaps the container to
#      `unhealthy` for docker run / compose users.
#   3. busybox IS present (unlike the hardened node image), so /bin/sh exists and
#      the config-generation script below still runs.
# /etc/nginx is chowned to 65532 with g+w by the base image, so the entrypoint
# can still write conf.d/default.conf at boot.
#
# One image carries both builds: signals at the html root, tourist under /tourist.
COPY --from=builder /app/apps/ui/dist /usr/share/nginx/html
# Deploy-time switch: set UI_VARIANT=tourist to serve the tourist build; anything
# else (default) serves the signals UI. A startup hook (this image's ENTRYPOINT,
# which writes the config and then execs the CMD) writes the server block with
# the right docroot.
# /config.js is always served from the html root so the chart's runtime config
# (window.__DPG_UI_CONFIG__) reaches whichever variant is selected.
ENV UI_VARIANT=signals
# Optional host-routed served binding. When UI_HOST_BINDINGS is set (a
# ";"-separated list of "<host>=<network>/<domain>" pairs, injected by the deploy
# chart) nginx picks VITE_SERVED_BINDINGS per request from the Host header, so a
# single instance can serve several per-domain portals (e.g. provider + seeker)
# from one pod. The chart's config.js carries a "__SERVED_BINDINGS__" placeholder
# that sub_filter rewrites to the host's binding ("" for an unmapped host →
# serve-all, which parseServedScope already treats as "all domains"). Unset →
# today's static /config.js, byte-for-byte.
ENV UI_HOST_BINDINGS=""
# --chmod on COPY rather than a `RUN chmod`: the hardened image's default user is
# nginx (uid 65532), so a RUN in this stage would not execute as root and could
# not chmod a root-owned file.
COPY --chmod=0755 <<'EOF' /usr/local/bin/ui-variant-entrypoint.sh
#!/bin/sh
set -e
ROOT=/usr/share/nginx/html
if [ "$UI_VARIANT" = "tourist" ]; then
  ROOT=/usr/share/nginx/html/tourist
fi

if [ -n "$UI_HOST_BINDINGS" ]; then
  # Build the per-request "$host -> $served_binding" map from UI_HOST_BINDINGS.
  MAP_ENTRIES=""
  OLDIFS=$IFS
  IFS=';'
  for pair in $UI_HOST_BINDINGS; do
    host=${pair%%=*}
    binding=${pair#*=}
    [ -n "$host" ] && [ -n "$binding" ] || continue
    MAP_ENTRIES="${MAP_ENTRIES}        ${host} \"${binding}\";
"
  done
  IFS=$OLDIFS
  # `map` must sit in the http{} context; conf.d/*.conf is included there, so a
  # top-of-file map block is valid. `hostnames` => case-insensitive host match.
  MAP_BLOCK="map \$host \$served_binding {
        hostnames;
        default \"\";
${MAP_ENTRIES}    }"
  # Rewrite the placeholder in the mounted config.js with the matched binding.
  CONFIG_LOCATION="location = /config.js {
        alias /usr/share/nginx/html/config.js;
        sub_filter_once on;
        sub_filter_types application/javascript text/javascript;
        sub_filter '__SERVED_BINDINGS__' '\$served_binding';
        add_header Cache-Control \"no-store\" always;
    }"
else
  MAP_BLOCK=""
  CONFIG_LOCATION="location = /config.js { alias /usr/share/nginx/html/config.js; }"
fi

# Port 80, unchanged from the pre-hardening image. This runs as uid 65532, which
# can still bind 80 because the hosts set net.ipv4.ip_unprivileged_port_start=0.
# Verified: HTTP 200 as uid 65532 with --cap-drop ALL.
cat > /etc/nginx/conf.d/default.conf <<NGINXCONF
${MAP_BLOCK}
server {
    listen 80;
    root ${ROOT};
    index index.html;
    ${CONFIG_LOCATION}
    location / { try_files \$uri /index.html; }
}
NGINXCONF
echo "[ui-variant] serving '${UI_VARIANT:-signals}' from ${ROOT}${UI_HOST_BINDINGS:+ (host-routed: ${UI_HOST_BINDINGS})}"
# Hand off to CMD (nginx). exec so nginx becomes PID 1 and receives signals
# directly — the official entrypoint did the same after running its hooks.
exec "$@"
EOF
EXPOSE 80
# Declared explicitly even though it changes nothing at runtime: the hardened
# base already defaults to the unprivileged `nginx` user (uid 65532), which is
# what the entrypoint and the port-80 bind above are written against. Trivy's
# DS-0002 check is static — it looks for a literal USER instruction and reported
# HIGH "specify at least 1 USER command" against this file despite the image
# never running as root (#548). Numeric rather than `nginx` so the check
# resolves it without a passwd lookup.
USER 65532

# Checks the docroot index over HTTP on the port the entrypoint writes into the
# server block. `/` resolves for both variants (try_files $uri /index.html),
# so this is correct whether UI_VARIANT is signals or tourist. Uses wget, which
# this base does ship at /usr/bin/wget (unlike the hardened node image, which
# ships no HTTP client at all) — verified against dhi.io/nginx:1.31-alpine.
# Kubernetes ignores Docker HEALTHCHECKs; this serves compose users and scanners.
# (Trivy DS-0026, #548)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "--quiet", "--tries=1", "--spider", "http://127.0.0.1:80/"]

ENTRYPOINT ["/usr/local/bin/ui-variant-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
