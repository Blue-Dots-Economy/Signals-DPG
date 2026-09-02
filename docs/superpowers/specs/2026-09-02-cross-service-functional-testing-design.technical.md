# Cross-Service Functional Testing Design

**Audience:** the system architect, DPG service owners, and the DevOps/release engineer, who need to understand how the multi-service functional journeys spanning signals-dpg, aggregator-dpg, signals-search and notification-service become an automated release gate instead of a manual runbook pass.

---

## Contents

1. [Introduction](#1-introduction)
2. [Background & Problem Statement](#2-background--problem-statement)
3. [Key Design Problems](#3-key-design-problems)
4. [Design](#4-design)
5. [Data Model](#5-data-model)
6. [API Spec](#6-api-spec)
7. [Summary](#7-summary)

---

## 1. Introduction

This document describes a two-layer automated testing system for the DPG
ecosystem: a **contract layer** that verifies provider/consumer wire agreement
on every service pull request, and a **journey layer** that drives real
multi-service user journeys against the exact container images a release ships.

Terms used throughout, consistent with `signals-dpg/CLAUDE.md`:

- **network** — the shared contract, e.g. `purple_dot`, defined by a `network.json`.
- **domain** — a role inside a network, e.g. `seeker`, `provider`.
- **item** — a versioned schema-typed record, e.g. `profile_1.0`.
- **action** — an interaction between two items; **event** — its structured result.
- **journey** — in this document, one end-to-end flow that crosses at least one
  service boundary. Journeys are labelled J1–J5.
- **contract** — the wire agreement between one consumer and one provider,
  whether HTTP (an OpenAPI path) or event (a Redis Stream envelope).

The design covers:

- what constitutes an end-to-end test at each layer, and which layers the
  ecosystem already has;
- the topology of a hermetic four-service stack runnable in CI and locally;
- how identities are seeded without OTP capture or test-only product code;
- which journeys are automated, against which networks;
- what triggers each layer, and the one gating limitation that follows.

---

## 2. Background & Problem Statement

### Background

Functional verification across the DPG services is today a human procedure.
`signals-dpg/docs/operations/e2e-purple-dot-runbook.md` is 479 lines and six
steps. Steps 1–3 are driven through the aggregator UI (self-registration with
OTP retrieved from Mailpit, QR link creation, CSV bulk upload); steps 4–5 are
scripted (`pnpm e2e:qr`, `pnpm e2e:actions`); step 6 is an operator comparing
dashboard rollup numbers against a table in the document.

The scenario is not the weak part. It ships with a deterministic fixture
generator (`scripts/e2e/generate_fixtures.mts`, a mulberry32 PRNG seeded for
byte-identical reruns, populating every required field from the network schema),
two driver scripts, and fully enumerated expected assertions — `by_status`,
`by_action_status`, `mode_wise_counts`, and a documented negative-direction
check that `metric_categories: null` interactions must not inflate any bucket.
What is missing is a machine to execute it.

The layers below the journey are in better shape than the journey itself:

```
 layer                     state
 ─────────────────────────  ──────────────────────────────────────────────
 unit                      strong    ~750 vitest files, all 4 repos, per-PR
 service integration        uneven   signals-dpg ~25 suites but advisory;
                                     notification-service real Redis;
                                     signals-search Testcontainers;
                                     aggregator-dpg NONE (all mocked)
 contract                  missing   openapi.json emitted + freshness-gated
                                     in 3 of 4 repos, but never verified
                                     against a consumer
 cross-service journey     manual    the purple_dot runbook
 UI end-to-end             missing   no Playwright/Cypress anywhere
 post-deploy smoke         missing   install.sh checks pod readiness only
 migration verification    partial   db:check:parity, schema:bundle:check
                                     exist but gate no release
```

> **Note on the integration layer:** signals-dpg's ~25 `*.integration.test.ts`
> suites run only inside the `sonar` CI job under `continue-on-error`. They
> exist and they pass, but a regression in them is advisory rather than
> blocking. Promoting them to their own required job is adjacent to this design
> and cheap; it is called out as an open question in §4.8 rather than folded in.

### Problem Statement

**Problem 1 — the journey suite's test runner is a person.**
*Core challenge:* a well-specified scenario with exact expected values cannot
gate a release if executing it costs an operator an afternoon.
Because the cost is human time, the pass gets skipped or partially performed
under deadline, which is precisely when it matters most. The three UI-driven
steps are the binding constraint: they are why the whole procedure is manual,
even though steps 4–5 are already automated.

**Problem 2 — the `signals:item-events` envelope is declared twice.**
*Core challenge:* two independent declarations of one wire contract agree only
by the continued care of their authors.
`signals-dpg/apps/api/src/utils/publish_item_event.ts` declares
`interface ItemEvent`. `signals-search/src/ingest/stream_consumer.ts` declares
`ItemEventSchema` (Zod). They agree today. Note the asymmetry that makes naive
sharing wrong: the producer interface **omits** `occurred_at`, which is injected
at `xadd` time, while the consumer **requires** it. Any shared schema must
therefore describe the serialized wire payload, not the producer's input type.

**Problem 3 — HTTP contract drift is discovered in production.**
*Core challenge:* a provider can remove or narrow a response field with a green
CI run in its own repo, because no consumer is present to object.
Each repo emits an `openapi.json` and three of four enforce its freshness in CI,
so the specs provably match the code — but nothing diffs them against a prior
version, and every consumer's tests mock the provider's response shape. This is
the failure class behind the cross-repo cutover history (signals-dpg #103, #104,
#112, #115, #122, tracked in #124, with aggregator-dpg #399 as the back-compat
resolver pattern).

**Problem 4 — only one network of four has any cross-service coverage.**
*Core challenge:* each network's `network.json` carries a different interaction
matrix, `metric_categories` and `status_rules`, so coverage of one network
generalizes poorly to the others.
`blue_dot` declares 31 vectorize-marked fields against `purple_dot`'s 9, making
it far more exposed to search-ingestion regressions. `orange_dot` is
single-domain, which exercises the `items.created_by NOT NULL` phantom-account
path that a two-domain network never reaches.

**Problem 5 — nothing is triggered by a release.**
*Core challenge:* the release artifacts are built but never functionally
exercised before deployment.
All four services publish an image on a `20*-s*-rc*` tag — signals-dpg and
notification-service from dedicated build workflows, aggregator-dpg and
signals-search from a `publish-image` job inside `ci.yml`. No workflow consumes
that fan-out.

---

## 3. Key Design Problems

Restated as design targets, with the chosen direction for each:

| # | Target | Direction |
|---|---|---|
| P1 | Execute the journey without an operator | Hermetic four-service stack in CI; identities minted via Keycloak Admin API so the three UI steps become API calls (§4.2, §4.3) |
| P2 | Make the event envelope one contract | Shared JSON Schema describing the *wire* payload, asserted from both sides against shared fixtures (§4.6) |
| P3 | Catch HTTP drift in the causing PR | `oasdiff breaking` per repo per PR, exploiting the existing spec-freshness guarantee (§4.6) |
| P4 | Cover networks in proportion to risk | Tiered coverage: `purple_dot` and `blue_dot` full, `orange_dot` narrow, `yellow_dot` excluded (§4.5) |
| P5 | Bind the suite to the release | Same fleet-wide tag string on the suite repo; resolve all four images to digests before running (§4.7) |

---

## 4. Design

### 4.1 Two layers, because the two triggers want different things

The system is deliberately split rather than unified. A per-PR check and a
per-release check have incompatible cost budgets, and forcing one suite to
serve both produces something too slow to gate a PR and too shallow to gate a
release.

```
┌──────────────────────────────────────────────────────────────────────┐
│  CONTRACT LAYER            per service PR      ~60-90s   no containers│
│                                                                       │
│   openapi.json  ──oasdiff breaking──▶  fail if consumer-visible break │
│   xadd payload  ──ajv──▶ item-event.v1.json ◀──ajv──  parseEvent      │
└──────────────────────────────────────────────────────────────────────┘
                                   │
                                   │  a green contract lane is the
                                   │  precondition for the journey
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  JOURNEY LAYER             per RC tag          ~5-8min   full stack    │
│                                                                       │
│   4 images @digest ──▶ compose ──▶ seed ──▶ J1..J5 × 3 networks       │
└──────────────────────────────────────────────────────────────────────┘
```

The layers are also ordered by value density. The contract layer costs days to
build and addresses Problems 2 and 3, which have recurred repeatedly. The
journey layer costs roughly two weeks and addresses Problem 1. Building the
contract layer first means the journey layer inherits a codebase whose wire
contracts are already pinned, so a red journey is far more likely to indicate a
genuine behavioural regression than a shape mismatch.

### 4.2 A hermetic stack, not a shared environment

The journey layer boots its own stack from published images rather than running
against a deployed cluster. The reasoning is that a shared environment fails at
the two things a release gate most needs: it cannot be reproduced locally when
red, and its state is shared, so a flaky run cannot be distinguished from a
regression.

```
┌─ compose.e2e.yaml ─────────────────────────────────────────────────────┐
│                                                                        │
│  postgres-pgvector      redis        keycloak(realm)      mailpit      │
│        │                  │              │                   ▲         │
│        ├──────────────────┼──────────────┼───────────────────┤         │
│        │                  │              │                   │         │
│  ┌─────▼──────┐    ┌──────▼──────┐  ┌────▼─────────┐  ┌──────┴──────┐ │
│  │ signals-dpg│◀───│ aggregator  │  │ signals-search│  │notification │ │
│  │    api     │    │  api+worker │  │ worker + api  │  │ svc + worker│ │
│  └─────┬──────┘    └─────────────┘  └───────▲──────┘  └──────▲──────┘ │
│        │                                    │                 │        │
│        └── xadd signals:item-events ────────┘                 │        │
│        └── HTTP notification client ──────────────────────────┘        │
│                                                                        │
│  stub-embedder (EMBEDDING_URL)      stub-provider (SMS/WhatsApp)       │
└────────────────────────────────────────────────────────────────────────┘
```

Postgres is the org's own `postgres-pgvector` image, which is required rather
than preferred: the stock image crashed with SIGILL on hosts without AVX-512,
and that image is the fix.

The deliberate omission is deployment configuration. Helm values, Kong
ingress, cert issuance and cross-namespace wiring are **not** covered by a
compose stack, and `DEPLOYMENT.md` already notes that `install.sh` verifies pod
readiness without verifying cross-namespace reachability. That is a real gap,
and the right home for it is a post-deploy smoke phase in
`bluedots-automation` **(planned)** rather than a compromise in this layer.

> **Note on the embedder:** TEI serving bge-m3 requires roughly 8Gi, against a
> standard GitHub runner's 16GB for the entire stack. The stack therefore points
> `EMBEDDING_URL` at a stub returning deterministic, dimension-correct vectors.
> This is not a fidelity compromise for the gate's purposes: the contract under
> test is the event envelope, the `item_search` upsert, the embedding-dimension
> invariant, the filter-then-rank plumbing and retrievability — all of which the
> stub exercises, and all of which become *more* reliably asserted once the
> vectors are deterministic. Ranking *quality* is a genuinely different
> question, answered by an offline eval rather than a release gate.

### 4.3 Identity seeding through real auth paths

The three manual runbook steps all have API routes already —
`aggregator-registrations.ts`, `aggregator-org-approvals.ts`,
`registration-links.ts`, `bulk-uploads.ts`. What made them manual was
authentication, not the absence of an endpoint: `requireAuth` in
`registration-links.ts` demands an approved JWT carrying `aggregator_id` and
`aggregator_type`, and obtaining one meant registering through the UI and
retrieving an OTP from Mailpit.

That dissolves once Keycloak is inside the stack. Both claims are **user
attributes** mapped to JWT claims by protocol mappers in the checked-in
`aggregator-dpg/infra/keycloak/realms/realm.json`, and `render-realm.sh`
already substitutes environment values into that template at container start so
the same realm boots anywhere.

```
Admin API: create user (enabled=true)
           attributes { aggregator_id, aggregator_type }
           set password
                    │
                    ▼
   direct-grant token request  ──▶  JWT with real claims
                    │
                    ▼
   POST /admin/v1/... ──▶ requireApproved() ──▶ genuine authz path
```

The important property is that nothing here is a bypass. No test-only endpoint,
flag or claim-forging shim enters product code; the harness creates a real user
and the service performs its real check. A backdoor would have been faster and
would have made every J1 assertion meaningless about authorization.

Three identity primitives are needed in total:

| Identity | Mechanism |
|---|---|
| Signals service identities — aggregator's api-key + acting-org, voice-bot's key | Extend `seed_service_users.ts` to accept **pinned** org ids and raw keys from env rather than randomizing |
| Aggregator operator JWTs | Keycloak Admin API + direct grant, as above |
| Approved-org rows | Created through the real `aggregator-org-approvals` endpoint as a seeded network-admin |

The first row is worth dwelling on because it repays effort outside testing.
`seed_service_users.ts` is idempotent and already mints organization, user,
member and apikey rows — but it generates a random org id and prints the key
once. That randomness is exactly the mismatch behind the orange_dot production
503: provisioning randomized the org id while aggregator pinned `actingOrgId`,
so the API returned `403 Invalid API key` and the aggregator surfaced 503.
Making ids and keys pinnable via environment serves the harness and removes the
provisioning hazard in one change.

### 4.4 Why compose rather than Testcontainers

signals-search already uses Testcontainers correctly, and this design does not
disturb that. The journey layer nonetheless uses `docker compose`, for two
reasons that both follow from the layer's premise.

First, the premise is testing the artifacts being shipped, which means pinning
published image digests and mounting Keycloak realm imports and `network.json`
configuration declaratively. Compose expresses that in one reviewable file;
programmatic container wiring expresses it in imperative setup code.

Second, and more decisively: when a cross-service suite goes red, the engineer's
first move is to reproduce it locally. A compose file makes that one command
against an identical topology. A dozen containers wired programmatically inside
a test runner makes it an exercise in reading harness code. Testcontainers is
the better tool at single-service scope, where the container set is small and
the reproduction question rarely arises.

### 4.5 Tiered network coverage

Full coverage would be five journeys across four networks — twenty
combinations, most of which re-assert the same code path against a different
field list. Coverage is therefore allocated by distinct risk:

| Network | Coverage | Distinct risk it carries |
|---|---|---|
| `purple_dot` | Full J1–J5 | The only network with a proven expected-assertion table; the reference scenario |
| `blue_dot` | Full J1–J5 | 31 vectorize-marked fields (vs 9) and the 6-domain front door — highest search-ingestion exposure |
| `orange_dot` | J1 only | Single-domain; the only network reaching the `items.created_by NOT NULL` phantom-account path |
| `yellow_dot` | Excluded | — |

`yellow_dot` is excluded by decision. The one case it uniquely carried — a
network declaring zero vectorize fields must index as a no-op rather than error
— moves to a signals-search unit test, which is where it belongs; it never
required a four-service stack to assert.

### 4.6 The contract layer

Two mechanisms, both cheap enough to block a PR.

**HTTP, via `oasdiff`.** A `contract` job in each of the four service repos:

```
oasdiff breaking $(git show origin/$BASE_REF:openapi.json) openapi.json
```

`oasdiff breaking` fires only on consumer-visible breaks — a removed endpoint or
response field, a newly-required parameter, a narrowed enum — so ordinary
additive change produces no noise. It works *because* of an existing property
rather than a new one: three repos already fail CI when `openapi.json` is stale
relative to the code, so the spec is a trustworthy proxy for the implementation.
notification-service is the exception and needs `spec:dump`, a committed spec
and the same freshness gate; without it one sixth of the contract surface
cannot be checked at all.

All actions must be SHA-pinned, including GitHub-owned ones, or the zizmor
blocking pin gate (automation#154) rejects the workflow.

**Events, via a shared schema.** `contracts/events/item-event.v1.json`
describes the **wire payload** — the field map as it exists after `xadd`,
including `occurred_at` — and is asserted from both ends against one set of
shared valid and poison fixtures:

```
 signals-dpg                    contracts/                  signals-search
 ───────────                    ─────────                   ──────────────
 publishItemEvent()                                          parseEvent()
      │                                                           │
      │ capture xadd field array          item-event.v1.json      │
      ├────────────── ajv validate ──────────▶ │ ◀── ajv validate ┤
      │                                        │                  │
      │                              fixtures/valid/*.json        │
      │                              fixtures/poison/*.json ──────▶│
      │                                                    must DLQ, not process
```

Two documented consumer behaviours become pinned by this, both of which are
currently only comments: an **absent** `op` defaults to `upsert` for legacy
producers, while an **unknown** `op` is poison and must be dead-lettered rather
than silently processed as an upsert.

**Consumed-pair manifest.** Committed alongside the schemas so that an oasdiff
failure can name the affected consumer, and so a pair with no journey is a
visible gap rather than an unknown one. See §5 for its shape and the enumerated
edges.

> **Note on Pact:** consumer-driven contract testing was considered and
> rejected for v1. Pact needs a broker plus sustained two-sided discipline; for
> six known internal edges, `oasdiff` plus shared event fixtures reaches most of
> the value at a fraction of the operational cost. The calculus changes if
> external adopters begin consuming these APIs, at which point consumer-driven
> contracts start earning their keep.

### 4.7 Triggering, and one gating limitation

The journey suite lives in a new repo, `bluedots-e2e`, tagged with the **same
fleet-wide tag string** already used across the services
(`<YYYYMM>-s<sprint>-rc<n>`, e.g. `202608-s1-rc1`).

```
 tag 202608-s1-rc1 cut across the fleet
   │
   ├─▶ signals-dpg          build-images.yaml   ──▶ ghcr :202608-s1-rc1
   ├─▶ aggregator-dpg       ci.yml publish-image──▶ ghcr :202608-s1-rc1
   ├─▶ signals-search       ci.yml publish-image──▶ ghcr :202608-s1-rc1
   ├─▶ notification-service image-build.yaml    ──▶ ghcr :202608-s1-rc1
   │
   └─▶ bluedots-e2e         journey.yml
         │
         ├─ 1. resolve all 4 :TAG ──▶ digest   (poll, ~20min deadline)
         ├─ 2. record digests in job summary   ← release provenance
         ├─ 3. compose up @digest, await readiness
         ├─ 4. seed identities; matrix over purple_dot | blue_dot | orange_dot
         └─ 5. always: container logs + pg_dump artifacts; JUnit summary
```

Polling for the four digests rather than reacting to four completion events is
what removes the coordination problem: tag order across repos becomes
irrelevant, and no `repository_dispatch`, fan-in counter or PAT is needed —
only GHCR read. `workflow_dispatch` with explicit per-service image tags remains
as the escape hatch for testing an arbitrary combination.

**The limitation, stated plainly.** The contract lane is an enforced required
status check on PRs into `feature`/`develop`/`main`. The journey lane cannot be,
because it runs on a tag, and a tag by definition exists only after merge. So
"an RC is not promotable until the journey suite is green" is a **procedural
gate in the promotion checklist, not a branch-protection rule.** Making it
enforced would require running the full suite on the `develop→main` promotion
PR, which was considered and declined on cost. The cheap middle path, should
this prove insufficient, is running the suite on promotion PRs behind an opt-in
label **(planned)**.

### 4.8 Flake control

Four asynchronous workers participate in these journeys, so flake is the
primary risk to the suite being trusted rather than disabled. The controls are
therefore treated as design, not implementation detail:

- **Poll with a deadline; never sleep a fixed interval.** The runbook's "wait
  5–10 seconds for the queue to drain" is precisely the flake not to import.
- **Assert on drain, not elapsed time.** BullMQ `getJobCounts()` and Redis
  stream PEL depth must reach zero before any downstream assertion runs.
- **Force `?refresh=true`** before dashboard assertions. The runbook already
  documents that a rollup otherwise reflects pre-backdate timestamps, and lists
  orphaned advisory locks as the failure mode when it does not refresh.
- **Parallelize by network, serialize within one.** Distinct networks share no
  state, so wall-clock stays near the slowest single network without
  introducing cross-journey interference.
- **Retain direct-SQL `created_at` backdating** for time control rather than
  introducing a fake clock. It already works, its clamping rule
  (`min(intended, source_age, target_age, 0)`) is documented, and a fake clock
  would have to be threaded through four services.
- **Always capture artifacts on failure** — all container logs plus a `pg_dump`
  of the touched tables. This is non-negotiable rather than nice-to-have: a red
  cross-service suite with no artifacts is unactionable, and an unactionable
  gate gets disabled.

### 4.9 Open questions

1. **Does a standard GitHub runner hold the full stack?** A dozen-odd
   containers on 16GB is plausible with the stub embedder of §4.2 but unproven.
   The escape is a larger runner. To be settled empirically during the stack
   phase rather than argued in advance. *(provisional)*
2. **Which host does the voice bot's `POST /search` actually target** —
   signals-dpg's `/network/item/discover` BFF, or signals-search's `/v1/search`
   directly? J5 as specified in §6 assumes the BFF, since that is the path
   carrying the documented native fallback. Confirm with the voice team before
   J5 is built. *(provisional)*
3. **Should signals-dpg's integration suites leave the `sonar` job?** They
   currently run under `continue-on-error`, making regressions advisory (§2
   Background). Promoting them to a required job is cheap and adjacent, but it
   is a separate decision with its own CI-time cost.

---

## 5. Data Model

The system introduces no database tables. Its persistent artifacts are
committed contract files and per-network fixture plans, whose shapes are
specified here.

### `contracts/events/item-event.v1.json` — wire payload

Describes the field map as it exists on the Redis Stream after `xadd`, not the
producer's input interface (§2, Problem 2).

| Field | Type | Description |
|---|---|---|
| `item_network` | string, minLength 1 | Network id, e.g. `purple_dot` |
| `item_domain` | string, minLength 1 | Domain id within the network, e.g. `seeker` |
| `item_type` | string, minLength 1 | Schema identifier, e.g. `profile_1.0` |
| `item_id` | string, minLength 1 | Item identifier |
| `op` | enum `upsert` \| `delete`, default `upsert` | Absent means `upsert` (legacy producers); an unknown value is poison, never a silent upsert |
| `occurred_at` | string, minLength 1 | ISO-8601, injected by the producer at `xadd` time — absent from the producer's TS interface |

### `contracts/consumed-pairs.yaml` — consumer/provider edges

| Column | Type | Description |
|---|---|---|
| `consumer` | string | Consuming module, repo-qualified |
| `provider` | string | Providing service |
| `transport` | enum `http` \| `event` | Which contract mechanism of §4.6 applies |
| `auth` | string | Credential model on the edge |
| `journey` | string \| null | Journey label covering this edge; `null` is an explicit, visible gap |

Enumerated edges:

| Consumer | Provider | Transport | Auth | Journey |
|---|---|---|---|---|
| aggregator `signalstack-writer` / `participants-writer` | signals-dpg | http | api-key + `x-acting-org-id` | J1 |
| signals-dpg `network/item/discover`, `match_score` | signals-search | http | api-key | J2 |
| signals-dpg `packages/notification` | notification-service | http | service auth headers | J3 |
| signals-dpg `publish_item_event` | signals-search worker | event | none (shared Redis) | J2 |
| voice bot (external — ai-diffusion / Raya) | signals-dpg + signals-search | http | api-key + acting-org | J5 |
| signals-dpg `match_score` | dpg-scoring (fallback) | http | HMAC | *null* — no journey |

> **Note on the dpg-scoring edge:** it is deliberately uncovered. dpg-scoring is
> the fallback provider behind signals-search relevance, and the relevance
> migration moves the primary path to vector cosine. Covering a fallback that is
> being retired would be work with a short half-life; the `null` records that
> as a decision rather than an oversight.

### `fixtures/<network>/plan.json` — per-network action plan

Replaces the `SEEKER_PLAN` / `PROVIDER_PLAN` arrays currently hardcoded in
`apps/api/scripts/e2e/seed_actions.mts`, which the runbook itself documents as
coupled to fixture size.

| Field | Type | Description |
|---|---|---|
| `network` | string | Network id this plan applies to |
| `seed` | integer | mulberry32 seed; pins byte-identical fixture regeneration |
| `domains[].domain` | string | Domain id |
| `domains[].count` | integer | Records to generate; must equal `rows.length` |
| `domains[].rows[].item_age_days` | integer | Backdate applied to `items.created_at` |
| `domains[].rows[].action` | enum `create` \| `accept` \| `reject` \| `cancel` \| `none` | Target action bucket |
| `domains[].rows[].action_age_days` | integer \| null | Backdate for the action; clamped at runtime to `min(intended, source_age, target_age, 0)` |
| `expected.by_status` | map<string,int> | Expected rollup buckets per domain |
| `expected.by_action_status` | map<string,int> | Expected action buckets per domain |
| `expected.mode_wise_counts` | map<string,int> | Expected `link` / `bulk` split |

Holding `expected` beside `rows` in one file is the point: the runbook's warning
that regenerating fixtures with a larger count silently invalidates the expected
counts becomes structurally impossible to ignore, because the two now live
together and `count` is checked against `rows.length` at load.

---

## 6. API Spec

This design consumes existing endpoints rather than adding any. What follows
specifies, per journey, the calls made and the assertions that must hold — the
executable form of the runbook's expectation tables.

### Harness setup (not a journey)

**Keycloak Admin API — mint an operator**

```
POST {keycloak}/admin/realms/{realm}/users
{
  "username": "seeker-agg@e2e.local",
  "enabled": true,                       // NOT the disabled-until-approved
                                         // production path; the harness
                                         // creates an already-usable operator
  "attributes": {
    "aggregator_id":   "<pinned org id>",   // → JWT claim via protocol mapper
    "aggregator_type": "seeker"             // → JWT claim; enforced by
                                            //   enforceAggregatorType()
  },
  "credentials": [{ "type": "password", "value": "<fixture>", "temporary": false }]
}
→ 201

POST {keycloak}/realms/{realm}/protocol/openid-connect/token
  grant_type=password&client_id=…&username=…&password=…
→ 200 { access_token }   // carries aggregator_id + aggregator_type
```

Validation:
- The minted token MUST satisfy `requireApproved()` unmodified. A harness that
  needs product code relaxed has failed its own purpose.
- `aggregator_type` MUST match the domain of any registration link created with
  it, or `enforceAggregatorType` returns `AGGREGATOR_TYPE_MISMATCH` — asserted
  as a negative case.

### J1 — Onboard to dashboard  *(aggregator-dpg → signals-dpg)*

```
POST {aggregator}/admin/v1/registration-links        → 201 { slug }
     Authorization: Bearer <operator JWT>
     { "domain": "seeker", "name": "e2e" }

POST {aggregator}/admin/v1/registration-links/{id}/activate  → 200 status=live

POST {aggregator}/public/v1/aggregators/{orgSlug}/registrations/{slug}
     × N fixture records                            → 202 { submission_id }

POST {aggregator}/admin/v1/bulk-uploads             → 202 { upload_id }
     multipart: <network>/providers.csv             // array delimiter '|'

GET  {signals}/api/v1/aggregator/dashboard?refresh=true
     x-api-key: <pinned>   x-acting-org-id: <pinned org id>
→ 200 { by_domain: { <domain>: { rollup: {...} } } }
```

Assertions, per network, drawn from `fixtures/<network>/plan.json`:

- Await **drain before asserting**: the aggregator's BullMQ counts reach zero,
  not a fixed sleep.
- `total_items`, `complete_profiles`, `has_applications` match `expected`.
- `by_status` and `by_action_status` match `expected` exactly.
- `mode_wise_counts.link` equals the QR-submitted count; `.bulk` equals the CSV
  row count. The split is the point — it distinguishes the two ingress paths.
- **Negative direction:** interactions declaring `metric_categories: null` MUST
  NOT increment any `by_action_status` bucket. The runbook flags a regression
  here as a bug in the `collect_tracked_interactions` walk.

### J2 — Item to stream to search  *(signals-dpg → signals-search)*

```
POST {signals}/api/v1/item/create                    → 201 { item_id }
      ↳ publishItemEvent → xadd signals:item-events

POST {search}/v1/search  { network, domain, q, filters }
→ 200 { results: [ { item_id, ... } ] }

POST {signals}/api/v1/item/lifecycle  { item_id, to: "paused" }   → 200
POST {signals}/api/v1/item/lifecycle  { item_id, to: "retired" }  → 200

POST {signals}/api/v1/network/item/discover  { network, domain, q }
→ 200 { items: [...], meta: { source, degraded } }
```

Assertions:

- Await PEL depth zero on `signals:item-events` before each search assertion.
- After create → the item is returned by `POST /v1/search`.
- After `paused` → the item is **absent**. `item_search` reads are live-only,
  so a pause that is not published leaves a stale hit.
- After `retired` → de-indexed (the `delete` op).
- A schema-invalid event → lands on `signals:item-events:dlq` **and** is acked
  on the main group. Poison must not be redelivered forever.
- **With the signals-search container stopped**, `/network/item/discover`
  returns `200` with `meta.source: "native_fallback"` and `degraded: true` —
  never a 5xx. `q` and facet filters still apply on that path; only relevance
  ranking is lost.

### J3 — Action to notification  *(signals-dpg → notification-service)*

```
POST {signals}/api/v1/action/perform   { source_item, target_item, action }
→ 201 { action_id }
      ↳ notification client → notification-service queue → worker

GET  {mailpit}/api/v1/messages          → 200 { messages: [...] }
```

Assertions:
- Await notification-service queue drain, then exactly one message per expected
  recipient in Mailpit; subject and recipient match the rendered template.
- With the stub provider returning `500` once, the notification is **retried**
  and ultimately delivered — the retry path is asserted, not assumed.

### J4 — Consent and PII disclosure  *(signals-dpg, cross-org)*

```
POST {signals}/api/v1/consent/record            → 200
POST {signals}/api/v1/action/get-contact-details { action_id }
     x-api-key / x-acting-org-id
→ 200 { contact: {...} }  |  403
```

Assertions:
- Before consent → reveal is refused.
- After consent, as the **owning** org → contact fields decrypt and return.
- After consent, as a **different** org → `403`. Tenancy isolation on the
  disclosure path is the highest-value assertion in this journey, and it is one
  no single-service test suite is positioned to make.

### J5 — Voice bot flow  *(external consumer → signals-dpg + signals-search)*

Replayed as a contract-shaped client. The Python voice service does **not** join
the stack; the journey asserts that the request shapes it sends remain served.

```
GET  {signals}/api/v1/admin/participant?phone=…      → 200 | 404
POST {signals}/api/v1/admin/participant  { ...profile }        → 200/201
POST {signals}/api/v1/network/item/discover  { … }   → 200      // see §4.9 Q2
POST {signals}/api/v1/action/perform
     { …, acting_as_user_id }                        → 201
     x-api-key / x-acting-org-id
```

Assertions:
- Cold lookup of an unknown phone → `404`, not a 5xx. This is the inbound path
  a cold call takes.
- Upsert then re-lookup → `200` with the written profile.
- `action/perform` with `acting_as_user_id` records the on-behalf-of attribution
  (`acting_org` of type aggregator), and the acting-org check rejects an org of
  the wrong type.

---

## 7. Summary

Functional verification across the DPG services is presently a 479-line human
procedure whose scenario is well specified and whose execution is not
automatable in its current form, because three of its six steps run through a
UI. This design replaces it with two layers of different cost and cadence.

The **contract layer** (§4.6) runs on every service pull request in under two
minutes with no containers. It diffs each repo's `openapi.json` with
`oasdiff breaking` — trustworthy because the existing spec-freshness gate
already proves the spec matches the code — and pins the `signals:item-events`
envelope with one shared JSON Schema asserted from both the producer and the
consumer against shared valid and poison fixtures. It addresses Problems 2 and
3, the failure class that has recurred repeatedly across signals-dpg #103, #104,
#112, #115, #122 and aggregator-dpg #399.

The **journey layer** (§4.2, §4.7) runs on each release-candidate tag in a new
`bluedots-e2e` repo. It resolves all four service images at that tag to
digests, boots them under `docker compose` with Keycloak, Mailpit, a stub
embedder and a stub provider, mints identities through the Admin API so that
`requireApproved` is exercised rather than bypassed, and drives J1–J5 across
`purple_dot`, `blue_dot` and `orange_dot`.

Two consequences are worth restating because they are decisions rather than
oversights. Deployment configuration remains uncovered: a compose stack cannot
validate Helm, Kong or cross-namespace wiring, and the right answer is a
post-deploy smoke phase in `bluedots-automation` **(planned)**, not a
compromise here. And the journey layer cannot be a branch-protection check,
because it runs on a tag that exists only after merge — so its enforcement is
procedural, a promotion-checklist item, with running it on promotion PRs behind
a label available **(planned)** if that proves too weak.

The recommended build order inverts apparent size. The contract layer is a few
days' work and retires a recurring production failure class; the journey layer
is roughly two weeks and depends on the contract layer having already pinned the
wire shapes beneath it.
