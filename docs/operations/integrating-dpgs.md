# Integrating DPGs (aggregator-dpg, voice-dpg)

Other DPGs on the network — today `aggregator-dpg` and `voice-dpg` —
authenticate to Signals via a **service apikey** plus a per-request
**acting-org assertion** header. Plan 1 (`chore/plan-1-aggregator-service-auth`)
shipped the auth foundation described here.

The pattern is small on purpose: a single apikey identifies the calling DPG;
a header tells Signals which aggregator that DPG is speaking on behalf of for
this particular request.

## The two-header model

Every call from an integrating DPG into the `/api/v1/admin/*` scope sends two
headers:

| Header | Purpose |
|---|---|
| `x-api-key: <key>` | Identifies the calling DPG (`aggregator-dpg` or `voice-dpg`). The shared `auth_middleware` (`apps/api/plugins/auth/auth_middleware.ts`) resolves the key to its owning user and populates `request.user`. |
| `x-acting-org-id: <org_id>` | Identifies the org the call is acting on behalf of. The `acting_org_preHandler` (`apps/api/src/middleware/acting_org.ts`) validates it and populates `request.acting_org`. |

The mental model: **the apikey says who the messenger is; the header says
who they are speaking for.** A single key serves many aggregators because
the integrating DPG is a trusted intermediary that asserts the right org
per request.

Notes on `auth_middleware`:

- Apikey auth has priority over session auth. If `x-api-key` is present and
  invalid the middleware returns `403 INVALID_API_KEY` immediately — it does
  not fall back to session auth.
- If `x-api-key` is absent the middleware falls back to a session lookup
  (used by the UI). The `/api/v1/admin/*` scope assumes the apikey path —
  the `acting_org` preHandler will return `401 UNAUTHENTICATED` if no
  `request.user` was set by an apikey.
- The middleware is gated by `AUTH_MIDDLEWARE_ENABLED` (defaults to `true`).
  See `docs/operations/secrets.md` for the env knob.

## Migrating to Keycloak client-credentials (in progress)

`x-api-key` is being replaced by a standard OAuth2 **client-credentials**
bearer token, as part of the Keycloak migration
(`docs/superpowers/plans/2026-07-23-keycloak-migration-design.md` §5).

**Signals accepts both during the transition.** That compatibility window
exists precisely because aggregator-dpg and voice-dpg live in separate repos
and cannot cut over in the same deploy. `x-api-key` keeps working until every
partner reports zero traffic on it (rollout step R6), and is only removed at
R8. **Nothing about the old path changes today — no action is required to keep
working.**

### What changes, and what does not

| | Today | After |
|---|---|---|
| Who is calling | `x-api-key: <key>` | `Authorization: Bearer <access token>` |
| Who they act for | `x-acting-org-id: <org_id>` | **unchanged** — acting-org is orthogonal to authentication |
| `request.user` / `request.acting_org` | — | **unchanged shape**, so every route behaves identically |

Only the first row changes. The second header stays, and so does the mental
model: the credential says who the messenger is, the header says who they are
speaking for.

### Obtaining a token

Each integrating DPG gets its own **confidential client** in the shared
`bluedots` realm and exchanges its client secret for an access token:

```bash
curl -X POST "$KEYCLOAK_URL/realms/bluedots/protocol/openid-connect/token" \
  -d grant_type=client_credentials \
  -d client_id=aggregator-dpg \
  -d client_secret="$AGGREGATOR_DPG_CLIENT_SECRET"
# -> { "access_token": "eyJ...", "expires_in": 300, ... }
```

Then call signals exactly as before, swapping the credential header:

```bash
curl -X POST http://localhost:2742/api/v1/admin/aggregator/upsert \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'x-acting-org-id: <aggregator-dpg network_service org id>' \
  -H 'Content-Type: application/json' \
  -d '{ "external_id": "agg_bbmp_001", "name": "BBMP", "slug": "bbmp" }'
```

Cache and reuse the token until shortly before `expires_in`; do not fetch one
per request.

### How a client maps to a service user

**By convention: the Keycloak client id must equal the `organization.slug` of
that DPG's service org in signals.** There is no new table and no extra claim
— the client id is looked up as a slug, and the org's member with
`role='service'` is the identity the request runs as. That is the same
`organization` / `member` / `user` triple the seed script already creates, so
an existing deployment needs no data migration; the service user id an
integrating DPG resolves to is identical on both credentials.

If the slugs and client ids do not line up, signals returns
`403 SERVICE_ACCOUNT_NOT_PROVISIONED` and logs the client id it could not
resolve.

### Signals-side configuration

Two env vars gate this (both in `packages/config/src/secrets.ts`):

| Var | Meaning |
|---|---|
| `AUTH_PROVIDER` | Must be `keycloak` for bearer tokens to be considered at all (`dual` has been removed). Default `betterauth` — bearer service auth is inert. |
| `KEYCLOAK_SERVICE_CLIENT_IDS` | Comma-separated client ids allowed on the service path, e.g. `aggregator-dpg,voice-dpg`. **Empty by default**, so no client can use service auth until an operator names it. |

`KEYCLOAK_SERVICE_CLIENT_IDS` is deliberately separate from
`KEYCLOAK_ACCEPTED_CLIENT_IDS` (the human/session clients). Because signals
shares one realm with aggregator, keeping the two lists apart is what stops a
token from the public `signals-ui` client being honoured as a service account,
and stops an integrating DPG's token being provisioned as a human user.

### Failure codes on the bearer path

| Status | `code` | Meaning |
|---|---|---|
| 401 | `TOKEN_EXPIRED` | Token past `exp`. Fetch a new one. |
| 401 | `UNAUTHORIZED` | Malformed token, bad signature, or wrong issuer. |
| 403 | `TOKEN_CLIENT_REJECTED` | Valid realm token, but the client is not one signals serves. |
| 403 | `SERVICE_CLIENT_NOT_ALLOWED` | Client is not in `KEYCLOAK_SERVICE_CLIENT_IDS`. |
| 403 | `SERVICE_ACCOUNT_NOT_PROVISIONED` | No service org/user matches the client id (see the slug convention above). |
| 503 | `IDENTITY_PROVIDER_UNAVAILABLE` | Signals could not reach Keycloak to verify. **Retryable** — this is not an auth failure. |

Treat `503` differently from `401`: it means the token was never judged, so a
retry with the *same* token is correct.

### If both credentials are sent

`x-api-key` wins. Precedence is unchanged from before the window, so a partner
mid-migration sees identical behaviour on the old path. Send one or the other.

## Acting org: the header is becoming a token-verified assertion

**Nothing about the `x-acting-org-id` header changes** — same name, same value,
still sent on every acting-org call. What changes is that signals will stop
taking it on trust.

### Why

`acting_org_preHandler` today validates that the asserted org exists and is an
allowed type, and that the caller is a member of *some* org. It never checks
membership of the **asserted** org. Since `POST /api/v1/admin/participant/decrypt`
scopes decrypted participant PII by `user.onboarded_by_org_id == acting_org.org_id`,
a caller asserting another aggregator's org id reads that aggregator's
participants. That has been held together by the trusted-intermediary model; a
bearer token lets signals verify it instead, because a claim cannot be forged by
the caller whereas a header can.

### The model

Your token carries **`signals_acting_orgs`** — the set of org ids you may act
for. The header still selects which one a given request uses, and signals rejects
any header value outside the set.

| Your token's grant | `x-acting-org-id` | Result |
|---|---|---|
| `["*"]` | any existing org | allowed (today's behaviour) |
| `["org_a","org_b"]` | `org_a` | allowed |
| `["org_a","org_b"]` | `org_c` | **`403 ACTING_ORG_NOT_GRANTED`** |
| `["org_a"]` | *omitted* | allowed — a single-org grant needs no header |
| `["*"]` | *omitted* | `400 MISSING_ACTING_ORG` — a wildcard names no specific org |
| *no claim* | `org_a` | allowed under `claim_preferred`; refused under `claim_required` |

The grant authorises **which** org you may act for, not **what** you may do
there — the `organization.type` capability gate still applies exactly as today.

### Rollout: `ACTING_ORG_SOURCE`

Signals-side flag, mirroring `AUTH_PROVIDER`:

| Value | Behaviour |
|---|---|
| `header` | **Default today.** The header authorises itself; the grant is ignored even if present. Nothing to do. |
| `claim_preferred` | The grant is enforced **when the token carries one**; a token without one falls back to the header. **This is the window** — adopt at your own pace. |
| `claim_required` | A token with no grant is refused on acting-org routes. Terminal. |

Because `claim_preferred` falls back, **you do not need to coordinate a
simultaneous deploy.** An `x-api-key` caller carries no grant, so the old path
keeps working until `claim_required`.

### What you need to do

Nothing, until signals moves off `header`. When it does:

- Your Keycloak client needs a `signals_acting_orgs` mapper. Both DPG clients
  currently ship with a hardcoded `"*"` — see
  `infra/keycloak/realms/bluedots-realm.json` and
  `infra/keycloak/init/apply-user-profile.sh`.
- **`"*"` is provisional.** It preserves today's reach as an explicit, auditable
  grant rather than an unstated default, but it should be narrowed to the orgs
  each DPG legitimately serves. Tell us that set and we will enumerate it.
- Keep sending `x-acting-org-id` exactly as you do now. Only drop it if your
  grant names exactly one org.

### New failure codes

| Status | `code` | Meaning |
|---|---|---|
| 403 | `ACTING_ORG_NOT_GRANTED` | The asserted org is outside your token's grant. Not retryable — fix the grant or the assertion. |
| 403 | `ACTING_ORG_CLAIM_MISSING` | `claim_required` is on and your token carries no grant. Add the mapper. |

The existing `400 MISSING_ACTING_ORG`, `404 ACTING_ORG_NOT_FOUND` and
`403 ACTING_ORG_TYPE_NOT_ALLOWED` are unchanged.

## Organization types

The `organization.type` text column on the better-auth `organization` table
carries one of three values in this model:

- `network_service` — the integrating DPGs themselves
  (`aggregator-dpg`, `voice-dpg`). Their service users are members of these
  orgs. Created by the seed script.
- `aggregator` — every aggregator that has registered with aggregator-dpg,
  mirrored into Signals via `POST /api/v1/admin/aggregator/upsert`.
- `voice` — same shape as `aggregator` but for voice-hosted instances
  (future expansion; the preHandler already accepts the type).

The `acting_org` preHandler accepts all three as valid `x-acting-org-id`
targets. Individual routes can narrow further — e.g.
`POST /api/v1/admin/aggregator/upsert` rejects with
`403 NOT_NETWORK_SERVICE` if the acting org's type is not `network_service`.

## Local dev setup

```bash
docker compose up -d db redis
pnpm db:push:api          # apply better-auth + Drizzle schema to Postgres
pnpm db:init:api          # apply the non-Drizzle SQL bootstrap (items / actions / events)
pnpm db:seed:services:api # create the integrating-DPG service user and apikey
```

The seed script (`apps/api/scripts/seed_service_users.ts`) is idempotent —
re-running it does not mint new keys. For each entry in its `SERVICES` list it
ensures:

1. An `organization` row with `type='network_service'` and the service slug.
2. A `user` row for the service identity (e.g. `aggregator-dpg-svc@signals.local`).
3. A `member` row linking that user to its network-service org with
   `role='service'`.
4. An `apikey` row (prefix `sk_signals_`) owned by that user.

> **`SERVICES` currently contains only `aggregator-dpg`.** Despite what the
> rest of this document implies, `voice-dpg` is *not* seeded — add it to the
> list when that DPG is wired up. This matters for the Keycloak migration too:
> the slug created here is what a client-credentials client id must match.

The minted apikeys print to stdout **on the first run only** — capture them
then. If you lose a key, the recovery path is to delete the corresponding
`apikey` row and re-run the seed.

## Aggregator mirroring

When aggregator-dpg onboards a new aggregator (say, BBMP), it mirrors that
record into Signals so other Signals-aware components can resolve the
aggregator by org id:

```bash
curl -X POST http://localhost:2742/api/v1/admin/aggregator/upsert \
  -H 'x-api-key: <aggregator-dpg apikey from the seed>' \
  -H 'x-acting-org-id: <aggregator-dpg network_service org id>' \
  -H 'Content-Type: application/json' \
  -d '{
    "external_id": "agg_bbmp_001",
    "name": "BBMP",
    "slug": "bbmp"
  }'
# -> { "org_id": "org_<uuid>", "created": true }
```

Idempotency: the lookup key is `slug`. A second call with the same `slug`
updates `name`, `logo_url`, and `metadata` on the existing row and returns
`created: false`. `external_id` is opaque to Signals — it is stored inside
`organization.metadata` for cross-system traceability rather than as its
own column.

After this call, BBMP exists in Signals' `organization` table with
`type='aggregator'`. Subsequent admin-scope calls from aggregator-dpg can
assert `x-acting-org-id: <BBMP's org_id>` and routes will know they are
operating on BBMP's behalf.

Request and response shapes live in
`packages/schemas/src/admin/aggregator_upsert.ts`
(`AggregatorUpsertRequest`, `AggregatorUpsertResponse`).

## Upserting a participant (tier-aware)

`POST /api/v1/admin/participant` is the single endpoint integrating DPGs
use to create or update participants. The behavior splits by the
`acting_org.org_type` asserted via `x-acting-org-id`:

| Tier                   | acting_org.org_type | Onboard new user | Read existing user's items                                     | Update item    | Insert additional item |
|------------------------|---------------------|------------------|----------------------------------------------------------------|----------------|------------------------|
| Ecosystem manager      | network_service     | yes              | yes (full list, served-domain scoped)                          | yes (`item_id`)| yes (omit `item_id`)   |
| Aggregator             | aggregator          | yes              | yes — but **only own users** (cross-aggregator returns `items:[]`) | no             | no                     |
| Voice (future)         | voice               | (rejected today) | (rejected)                                                     | (rejected)     | (rejected)             |

The future voice tier will piggyback on the aggregator behavior: when a
voice instance is delegated to an aggregator, voice-dpg simply starts
asserting the aggregator's `x-acting-org-id` — no code change needed.

### Request

```http
POST /api/v1/admin/participant
x-api-key: <network_service or aggregator apikey>
x-acting-org-id: <org id>
content-type: application/json

{
  "email": "user@example.com",
  "name": "Asha P",
  "age": 35,
  "compliance": [
    { "key": "user_terms", "value": true },
    { "key": "user_privacy", "value": true },
    { "key": "profile_creation", "value": true }
  ],
  "channel": "bulk",
  "item_state": { ... item-schema-validated payload ... },
  "item_id": "optional-uuid-for-update-only",
  "network": "blue_dot",
  "domain": "seeker",
  "item_type": "profile_1.0"
}
```

Identity rule: at least one of `email` or `phone_number` must be provided.

**Consent (`compliance`).** Each entry names a consent the channel captured
from the user; only `value: true` is recorded, into the `consent_record`
ledger. Recognised keys: `user_terms`, `user_privacy` (user-level) and
`profile_creation` (item-level). Unknown keys are ignored. Versions are
derived server-side. See "Consent (`compliance`), age, and activation" below
for validation rules, age requirements, and how a profile gets promoted to
`live`.

### Response

```json
{
  "user_id": "...",
  "user_existed": true,
  "onboarded_at": null,
  "items": [
    {
      "item_id": "...",
      "item_network": "blue_dot",
      "item_domain": "seeker",
      "item_type": "profile_1.0",
      "lifecycle_status": "live",
      "item_state": { ... },
      "created_at": "...",
      "updated_at": "..."
    }
  ],
  "consent_recorded": 3
}
```

`onboarded_at` is set only when this call created a new user; null
otherwise. `items` is scoped to the networks this Signals instance
serves. `lifecycle_status` tells the caller whether the profile is
usable (`live`) or still incomplete/gated (`draft`, `paused`).
`consent_recorded` is the number of `consent_record` rows written by
this call from the `compliance` array (0 when `compliance` was absent
or every entry was `false`/unrecognised).

### Consent (`compliance`), age, and activation

- `compliance` is an optional array of `{ key, value }`. Recognised keys:
  `user_terms`, `user_privacy` (user-level), `profile_creation` (item-level).
- **Accept-only:** any key sent as `false` → `400 CONSENT_DECLINED`; omit a key
  to skip it.
- **`user_terms` + `user_privacy` are a both-or-none pair** → one without the
  other is `400 USER_LEVEL_INCOMPLETE`.
- **On guardian-gated domains** (e.g. `seeker`), sending the consent pair
  requires `age` (integer years, stored as the `user.age` snapshot, #331) →
  else `400 DOB_REQUIRED`. Non-gated domains don't require it; an age already
  on file satisfies it.
- **Activation:** target an existing profile with `item_id` (no `item_state`
  needed) to add `profile_creation` and/or `age` and promote it. A user-level
  call with `age` and no item promotes all the user's eligible drafts.
- The legacy `terms_accepted` / `privacy_accepted` booleans are accepted but
  ignored (deprecated, #309).
- `GET /admin/participant` returns `user_consent { terms_accepted,
  privacy_accepted, has_age }` and per-item `profile_consent_accepted`
  + `lifecycle_status` so callers can see what's outstanding and which profile
  is usable.

### Error matrix (additions)

| Caller shape | HTTP | error | When |
|---|---|---|---|
| acting_org missing | 403 | `INVALID_ACTING_ORG` | request reached the handler without acting_org |
| acting_org_type == 'voice' (or anything not in aggregator/network_service) | 403 | `ACTING_ORG_TYPE_NOT_ALLOWED` | not allowed today |
| network_service + invalid `item_id` (doesn't belong to user) | 403 | `ITEM_NOT_OWNED_BY_USER` | item ownership check failed |
| email + phone race | 409 | `USER_ALREADY_EXISTS` | another caller created the same identity between SELECT and signUp |
| aggregator + participant already locked to another domain | 403 | `DOMAIN_LOCKED` | **not additive.** An account holds profiles in exactly ONE domain (`assertSingleDomain`). A previously-succeeding call now fails if `domain` (or its `'seeker'` default) differs from the domain the participant already holds. Body carries `locked_domain` / `requested_domain`. Per-row, so a batch is unaffected — the row does not land. |

### `POST /api/v1/admin/participant/decrypt` — error matrix (additions)

| Caller shape | HTTP | error | When |
|---|---|---|---|
| aggregator whose org declares no `metadata.domains` | 400 | `NO_DOMAINS_CONFIGURED` | **not additive.** Decrypt is now scoped to the acting org's declared domains and fails closed when there are none, matching `GET /aggregator/dashboard` and `/dashboard/export`. Affects only orgs mirrored before `domains` was sent; re-upsert with a non-empty `domains` array. The same requirement is now enforced when an org is nominated as a **default aggregator** (migration 0017), so the two cannot disagree. |
| aggregator requesting an item outside its declared domains | 200 | — | the id lands in `skipped`, undifferentiated from not-found, so nothing leaks about its existence. |

### Migration from `/admin/onboard_participant`

The old endpoint is removed. Callers update:
- URL: `/admin/onboard_participant` → `/admin/participant`
- Body: `profile` → `item_state`
- Body: `profile_item_id` (not previously used) → `item_id` (now meaningful for network_service updates)
- Response: `profile_item_id` → `items: [...]` (full post-write set)

## Aggregator dashboard — multi-domain by_domain shape

`GET /api/v1/aggregator/dashboard` returns a per-domain rollup + paginated
items. Auth: aggregator-typed acting_org; the `org.metadata.domains`
array must be populated via `/admin/aggregator/upsert` before this endpoint
returns data.

### Setup contract

- The aggregator-dpg caller upserts the aggregator with `domains: ['seeker',
  'provider']` (or the subset relevant to their flow). Persisted under
  `organization.metadata.domains`.
- An empty `domains` array → 400 `NO_DOMAINS_CONFIGURED` on the dashboard.
- `GET /dashboard?domain=seeker` narrows the response to one domain block.
  The `?domain=` value must be in the configured set; else 400
  `DOMAIN_NOT_CONFIGURED`.

### Endpoint

```bash
curl -X GET 'http://localhost:2742/api/v1/aggregator/dashboard?page=1&limit=50&status=at_risk' \
  -H 'x-api-key: <aggregator-dpg apikey>' \
  -H 'x-acting-org-id: <BBMP org_id>'
```

### Response shape

```jsonc
{
  "by_domain": {
    "seeker": {
      "rollup": {
        "total_items": 1247,
        "complete_profiles": 540,
        "has_applications": 894,
        "by_status": { "new": 84, "active": 612, "at_risk": 219, "inactive": 332 },
        "by_action_status": { "create": 1100, "accept": 421, "reject": 192, "cancel": 18 },
        "avg_items_per_user": 1.06,
        "avg_actions_per_user": 1.11,
        "mode_wise_counts": { "bulk": 800, "link": 320, "voice": 60, "self": 0 }
      },
      "items": [ /* per-item rows — see field list below */ ],
      "total_matching": 219,
      "next_cursor": "2"
    },
    "provider": {
      "rollup": { "total_items": 84 /* ... same 7-tile shape */ },
      "items": [ /* same 19-field row shape */ ],
      "total_matching": 12,
      "next_cursor": null
    }
  },
  "metadata": {
    "last_computed_at": "2026-05-26T07:00:00.000Z",
    "ttl_seconds": 3600,
    "refreshed": false
  }
}
```

#### Rollup field semantics

| Field | Meaning |
|---|---|
| `total_items` | COUNT of `item_metrics` rows in scope for this domain |
| `complete_profiles` | COUNT where `profile_completion_pct >= 100` |
| `has_applications` | COUNT where any canonical action bucket > 0 |
| `by_status` | Histogram of `profile_status` (always emits all 4 keys; missing → 0) |
| `by_action_status` | SUM of each canonical bucket count across all in-scope rows (`create`, `accept`, `reject`, `cancel`) |
| `avg_items_per_user` | `total_items / COUNT(DISTINCT owner_user_id)`. 0 if no rows. |
| `avg_actions_per_user` | SUM of all action counts / COUNT of users with at least one action. 0 if none. |
| `mode_wise_counts` | Histogram of `onboarded_via` |

#### Per-item row fields (19 fields, identical across all domains)

```jsonc
{
  "item_network": "purple_dot",
  "item_domain": "seeker",
  "item_type": "profile_1.0",
  "name": "itm_01HX...",                        // resolved display name or item_id fallback
  "onboarded_via": "bulk",

  "profile_status": "at_risk",
  "profile_completion_pct": 67,
  "profile_created_at": "2026-04-11T07:00:00.000Z",
  "profile_last_updated_at": "2026-05-22T07:00:00.000Z",
  "age_days": 45,

  "count_create": 4,
  "count_accept": 0,
  "count_reject": 3,
  "count_cancel": 1,

  "last_create_at": "2026-05-20T07:00:00.000Z",
  "last_accept_at": null,
  "last_reject_at": "2026-05-18T07:00:00.000Z",
  "last_cancel_at": "2026-05-19T07:00:00.000Z",

  "actionable_tags": ["missing_email"]
}
```

`name` is always non-null — the recompute resolves it from `display_name_field`
on the item schema (see below) and falls back to `item_id` if no field is
declared or the value is empty. `item_id`, `owner_user_id`, and
`onboarded_by_org_id` are intentionally absent from the row — they are implicit
from the acting org context.

### `?refresh=true` — force recompute

By default each domain is served from the `item_metrics` cache (TTL controlled
by `DASHBOARD_CACHE_TTL_SECONDS`, default 3600 seconds). Pass `?refresh=true`
to bypass the TTL gate and trigger an immediate recompute.

When `?refresh=true` the recompute uses the **blocking** `pg_advisory_lock`
instead of `pg_try_advisory_lock`. If another request is already recomputing
the same `(aggregator, domain)` pair, the caller waits until that recompute
finishes rather than being served stale data. `metadata.refreshed` in the
response reflects whether a recompute actually ran for at least one domain.

`?refresh=false` (or omitting the param) retains the normal TTL-based behaviour.

### Per-(aggregator, domain) recompute

Each `(aggregator, domain)` pair has its own staleness TTL and PG advisory
lock. Multi-domain aggregators recompute their domains in parallel; one
slow domain doesn't block the other. The top-level `metadata.last_computed_at`
is the earliest across the in-scope domains.

- Per-(aggregator, domain) rows live in `item_metrics`. `last_computed_at`
  per row is the TTL field.
- Each dashboard / export request reads `MIN(last_computed_at)` for the
  (aggregator, domain) pair. If older than `DASHBOARD_CACHE_TTL_SECONDS`
  (default 3600), the handler recomputes synchronously under a Postgres
  advisory lock keyed on `(aggregator_id, domain)`.
- Concurrent requests during a TTL-expired recompute don't pile up: the
  second-and-later requests see `pg_try_advisory_lock` return `false`, serve
  stale data, and let the in-flight recompute land within seconds.
- `metadata.refreshed: true` means *this* request triggered at least one
  domain's recompute; `false` means every in-scope domain was served from
  cache.
- First-ever read for an (aggregator, domain) pair (no rows) is treated as
  stale → triggers compute.

### Filtering + pagination

- `?domain=<one of the configured domains>` narrows the response to one
  domain block. Omit for all configured domains.
- `?status=<one of new|active|at_risk|inactive>` scopes the `items` list (the
  `by_status` rollup always shows the full status histogram regardless of the
  filter).
- `?page=1&limit=50` for offset pagination. Default page=1, default limit=50,
  max 500. Pagination applies inside each returned domain block.
- `total_matching` (per domain block) is the count after filter, useful for
  "showing N of M" UI badges.

The UI hits the API on every filter change. Use TanStack Query (or your
preferred fetcher) and key the cache by `(aggregator_id, domain, page,
limit, status)` with `staleTime: 60_000` so users navigating filters
back-and-forth don't re-fetch.

### network.json contract: metric_categories (canonical bucket vocabulary)

Each interaction that should be tracked in the rollup declares `metric_categories`
mapping its `event_schema.status` enum values to four canonical buckets:

```jsonc
"metric_categories": {
  "create": ["created"],
  "accept": ["accepted"],
  "reject": ["rejected"],
  "cancel": ["cancelled"]
}
```

The four canonical bucket names — `create`, `accept`, `reject`, `cancel` — are
fixed in code. Any key outside this set is a network-config validation error at
boot. Any of the four keys may be omitted (treated as empty). Multiple raw
status values may map to the same canonical bucket
(`"create": ["created", "submitted"]`).

`metric_categories: null` (or absent) on an interaction means
"not tracked in the rollup" — recompute contributes 0 for those counts.
Provider→seeker invite directions remain at null in the current pilot networks;
future product may populate them.

### network.json contract: `display_name_field`

Each `item_schema` entry in `network.json` may declare a `display_name_field`
pointing at a string property within its own JSON Schema. The property must not
be `private: true`. At recompute time, if the value at
`item_state[display_name_field]` is a non-empty string, that value becomes the
row's `name` in dashboard and CSV output. If the field is absent or its value
is empty/null/non-string, `name` falls back to the `item_id` string.

Example (Purple Dot provider):

```jsonc
"item_schemas": {
  "profile_1.0": {
    "display_name_field": "organisation_name",
    ...
  }
}
```

Validation at boot: if declared, the referenced property must exist in the schema
and must not have `"private": true`. A violation prevents the API from starting
(`NETWORK_CONFIG_INVALID`). Schemas where every personally-identifying field is
private simply omit `display_name_field` — items get `name = item_id`.

### network.json contract: `status_rules`

Each domain entry in `network.json` must have a `status_rules` array that
declares how a row's `profile_status` (`new`, `active`, `at_risk`, `inactive`)
is assigned at recompute time. Rules are evaluated top-to-bottom; the first
matching rule wins. The array must end with a `{ "when": "default" }` entry to
guarantee every row receives a non-null status.

```jsonc
"status_rules": [
  { "status": "new",      "when": { "item_age_days": { "lte": 7 } } },
  { "status": "active",
    "when": { "days_since_last": { "buckets": ["create", "accept"], "lte": 30 } } },
  { "status": "at_risk",
    "when": { "days_since_last": { "buckets": ["create", "accept", "reject"], "between": [31, 90] } } },
  { "status": "inactive", "when": "default" }
]
```

The three leaf predicates are `item_age_days` (days since profile was created),
`days_since_last` (days since the most recent action in one of the listed
canonical buckets — evaluates false if no such action exists), and `count`
(sum of canonical bucket counts). All accept `lt / lte / gt / gte / eq / between`
operators; `between: [a, b]` is inclusive on both ends. Top-level keys in a
`when` object are AND-ed; `all: [...]` and `any: [...]` combinators are also
available for explicit AND/OR grouping.

For the complete DSL grammar and validation rules, refer to the spec at
`docs/superpowers/specs/2026-05-26-metrics-config-driven-redesign-design.md`.
A missing `status_rules` array, a missing `default` tail, a `status` outside
the four canonical values, or a bucket name outside `{create, accept, reject,
cancel}` all prevent the API from starting.

### CSV export

```bash
curl -X GET 'http://localhost:2742/api/v1/aggregator/dashboard/export?status=at_risk' \
  -H 'x-api-key: <key>' \
  -H 'x-acting-org-id: <org_id>' \
  -o items.csv
```

Streamed `text/csv` response. Same staleness contract as the dashboard route,
including `?refresh=true` support. The body is generated row-by-row in pages of
5000 so 200k+ rows don't OOM the API process.

19-column layout (in order):

```
item_network, item_domain, item_type, name, onboarded_via,
profile_status, profile_completion_pct,
profile_created_at, profile_last_updated_at, age_days,
count_create, count_accept, count_reject, count_cancel,
last_create_at, last_accept_at, last_reject_at, last_cancel_at,
actionable_tags
```

`?domain=` filters the CSV the same way it filters the dashboard. Multi-domain
orgs see rows from every configured domain in the same CSV unless filtered —
the `item_domain` column tells you which domain each row belongs to.

CSV format notes:
- `name` resolves via `display_name_field` (see above); always non-null.
- `actionable_tags` is pipe-separated (`missing_phone_number|missing_email`) to keep one column per metric. Only schema-derived `missing_<required_field>` tags appear.
- Nullable timestamp cells emit an empty string.
- Standard RFC 4180 escaping: commas, quotes, newlines inside a value wrap the cell in double-quotes; embedded `"` doubles to `""`.
- Filename suggested via `content-disposition: attachment; filename="items_<org_id>_<YYYY-MM-DD>.csv"`.

### Per-aggregator schema override (advanced)

The recompute reads the JSON Schema for `profile_1.0` to score completion + derive `missing_<field>` tags. By default it uses the first network/domain binding configured in `SERVED_DOMAINS`. Aggregators whose items live on a different network can override by setting `organization.metadata = '{"network": "...", "domain": "..."}'` (stored as JSON-stringified text). The aggregator-mirror endpoint (`/api/v1/admin/aggregator/upsert`) accepts a `metadata` field for this purpose.

### Follow-ups (not in pilot)

- **Async export + blob storage**: switch when sync export crosses ~2 min wall time, ~200k rows, or concurrent-export contention. Today's streaming is fine for current scale.
- **Pre-warming**: fire-and-forget recompute on participant onboard so the next dashboard hit is hot. Currently the optional cache invalidation is the simpler stand-in (delete the aggregator's rows on onboard).
- **`q` parameter (free-text search)**: requires a tsvector + GIN index on profile fields. Param is accepted by the schema but ignored today.
- **Inter-instance aggregation**: querying peer Signals instances. Out of pilot scope.
- **Recompute observability**: log/emit duration, processed count, failure rate per recompute.

## What the acting_org preHandler checks

`apps/api/src/middleware/acting_org.ts` runs after `auth_middleware` on
every `/api/v1/admin/*` route. Its checks (in order):

| Failure | HTTP | error code | Cause |
|---|---|---|---|
| `x-acting-org-id` header missing or blank | 400 | `MISSING_ACTING_ORG` | header not sent or empty after trim |
| `request.user` not set | 401 | `UNAUTHENTICATED` | apikey auth did not run (no `x-api-key`) |
| `acting_org_id` does not match any `organization` row | 404 | `ACTING_ORG_NOT_FOUND` | unknown org id |
| Org exists but `organization.type` is null/unknown | 403 | `ACTING_ORG_TYPE_NOT_ALLOWED` | type is not `aggregator`, `voice`, or `network_service` |
| Caller's service user is not a member of any org | 403 | `SERVICE_USER_NOT_REGISTERED` | no `member` row for `request.user.id` |

On success the preHandler attaches:

```ts
request.acting_org = {
  org_id: string,
  org_type: 'aggregator' | 'voice' | 'network_service',
  service_user_id: string,
};
```

and Fastify continues to the route handler. The `FastifyRequest` type
augmentation is declared in `apps/api/types.d.ts`.

## Deferred: per-org allowlist

Today's preHandler accepts **any** `aggregator` / `voice` / `network_service`
org id from **any** service user that is a member of at least one org.
Tightening to "service user X can only assert orgs Y and Z" is intentionally
deferred.

The intended path when this is picked up:

- Encode the allowlist in the better-auth `member.permissions` text column
  (or a sibling table, depending on how granular the policy turns out to
  need to be).
- Add the membership-vs-acting-org check between the org-lookup and
  member-lookup steps in `acting_org.ts`.
- Surface a new error code (e.g. `SERVICE_USER_NOT_AUTHORIZED_FOR_ORG`,
  `403`) for the deny case.

This is safe to defer because:

- Apikeys are only minted by the seed script (operator-controlled).
- `aggregator` and `voice` orgs are only created via the
  `network_service`-gated upsert endpoint.
- The blast radius of a leaked service apikey is "can act for any
  aggregator on this instance", which an operator already needs to assume
  as part of treating the key as a secret.

## Acting on behalf of a user (two tiers)

Two `acting_org.org_type` values may use `acting_as_user_id` on
`POST /api/v1/action/perform`:

- **`aggregator`** — scoped to users that aggregator onboarded
  (`user.onboarded_by_org_id === acting_org.org_id`). For
  counsellor-driven applications, future delegation models, etc.
- **`network_service`** — unrestricted; may act for any user in the
  network. Today's voice-DPG runs at this tier (network-hosted service).

Voice-type acting_orgs are rejected with `403 ACTING_ORG_TYPE_NOT_ALLOWED`
(placeholder; no voice-typed orgs exist in production today).

`POST /api/v1/action/update-status` is **self-acted only** — the caller
must be the target item's owner. There is no `acting_as_user_id` field
on update-status.

### Required headers + body (perform)

```http
POST /api/v1/action/perform
x-api-key: <aggregator-dpg or network_service apikey>
x-acting-org-id: <aggregator or network_service org id>

{
  "action_type": "apply",
  "source_item": { ... },
  "target_item": { ... },
  "requirements_snapshot": { ... },
  "acting_as_user_id": "<target user id>"
}
```

For `/action/perform`, the source item must also be owned by the
effective actor — `403 SOURCE_ITEM_NOT_OWNED_BY_ACTOR` otherwise.

### Authorization matrix (perform)

| Caller shape | `acting_as_user_id` | Outcome |
|---|---|---|
| Session cookie or apikey-as-self | absent | Self-attribution. |
| Session cookie or apikey-as-self | present | `400 CANNOT_OVERRIDE_SELF` |
| `aggregator` apikey + acting_org | absent | `400 MISSING_ACTING_AS_USER_ID` |
| `aggregator` apikey + acting_org | present, user not found | `404 USER_NOT_FOUND` |
| `aggregator` apikey + acting_org | present, own user | `201` |
| `aggregator` apikey + acting_org | present, other-aggregator or self-registered | `403 NOT_AUTHORIZED_FOR_TARGET` |
| `network_service` apikey + acting_org | absent | `400 MISSING_ACTING_AS_USER_ID` |
| `network_service` apikey + acting_org | present, user not found | `404 USER_NOT_FOUND` |
| `network_service` apikey + acting_org | present, user exists | `201` |
| `voice` acting_org | (any) | `403 ACTING_ORG_TYPE_NOT_ALLOWED` |

### Audit columns

`item_actions.performed_by_org_id` + `performed_by_service_user_id` are
populated at create-time only (by `/action/perform`). `/action/update-status`
does not touch them. Inspect the columns to identify the on-behalf-of
caller:

- `network_service` org_id → voice / ecosystem-manager-driven action.
- `aggregator` org_id → counsellor / aggregator-DPG-driven action.
- `NULL` → self-acted (UI session or apikey-as-self).

There are no indexes on these columns today — query via
`WHERE performed_by_org_id = $1` sequentially when needed.

### Migration from update-status acting-as

`/action/update-status` no longer accepts `acting_as_user_id`. Callers
that previously used the on-behalf-of path on update-status must now
either:

- Update status via the target item owner's own session / apikey, OR
- Skip the status update (Plan B's metrics rollup counts statuses
  across rows; the cache catches the next perform without needing a
  formal update-status call).

## Voice DPG follows the same pattern

Voice-dpg uses its own apikey from the seed and asserts `x-acting-org-id`
set to either:

- the aggregator org id when voice is hosted per-aggregator
  (e.g. BBMP runs its own voice instance for itself); or
- a designated network-voice org when voice is network-hosted with no
  aggregator behind it (the org would be created with `type='voice'`).

The Signals-side handler logic does not change — `voice` and `aggregator`
are interchangeable consumers from Signals' point of view. Routes that
need to discriminate (like the aggregator upsert) do so via
`request.acting_org.org_type`.

## Related plans

- [Plan 1 — aggregator service auth](../superpowers/plans/2026-05-21-aggregator-service-auth.md) —
  this plan: auth model, `acting_org` preHandler, seed script, and the
  `/admin/aggregator/upsert` endpoint.
- [Plan 2 — participant onboarding attribution](../superpowers/plans/2026-05-21-participant-onboarding-attribution.md) —
  next up: `POST /api/v1/admin/onboard_participant` for aggregator-dpg /
  voice-dpg to onboard participants, attributed back to the acting org.
- [Plan 3 — participant metrics service](../superpowers/plans/2026-05-21-participant-metrics-service.md) —
  the metrics dashboard each aggregator's UI reads.
- [Plan A — action perform on-behalf-of](../superpowers/plans/2026-05-22-action-perform-on-behalf-of.md) —
  voice DPG files actions on behalf of users it onboarded; adds the
  optional acting_org preHandler, two audit columns on `item_actions`,
  and the `resolve_acting_actor` helper.
