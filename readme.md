# DPG

DPG is a network-aware backend for publishing, validating, discovering, and interacting with schema-typed items across many independent instances.

> 📚 **Documentation**: https://blue-dots-economy.github.io/bluedots-docs/ — source at [Blue-Dots-Economy/bluedots-docs](https://github.com/Blue-Dots-Economy/bluedots-docs)
>
> 🚀 **Getting started locally?** `SETUP.md` is the step-by-step local walkthrough (Signals API + UI, plus the optional aggregator-dpg integration). The Quick Start below is the condensed version.

The core model is:

- a network defines the shared contract
- a domain defines a role inside that network
- an instance serves one or more domains
- an item is a versioned schema-typed record
- an action is an interaction between items
- an event is the structured result of that action

This repository contains the current DPG API runtime, schema-driven UI app, example network schemas, and shared packages.

## Repository Layout

- `apps/api`: Fastify API runtime
- `apps/ui`: schema-driven React UI for browsing domains, creating items, and triggering actions
- `examples/schemas`: example network definitions such as `yellow_dot`, `blue_dot`, `purple_dot`, and `orange_dot`, each with a `network.json` and a companion `consent.json` (terms/privacy/profile/action consent copy; brand overrides live in sub-folders)
- `examples/api`: example request payloads in Markdown
- `packages/config`: env parsing, network config loading, and consent config loading
- `packages/database`: database helpers and partitioning
- `packages/schemas`: API request schemas and network schema parsing
- `packages/auth`: auth integration (better-auth + unified OTP; also carries a **dormant** Keycloak provider gated behind `AUTH_PROVIDER`)
- `packages/notification`: notification service client for OTP and outbound messages
- `packages/match_score`: match score service client for item comparison

## Current API Shape

Main route groups:

- `/api/v1/item`
- `/api/v1/action`
- `/api/v1/event`
- `/api/v1/network`
- `/api/v1/match-score`
- `/api/v1/consent` — user- and item-level consent capture (terms/privacy, profile creation, per-action)
- `/api/v1/admin` — service-to-service admin surface (requires `x-acting-org-id`)
- `/api/v1/aggregator`
- `/api/v1/auth` — public, unauthenticated auth-flow config (`GET /api/v1/auth/config`) and the U18 age precheck (`POST /api/v1/auth/u18-precheck`)
- `/api/v1/support` — authenticated contact-support form (`POST /api/v1/support`, with optional image/video/audio attachments) plus `GET /api/v1/support/config` for the client-visible limits
- `GET /health/live` and `GET /health/ready` — Kubernetes probes at the **root** path (not `/api/v1`); `live` is pure process-liveness, `ready` actively probes Postgres + Redis

Important behavior:

- `POST /api/v1/item/create` creates an item on the current instance (accepts an optional `consent` block for profile-creation acceptance)
- `GET /api/v1/item/fetch` fetches items from the current instance only
- `GET /api/v1/network/item/fetch` performs inter-instance fetch for a network/domain
- `GET /api/v1/network/schema/:network/:domain/:itemType` returns one concrete item schema
- `GET /api/v1/network/schemas` returns cached schemas known to the instance (now includes `consent_config` entries)
- `POST /api/v1/network/refetch_schemas` refreshes schema cache
- `GET`/`POST /api/v1/consent/*` reads and records consent; the accepted document **version is always derived server-side** from the loaded `consent.json`, never trusted from the client
- `POST /api/v1/admin/participant/decrypt` returns decrypted participant profile `item_state` for owned items (aggregator scoped to items it onboarded; `network_service` scoped to its served networks)
- `GET /api/v1/auth/config` returns `{ selfSignupAllowed, loginChannels }` derived from server env — the UI uses it to render the login/signup flow; server env stays the single source of truth
- `POST /api/v1/support` submits an in-app contact-support message (requires an authenticated user); it emails `SUPPORT_EMAIL` via the notification service, and returns `503 SUPPORT_NOT_CONFIGURED` when the recipient or notification client is unset. It accepts optional `attachments` (base64 image/video/audio, server-side MIME allowlist + filename sanitisation, up to `SUPPORT_ATTACHMENT_MAX_FILES` files totalling `SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES`), and is rate-limited per user (`429 SUPPORT_RATE_LIMITED`). `GET /api/v1/support/config` returns `{enabled, maxTotalBytes, maxFiles, allowedTypes, allowedExtensions}` so the form self-configures
- `GET /api/v1/network/item/fetch` fans out to peer instances via the `*_local` peer routes (`item/count_local`, `item/fetch_local`), which require an HMAC instance token (see [Inter-instance peer auth](#inter-instance-peer-auth))
- A profile is only network-discoverable once it is **live**: required fields must be complete **and** `profile_creation` consent accepted. Accepting profile consent runs `promoteItemOnProfileConsent`, which re-classifies a `draft` item to `live` (see [Consent](#consent))
- `POST /api/v1/admin/participant` onboards/updates a participant from an integrating DPG (always-create profiles; per-user cap via `MAX_PROFILES_PER_USER`); it accepts a `compliance` consent array + `age`, records the ledger, and promotes the profile to `live` when the U18/consent gate passes. Under-18 onboarding is rejected (`400 U18_NOT_ALLOWED`)
- `GET /api/v1/admin/participant` returns the caller-visible consent/lifecycle status (`user_consent`, per-item `profile_consent_accepted` + `lifecycle_status`); non-owning aggregators get no disclosure
- `POST /api/v1/auth/u18-precheck` is a **public, unauthenticated** age hint for the signup UI (a hint, not the go-live control)
- Under-18 guardian-consent routes live under `/api/v1/consent/u18/*` (`dob`, `status`, `guardian`, `guardian/verify`, `signup/guardian`(+`/verify`), `profile-consent`) plus `GET /api/v1/consent/profile-status`; a minor's profile only reaches `live` on a guardian's OTP-verified `source='guardian'` consent
- `POST /api/v1/action/perform` performs a single action; `POST /api/v1/action/perform/bulk` submits an array and returns per-item results with partial-failure semantics
- `GET /api/v1/action/:action_id/contact-details` returns the counterparty's contact/profile details, masked or unmasked depending on the action's status
- `POST /api/v1/item/lifecycle` transitions an item `pause`/`unpause`/`retire`. **Retire is permanent** — it scrubs the item's PII, de-indexes it from search, cancels every still-open connection, and notifies the affected counterparties
- `POST /api/v1/network/item/discover` is the ranked/searchable/filterable list feed (backed by signals-search, with a native filter + radius fallback when signals-search is unavailable — only relevance ranking is lost); `POST /api/v1/network/item/markers` serves the map viewport. Free-text `q` and facet filters are restricted server-side to declared, non-private fields
- Under-18 (minor) actions are blocked on external/aggregator channels (in-app only, **API-enforced fail-closed**); a minor's bulk action is gated by a single batch guardian OTP covering the whole selection

Item typing is schema-driven. `item_type` is not arbitrary; it should be a schema identifier defined by the network, for example `profile_1.0` or `profile_1.1`.

## UI App

The UI app lives in `apps/ui`. It is a React 19 + Vite frontend that renders pages from network and item schemas instead of hard-coding per-domain forms and cards.

Current UI responsibilities:

- browse items by domain
- create and edit schema-driven profiles
- render public item cards
- share a profile via a public link and open it on a public profile view page
- filter and sort **My Actions** per profile (PII-aware, server-enforced)
- first-time-login redirect into an in-shell profile form with inline consent
- trigger action flows
- show map-based views through a pluggable map provider layer (follows the app's dark/light theme)

UI runtime envs:

- `VITE_API_URL`: base URL of the API app
- `VITE_MAP_PROVIDER`: active map provider, default `leaflet`
- `VITE_GEOCODING_API_URL`: optional geocoding override

## Quick Start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

There is a **single `.env` at the repo root** covering the API, database, cache,
and the UI (`VITE_*`). Copy it for a local `blue_dot` run; the only value you
must add by hand is `INSTANCE_SHARED_SECRET` (required, min 32 chars — see
below), which is not yet pre-filled in `.env.example`:

```bash
cp .env.example .env
```

The values that matter most (all pre-filled in `.env.example`):

```bash
INSTANCE_ENV="development"
API_DOMAIN="http://localhost"
API_PORT="2742"
SERVED_DOMAINS="blue_dot/seeker,blue_dot/provider"
NETWORK_CONFIG_SOURCE="local"
# Path is resolved from apps/api/, so it must start with ../../
NETWORK_CONFIG_LOCAL_FILE="../../examples/schemas/blue_dot/network.json"
POSTGRES_HOST="127.0.0.1"
POSTGRES_PORT=5432
REDIS_HOST="127.0.0.1"
REDIS_PORT=5555
# Required: base64-encoded 32 bytes (AES-256) used to encrypt participant PII.
# A working dev key is pre-filled; generate a fresh one for any deployed env:
#   openssl rand -base64 32
SIGNALS_PII_KEY='<replace-me>'
```

Consent documents are loaded from a `consent.json` beside the active
`network.json` (`CONSENT_CONFIG_SOURCE=local` by default).

A few more envs govern signup, inter-instance trust, PII, and support. All have
safe defaults **except `INSTANCE_SHARED_SECRET`, which is required** (min 32
chars) and is **not** yet in `.env.example` — set it before starting the API:

```bash
# Peer auth for the inter-instance *_local routes (HMAC instance token).
# Must be IDENTICAL across every instance of a network. Required, min 32 chars.
INSTANCE_SHARED_SECRET="<shared 32+ char secret>"
PEER_AUTH_MODE="permissive"      # permissive (default) | enforced

# Self-signup + login. gated (default): no self-service signup via the public
# OTP flow — onboard participants via POST /api/v1/admin/participant.
# allowed: opens public self-registration.
SELF_SIGNUP_MODE="gated"
LOGIN_CHANNELS="phone,email"     # ordered subset of phone,email

# DLT-approved provider template id for OTP SMS (login + guardian OTP);
# defaults to "login_otp". Set alongside the NOTIFICATION_SERVICE_* creds when
# CREATE_TEST_OTP is off. (Distinct from the per-event lifecycle SMS templates,
# which live in apps/api/src/notifications/sms/*.properties.)
SMS_TEMPLATE_ID=""

# Max profiles a single user may hold (default 5). A network.json domain's
# max_profiles_per_user overrides this per-domain.
MAX_PROFILES_PER_USER=5
# XADD MAXLEN cap bounding the item-events Redis stream.
INGEST_STREAM_MAXLEN=100000

# Private-location (PII) jitter: the metre annulus a true coordinate is offset
# into before storage. Keyed by SIGNALS_PII_KEY; bounds enforced 50–1000 m.
PII_LOCATION_JITTER_MIN_METERS=100
PII_LOCATION_JITTER_MAX_METERS=250

# Recipient for the in-app "Contact support" form; unset → 503 + button hidden.
SUPPORT_EMAIL="hello@bluedotseconomy.org"

# Contact-support attachment budget (image/video/audio). Enforced server-side on
# the DECODED bytes; the per-route body limit is derived from these. Callers must
# stay at or below the notification-service's NOTIFY_ATTACHMENT_* caps.
SUPPORT_ATTACHMENT_MAX_FILES=3
SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES=5242880

# Support/grievance address rendered into the CONSENT copy (T&C/Privacy/
# Grievances) in place of the __SUPPORT_EMAIL__ placeholder the consent.json
# files ship. Distinct from SUPPORT_EMAIL above (the contact-form recipient).
CONSENT_SUPPORT_EMAIL="hello@bluedotseconomy.org"

# Optional override of the bundled email copy (subjects/bodies/CTA labels for
# every email the API sends). Unset → bundled defaults; per-network/brand copy
# also layers from a messages.properties beside network.json in local mode.
# See docs/operations/email-copy-overrides.md.
EMAIL_MESSAGES_PATH=""

# Host -> "network/domain" map for a split-UI deployment, identical to the
# string the UI ingress uses. Inverted at boot so an email CTA points the
# recipient at their own portal instead of the combined front-door. Empty =
# single-host install (FRONTEND_BASE_URL is the only source). #569/#602 — see
# docs/operations/local-split-ui.md.
UI_HOST_BINDINGS=""

# Auth provider. betterauth (default) uses the in-repo better-auth + OTP flow;
# keycloak switches the API to validate Keycloak-minted tokens instead. The
# Keycloak path ships but is DORMANT under the default — flipping to keycloak
# is migration-gated (see packages/auth/CLAUDE.md).
AUTH_PROVIDER="betterauth"
```

For remote network configs, use:

```bash
NETWORK_CONFIG_SOURCE="remote"
NETWORK_CONFIG_URLS="yellow_dot=https://registry.example.com/schemas/yellow_dot/network.json"
```

Or use `SCHEMA_REGISTRY_URL` with either:

- one base URL
- comma-separated `network=url` mappings

### 3. Start PostgreSQL and Redis

```bash
docker compose up -d db redis
```

### 4. Set up the database (first time only)

```bash
pnpm db:push:api           # apply better-auth + Drizzle schema (may prompt to confirm)
pnpm db:init:api           # create partitioned items / actions / events tables
pnpm db:seed:services:api  # mint the service user + apikey (idempotent)
```

See `SETUP.md` for the full walkthrough and the aggregator integration steps.

### 5. Start the API

```bash
pnpm dev:api
```

To run the API itself as a container against the Compose PostgreSQL and Redis services:

```bash
docker compose up -d db redis
DOCKER_NETWORK=dpg_internal pnpm docker:api
```

To run the UI app:

```bash
pnpm dev:ui
```

Typical local UI env:

```bash
VITE_API_URL="http://localhost:2742"
VITE_MAP_PROVIDER="leaflet"
```

## Useful Commands

- `pnpm dev:api`
- `pnpm build:api`
- `pnpm preview:api`
- `pnpm start:api`
- `pnpm db:generate:api`
- `pnpm db:migrate:api`
- `pnpm db:push:api`
- `pnpm db:init:api` — create partitioned items / actions / events tables
- `pnpm db:seed:services:api` — mint the service user + apikey
- `pnpm db:seed:purple_dot:api` — seed purple_dot sample data
- `pnpm db:backfill:consent:api` — one-off deploy backfill for the consent-gated discoverability change (#275); re-classifies existing profiles against the consent gate
- `pnpm db:studio:api`
- `pnpm dev:ui`
- `pnpm build:ui`
- `pnpm preview:ui`
- `pnpm dev:tourist` / `pnpm build:tourist` — the tourist (OneTAC) UI build variant
- `pnpm typecheck`
- `pnpm schema:bundle` — regenerate `apps/api/db/postgres/schema.sql` from the Drizzle schema

## Examples

Local schema examples:

- `examples/schemas/yellow_dot/network.json`
- `examples/schemas/blue_dot/network.json`

API payload examples:

- `examples/api/yellow_dot.md`
- `examples/api/blue_dot.md`

## Service Integrations

DPG treats notification delivery and match scoring as replaceable service integrations behind package-level clients.

- Notification service: [signals-dpg-notification-service](https://github.com/Blue-Dots-Economy/notification-service)
- Match score service client: [signals-dpg-match-engine](https://github.com/Blue-Dots-Economy/match-engine)

## Fetch Model

DPG uses two fetch paths:

- `GET /api/v1/item/fetch`: instance-local fetch, intended for local reads such as a user's own items; cached briefly in Redis
- `GET /api/v1/network/item/fetch`: inter-instance fetch, which performs count-first discovery, selects only relevant peer instances, then fetches the required slices and caches the result in Redis

## Inter-instance peer auth

The peer-only `*_local` routes (`network/item/count_local`,
`network/item/fetch_local`) that back inter-instance fetch are guarded by an
HMAC **instance token** bound to the request path and body. The signing material
is `INSTANCE_SHARED_SECRET`, which must be identical across every instance of a
network. `PEER_AUTH_MODE` gates the rollout:

- `permissive` (default) — a *missing* token is allowed (for peers not yet
  upgraded), but a present-but-invalid/expired token is rejected `401
  PEER_AUTH_FAILED`.
- `enforced` — a valid token is required on every peer call.

## Private-location jitter

Private (PII) locations are never stored at their true coordinate. At storage
time each private location is offset to a deterministic, keyed-random point in a
`PII_LOCATION_JITTER_MIN_METERS`–`PII_LOCATION_JITTER_MAX_METERS` annulus
(default 100–250 m). The offset is seeded from the coordinate itself and keyed
with `SIGNALS_PII_KEY`, so re-saving a profile never drifts the pin and repeated
public snapshots cannot be averaged back to the true location.

## Consent

Consent Management v1 records participant consent as an append-only ledger
(`consent_record`) across three levels:

- **User-level** — terms of service and privacy policy (`/api/v1/consent`).
- **Item-level** — profile-creation consent, captured with the profile item
  (`create_item` accepts an optional `consent` block).
- **Action-level** — per-action consent at `initiate` and `accept` stages of
  interactions such as `connect` and `apply`.

Consent now gates **discoverability**: a profile becomes network-visible
(`lifecycle_status = live`) only when its required fields are complete **and**
`profile_creation` consent has been accepted. Accepting profile consent calls
`promoteItemOnProfileConsent`, which re-runs the same completeness classifier
used on write (with consent now true) and flips a `draft` item to `live`
(`paused` is sticky; `live` is unchanged). A one-off deploy backfill,
`pnpm db:backfill:consent:api`, re-classifies existing profiles against this gate.

Which gates a profile must clear to go `live` is **configurable per domain** via
`go_live_required` in `network.json` (`schema_required`, `consent_required`
and/or `owner_required`; default `schema_required`). A `guardian_consent_required`
domain must keep `consent_required` in the list — config that dropped it would
silently disable the U18 age control, so it is rejected at load.

**U18 guardian gate.** On domains where `guardianConsentRequired` is true, a
minor (`user.age <= 18` — an age snapshot captured at registration, #331)
cannot reach `live` on their own self-consent; only a guardian's OTP-verified
`source='guardian'` `profile_creation` row promotes it. The gate is
fail-closed: a null `age` on a gated domain is never treated as adult. The
server-to-server `/admin/participant` API rejects under-18 onboarding outright
(`U18_NOT_ALLOWED`) — minors complete onboarding through the portal.

Consent copy lives in a `consent.json` beside each network's `network.json`
(brand overrides in a brand-named sub-folder), is loaded via
`CONSENT_CONFIG_SOURCE` (`local` by default) and cached alongside network
schemas. The **document version recorded in the ledger is always resolved
server-side** from the loaded config for the `(network, brand, category[,
actionType, stage])` tuple — the client cannot record acceptance of a version it
never saw. This replaces the old inline `consent_text_initiator` /
`consent_text_receiver` fields that used to live in `network.json` action
definitions.

## Notes

- `item_type` values should come from the network schema, not from freeform client input.
- The backend generates `item_instance_url` and `item_schema_url` during item creation.
- Inter-instance schema fetching and caching are part of the network layer, not the item-local layer.
