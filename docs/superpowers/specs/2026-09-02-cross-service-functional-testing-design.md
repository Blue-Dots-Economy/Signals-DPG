# Cross-Service Functional Testing Design

**Status:** design approved 2026-09-02, awaiting implementation plan
**Scope:** signals-dpg, aggregator-dpg, signals-search, notification-service, plus a new `bluedots-e2e` repo

## Overview

Every deployment today is validated by a human following
`signals-dpg/docs/operations/e2e-purple-dot-runbook.md` — 479 lines, six steps,
three of which are UI-driven and one of which is eyeballing dashboard numbers
against a table. The scenario itself is well specified; the problem is that its
test runner is a person.

This design replaces that with two automated layers:

- a **contract layer** that runs on every service PR in ~60–90s with no
  containers, catching provider/consumer drift in the repo that causes it; and
- a **journey layer** that runs on each release-candidate tag, booting all four
  services from the exact image digests being shipped and driving real
  cross-service journeys end to end.

The journey layer lives in a new repo, `bluedots-e2e`. The contract layer lives
partly in each service repo (the check) and partly in `bluedots-e2e` (the
shared schemas and fixtures it checks against).

## Goals

- Remove the manual per-deployment functional pass.
- Fail cross-repo contract breaks in the PR that introduces them, not in
  production.
- Test the artifacts actually being released, pinned by image digest.
- Cover the data flows that cross a service boundary — those are the ones no
  single repo's test suite can see.

## Non-goals

- **Browser/UI coverage.** No Playwright in v1. Identities are minted through
  Keycloak's Admin API and journeys drive HTTP. A UI layer is deferred to its
  own project (see Phasing).
- **Semantic ranking quality.** The journey layer asserts that an item is
  indexed and retrievable, not that BGE-M3 ranks it well. Ranking quality is an
  offline eval, not a release gate.
- **Consumer-driven contract testing (Pact).** Deliberately skipped; see
  Decisions.
- **Load, chaos, and resilience testing.** Out of scope, with one exception:
  the signals-search-unavailable degradation path is asserted because it is a
  functional behaviour with a user-visible contract.
- **`yellow_dot` coverage.** Dropped by decision — see Network coverage.

## Current state

Verified across all five repos on 2026-09-02.

| Layer | State |
|---|---|
| Unit | Strong. ~750 test files on vitest; runs on every PR into `feature`/`develop`/`main` |
| Service integration | Uneven. signals-dpg has ~25 `*.integration.test.ts` suites, but they run only inside the `sonar` job under `continue-on-error`. notification-service runs `test:integration` against real Redis. signals-search uses Testcontainers in its default `pnpm test`. **aggregator-dpg has no integration layer at all** — every dependency is mocked |
| Contract | Missing. Three of four repos commit an `openapi.json` with a CI freshness gate, and it syncs to bluedots-docs — but nothing validates a consumer against it |
| Cross-service journey | Specified, not automated. The purple_dot runbook plus `scripts/e2e/` (seeded fixture generator, two driver scripts, exact expected rollup tables) |
| UI E2E | None. No Playwright or Cypress in any repo |
| Post-deploy smoke | None. `install.sh` verifies pod readiness only; `DEPLOYMENT.md` notes cross-namespace is unverified |
| Migration verification | `db:check:parity` and `schema:bundle:check` exist but are not part of a release gate |

The four gaps this design targets:

1. **The `signals:item-events` envelope is declared twice.**
   `signals-dpg/apps/api/src/utils/publish_item_event.ts` declares
   `interface ItemEvent`; `signals-search/src/ingest/stream_consumer.ts`
   declares `ItemEventSchema`. They agree today by care, not by construction.
   Note the asymmetry: the producer interface omits `occurred_at` (injected at
   `xadd` time) while the consumer requires it.
2. **aggregator-dpg's writer→Signals boundary is mock-only**, so it is
   exercised end to end only by hand.
3. **Only `purple_dot` has any cross-service scenario**, despite each network's
   `network.json` carrying a different interaction matrix, `metric_categories`,
   and `status_rules`.
4. **No trigger and no environment.** RC tags build images; nothing runs a
   functional suite against them.

## Decisions

**Hermetic stack in CI, not a shared test cluster.** A shared environment
means shared-state flake and can only run post-deploy. A hermetic stack can
pin digests and be reproduced locally with one command. The cost is that
Helm/ingress/Kong/Keycloak deployment config is *not* covered — that belongs to
a later post-deploy smoke phase in `bluedots-automation`.

**API-only, no browser in v1.** All three "manual" runbook steps already have
API routes (`aggregator-registrations.ts`, `aggregator-org-approvals.ts`,
`registration-links.ts`, `bulk-uploads.ts`). The only blocker was auth, and that
dissolves once Keycloak is in the stack: `aggregator_id` and `aggregator_type`
are user attributes mapped to JWT claims by protocol mappers in the checked-in
`aggregator-dpg/infra/keycloak/realms/realm.json`. Minting a user via the Admin
API and doing a direct-grant exercises the real `requireApproved` path with no
OTP scraping and no test-only backdoor in product code.

**Vitest as the runner, with a thin declarative layer over it.** Vitest is
already in all four repos, so the runner, filtering, watch mode and stack traces
are familiar. On top of it sits `defineJourney` — see "Scenarios are step lists"
below — which is a typed wrapper, not a second runner.

Cucumber/Gherkin was rejected: it buys a natural-language surface at the price of
a step-definition indirection between the sentence and the code, plus a second
runner to maintain. In the chosen model the sentence *is* the step's declared
label and the list *is* the test, so there is nothing to keep in sync.

**Scenarios are step lists, not code.** A journey file contains no TypeScript —
no `await`, no control flow, no assertions in test syntax. It is a list of named
steps, and the TypeScript lives in a step library where each step's
plain-English label sits beside its implementation.

This started as an authoring-cost decision and turned out to matter more for
output. Because every step carries a label declared once, the report can render
a readable trace rather than only a pass/fail per test — and the same label is
what the business-facing evidence sheet prints, so it cannot drift from what the
test does. A scenario needing genuine logic must use an explicit
`custom({ label, run })` escape, which keeps the drop to raw code visible in
review instead of buried inside a function body.

The earlier framing of this decision was too broad — it argued that
steps-as-data always degenerates into a bad DSL. That is true of a *generic*
DSL with conditionals and expressions in configuration; it is not true of a
fixed vocabulary of domain steps, which is a function library with a
data-shaped call site.

**docker compose, not Testcontainers, for the journey stack.** The premise is
"test the artifacts you ship", which means pinning published digests and
expressing Keycloak realm import plus `network.json` mounts declaratively. One
compose file does that and a developer can run the identical stack locally.
Testcontainers remains the right tool for single-service tests — signals-search
already uses it correctly — but programmatically wiring a dozen containers diverges
from what a human can reproduce when the suite goes red.

**Stub embedder instead of real TEI/bge-m3.** TEI needs ~8Gi and a standard
GitHub runner has 16GB total for the whole stack. A small service at
`EMBEDDING_URL` returning deterministic, dimension-correct vectors preserves
everything the gate cares about — the event contract, the `item_search` upsert,
dimension invariants, filter-then-rank plumbing, retrievability — and makes
assertions deterministic rather than model-dependent.

**oasdiff for HTTP contracts; shared JSON Schema for events; no Pact.**
`oasdiff breaking` fires only on genuinely breaking changes (removed endpoint or
response field, newly-required param, narrowed enum), which is the exact
signature of every breakage in the cross-repo cutover history. It runs in
seconds with no server, and it works *because* the `openapi.json` freshness gate
already proves the spec matches the code. Pact would need a broker plus
two-sided discipline; for six known consumer edges, oasdiff plus shared event
fixtures gets most of the value at a fraction of the cost. Revisit if external
adopters start consuming these APIs.

**Contract schemas live in `bluedots-e2e`, not `bluedots-schemas`.**
`bluedots-schemas` is the only private repo in the org, so having four public
repos' CI check it out means provisioning a token in each. `bluedots-e2e` is
public. `bluedots-schemas` keeps owning `network.json` as it does today.
Service repos consume the contracts via a second `actions/checkout` of
`bluedots-e2e` **pinned to a tag**, so a bad commit there cannot redden four
repos and bumps are deliberate. If pinning churn becomes annoying, the upgrade
path is publishing `@blue-dots/contracts` to GitHub Packages, which folds into
the existing Dependabot sweep rather than adding a new mechanism. Not on day
one.

**Journey suite in a new repo.** `bluedots-automation` was the alternative — it
already pins global image digests and already hosts Node code with tests under
`.github/actions/pr-gate/` — but a dedicated repo keeps ownership clean and
means E2E changes never wait on automation's promotion cycle. The accepted cost
is a sixth Dependabot lane, `security.yml`, zizmor pin gate, promotion
branches, and release tag.

## Architecture

```
bluedots-e2e/
  compose.e2e.yaml        # full topology, images by digest
  contracts/              # event schemas + valid/poison fixtures + consumed-pair manifest
  fixtures/               # seeded per-network generators (moved from signals-dpg/scripts/e2e)
  harness/                # identity minting, readiness gating, teardown, artifact capture
  steps/                  # the step library — labelled, reusable; the only place
                          #   actors/clients/awaiters/projections are reachable
  journeys/               # scenarios: step lists + metadata, no TypeScript
  capabilities.yaml       # closed taxonomy the evidence sheet reports on
  report/                 # summary.json + the Tier-2 / Tier-3 renderers
```

Stack contents: `postgres-pgvector` (the org's own image, per the AVX-512
SIGILL fix), redis, keycloak (built image + rendered realm), mailpit, a stub
embedder, a stub SMS/WhatsApp provider, signals-dpg api, aggregator api +
worker, signals-search worker + api, notification-service + worker.

### Harness: deterministic identity via real auth paths

| Identity | Mechanism |
|---|---|
| Signals service identities (aggregator api-key + acting-org; voice-bot key) | Extend `seed_service_users.ts` to accept **pinned** org ids and raw keys from env instead of randomizing. Compose then wires `AGGREGATOR_DPG_API_KEY` and `actingOrgId` statically |
| Aggregator operator JWTs | Keycloak boots from the existing `realm.json` template; Admin API creates an `enabled: true` user with `aggregator_id`/`aggregator_type` attributes; direct-grant yields a correctly-claimed JWT |
| Approved-org rows | Created through the real `aggregator-org-approvals` endpoint as a seeded network-admin, so the approval code is tested rather than its output fabricated |

The first row has a side benefit beyond testing. `seed_service_users.ts` today
mints a random org id and prints the key once, which is precisely the mismatch
behind the orange_dot production 503 (provisioning randomizes while aggregator
pins `actingOrgId`). Making the ids and keys pinnable serves the harness and
fixes the provisioning pain with one change.

### Fixtures

`signals-dpg/scripts/e2e/generate_fixtures.mts` moves into `bluedots-e2e` and
is generalized from hardcoded purple_dot paths to reading any network's
`network.json`. The mulberry32 seed stays, so reruns are byte-identical. The
hardcoded `SEEKER_PLAN` / `PROVIDER_PLAN` arrays become per-network plan files —
the runbook already documents that those arrays are coupled to fixture size.

### Network coverage

Tiered rather than all-journeys-by-all-networks, which would be 15 combinations
for little marginal signal.

| Network | Coverage | Rationale |
|---|---|---|
| `purple_dot` | Full J1–J5 | The only network with a proven expected-assertion table |
| `blue_dot` | Full J1–J5 | 31 vectorize fields and the 6-domain front door — highest search exposure |
| `orange_dot` | J1 only | Single-domain; exercises the `items.created_by NOT NULL` phantom-account path |

`yellow_dot` is excluded. The one case it uniquely carried — a network with zero
vectorize fields must index as a no-op rather than error — moves to a
signals-search unit test, where it never needed a four-service stack.

### The journeys

**J1 — onboard to dashboard.** Aggregator link/QR submit and bulk CSV upload →
`signalstack-writer` → Signals user and item → dashboard rollup. Asserts the
runbook's existing expected-rollup tables verbatim, including
`mode_wise_counts.link` versus `.bulk`.

**J2 — item to stream to search.** Item created → retrievable via
`POST /v1/search`. Lifecycle pause → *not* returned (live-only, search#122).
Retire → de-indexed. Malformed event → dead-lettered with the main stream
acked. And with signals-search stopped, `/network/item/discover` returns
`meta.source: 'native_fallback'`, `degraded: true` rather than 5xx.

**J3 — action to notification.** Connect action → Signals notification client →
notification-service queue → worker → message captured in Mailpit. Retry-on-5xx
asserted via the stub provider.

**J4 — consent and PII disclosure.** Consent capture → contact-details reveal is
gated → decrypt succeeds only for the owning org, and a cross-org read is
denied.

**J5 — voice bot flow.** `GET /admin/participant` → `POST /admin/participant` →
search → `POST /action/perform` with acting-org and `acting_as_user_id`.
Replayed as a contract-shaped client; the Python voice service does not join the
stack.

### Consumed-pair manifest

Committed in `bluedots-e2e/contracts/`, so an oasdiff failure can name the
affected consumer and a pair with no journey is a visible gap rather than an
unknown one.

| Consumer | Provider | Transport |
|---|---|---|
| aggregator `signalstack-writer` / `participants-writer` | signals-dpg | HTTP, api-key + `x-acting-org-id` |
| signals-dpg `network/item/discover`, `match_score` | signals-search | HTTP `/v1/search`, `/v1/relevance` |
| signals-dpg `packages/notification` | notification-service | HTTP |
| signals-dpg `publish_item_event` | signals-search worker | Redis stream `signals:item-events` |
| voice bot (external — ai-diffusion / Raya) | signals-dpg + signals-search | HTTP `/admin/participant` ×2, `/action/perform`, search |
| signals-dpg `match_score` | dpg-scoring (fallback) | HMAC |

### Entry point

One command, and CI invokes the same one a developer does — only the flags
differ. A suite whose only working path is the CI path is a suite nobody
reproduces locally, which is the first thing anyone does with a red run.

```
pnpm journey                                   # everything
pnpm journey --journey J2                      # one scenario, all its networks
pnpm journey --network purple_dot              # one network, all its scenarios
pnpm journey --list                            # print the matrix, boot nothing
pnpm journey --keep-stack                      # leave containers up to debug
pnpm journey --images-from-tag 202608-s1-rc1   # what CI runs
```

Five phases, each raising a named failure so a red run says *where* it broke:
`RESOLVE_TIMEOUT` (tag → digests), `STACK_UNHEALTHY` (compose up, health and
migrations), `SEED_FAILED` (identities), `<scenario> FAILED`, then report —
which never fails and runs on red as well as green.

`--list` works without booting anything: `defineJourney` registers into a
module-level registry at import, so the matrix and the coverage report are
readable cheaply.

### The framework: five extension points

A scenario is composed, never hand-rolled, and a step is the only place the
underlying machinery is reachable:

- **actors** — who is calling (`aggregatorOperator('seeker')`, `voiceBot()`)
- **clients** — typed, **generated** from each service's `openapi.json`
- **awaiters** — the only sanctioned way to wait; never `sleep`
- **projections** — what you assert on (`dashboardRollup`, `searchHits`, `mailbox`)
- **fixtures** — per-network seeded generators plus `plan.json`

Generating the clients is load-bearing rather than cosmetic. The four specs are
already CI-proven fresh, so generation is free and buys a second contract check:
a provider that removes a response field breaks the harness **typecheck**, before
any container starts. The contract and journey layers reinforce each other rather
than merely coexisting.

Concentrating every wait in the awaiters module is what makes the flake controls
below enforceable rather than aspirational — a bare `sleep` in a diff can be
rejected because the named alternative already exists.

The resulting cost of change is the real test of whether this is a framework
rather than a suite:

| To add | You touch | Cost |
|---|---|---|
| A scenario from existing steps | one list | **no TypeScript** |
| A new step | one `step({ label, run })` | ~10 lines |
| **A whole new network** | a `network.json` + a `plan.json` | **no test code** |
| A new thing to assert on | one projection, then the step | ~half a day |
| A new service in the stack | compose entry + generated client + projection | 1–2 days |

The network row carries the generality claim and is the sharpest break from
today: a network is a **matrix parameter, not a copy**. The runbook cannot do
this, because its expected values are prose written for `purple_dot` — a second
network means a second document.

Three guard rails keep the readable-report property from eroding, enforced by
lint in the harness's own tests so they fail in review rather than in a report
months later. A journey `title` and a step `label` must read as prose and must
not contain a route path, an identifier or a service name. A `capability` must
be one of the five declared slugs, so the reported taxonomy is closed and no
scenario can pass outside it. And dropping to raw code requires the explicit
`custom({ label, run })` escape.

### Output: three artifacts for three audiences

Three audiences need materially different things, and collapsing them produces a
document that serves none of them.

| Tier | Artifact | Audience |
|---|---|---|
| 1 | exit code + GitHub check — binary, no prose | CI, branch protection |
| 2 | journey × network grid, step trace, expected-vs-actual on failure | developer, release manager, architect |
| 3 | one-page evidence sheet, business language, aggregated by capability | product, client, compliance |

Tier 3 is what makes the exercise legible to someone who does not work on the
code:

```
 Release 202608-s1-rc1 — functional verification
 Verified 2026-09-08 14:22 IST · 4 services · networks: purple dot, blue dot

 CAPABILITY                          RESULT    CHECKS
 Participant onboarding              PASSED    14 of 14
 Search and discovery                PASSED    11 of 11
 Notifications                       PASSED     6 of 6
 Consent and data disclosure         PASSED     8 of 8
 Voice assistant                     FAILED     5 of 7
   └ Looking up a caller by phone number returned an error instead
     of "not found" when the number was unknown.

 NOT COVERED BY THIS RUN
 · Screens and forms — checked by hand
 · Deployment configuration — checked after deploy
 · Compatibility scoring fallback service — no automated scenario
```

The mechanism is a constraint, not a renderer: the label declared beside each
step **is** the line the report prints, so nothing is translated at render time
and the business-facing report is structurally incapable of drifting from what
the tests assert. That drift is the usual reason such reports stop being trusted.

The **NOT COVERED** block is generated rather than written — derived from the
consumed-pair manifest's `journey: null` rows plus the declared non-goals. A
report listing only what passed invites the reader to assume everything was
checked; an honest artifact states its own boundary, and generating it means the
boundary cannot go stale.

`summary.json` is the canonical record that both renderers read, and the unit any
future trend data would accumulate. JUnit XML is **derived** from it purely to
feed GitHub's check UI — JUnit cannot carry a capability, a skip reason or the
digest provenance, so it is a poor source of truth.

### Verifying the suite itself

A falsely-green gate is worse than no gate: if a wait helper silently resolves on
timeout, every scenario passes vacuously and the gate actively lies. Three
mechanisms, only the first of which is an ordinary test run:

1. **Harness unit tests** — fixture generator determinism (same seed → identical
   output), report renderers, `plan.json` validation, capability-slug closure,
   and the lint rules (a `title` containing a route path must fail).
2. **Negative controls** — awaiters tested against a stub that *never* converges
   and required to time out; a scenario run against deliberately wrong expected
   values and required to fail. A journey that cannot fail is not a test. This
   mirrors what the contract layer already does with poison fixtures.
3. **A `harness-selftest` CI job** — two canary scenarios, one built to pass and
   one built to fail, asserting the runner reported exactly one of each *and*
   that the process exited non-zero. If someone breaks the reporter or swallows
   the exit code, nothing else catches it.

Mutation-testing the harness was considered and rejected: the canary pair plus
the never-converging awaiter stub buys most of the assurance at a fraction of the
cost and runtime.

## Contract layer

A `contract` job in each of the four service repos' CI:

```
oasdiff breaking $(git show origin/$BASE_REF:openapi.json) openapi.json
```

Blocking on PRs into `feature`/`develop`/`main`, waivable by a
`contract-break-approved` label. Every action must be SHA-pinned — the zizmor
gate (automation#154) rejects unpinned refs including GitHub-owned ones.

Alongside it, the event envelope registry at
`bluedots-e2e/contracts/events/item-event.v1.json` with shared valid and poison
fixtures:

- **Producer side** (signals-dpg, extending `publish_item_event.test.ts`):
  capture the real `xadd` field array, map it, assert it validates against the
  shared schema. The schema describes the **wire payload**, not the producer's
  input interface — that distinction is why `occurred_at` must be in it.
- **Consumer side** (signals-search): `parseEvent` accepts every shared valid
  fixture and dead-letters every poison one. Pins the two documented
  behaviours: absent `op` defaults to `upsert` for legacy producers, and an
  *unknown* `op` is poison rather than a silent upsert.

notification-service needs `spec:dump`, a committed `openapi.json`, and the same
freshness gate the other three have. Without it, one sixth of the contract
surface is unverifiable.

## Journey layer CI

`bluedots-e2e` is tagged with the **same fleet-wide tag string** already used
across the repos:

```yaml
on:
  push:
    tags: ['v*.*.*', '20*-s*-rc*']
  workflow_dispatch:      # explicit per-service image tags — escape hatch
```

All four repos already publish on `20*-s*-rc*`: signals-dpg and
notification-service from dedicated build workflows, aggregator-dpg and
signals-search from a `publish-image` job in `ci.yml`.

Run sequence:

1. Resolve each `ghcr.io/blue-dots-economy/<svc>:$TAG` to a digest, polling with
   a ~20-minute deadline so tag order across repos does not matter.
2. Record all four digests in the job summary — that is the release provenance.
3. `docker compose up` on those digests; wait for readiness.
4. Seed identities; run journeys as a matrix over
   `purple_dot | blue_dot | orange_dot`.
5. Render the three output artifacts (below) — on red as well as green. On
   failure additionally upload the triage bundle: container logs, a `pg_dump`
   of the touched tables, the resolved digests, the seeded identities, and the
   failing scenario's step trace.

No `repository_dispatch`, no fan-in counter, no PAT — only GHCR read.

### Flake control

Four async workers are in the loop, so this is the main risk to the suite being
trusted rather than disabled.

- Poll-with-deadline helpers, never fixed sleeps. The runbook's "wait 5–10
  seconds" is exactly the flake not to import.
- Assert on **drain, not wall time**: BullMQ `getJobCounts()` and Redis stream
  PEL depth at zero before asserting anything downstream.
- Force `?refresh=true` before dashboard assertions.
- Parallelize **by network**, serialize within one. Separate networks share no
  state, so wall time stays near the slowest single network.
- Keep direct-SQL `created_at` backdating for time control rather than
  introducing fake clocks; it works and it is documented.
- Artifact capture on failure is non-negotiable. A red cross-service suite with
  no artifacts is unactionable.

### Gating: one honest limitation

The contract lane is an enforced required status check. The journey lane cannot
be: it runs on a tag, which by definition exists only after merge. So "an RC is
not promotable until the journey suite is green" is a **procedural gate in the
promotion checklist, not a branch-protection rule**. Making it enforced would
mean running the full suite on the `develop→main` promotion PR, which was
declined on cost. The cheap middle path, if this matters later, is running the
suite on promotion PRs behind an opt-in label.

## Phasing

Each phase is one branch off `feature` with a single rolling PR.

| Phase | Contents | Rough size |
|---|---|---|
| P0 Foundations | notification-service `spec:dump` + committed `openapi.json` + freshness gate. Pin `seed_service_users.ts` org ids/keys via env | ~1 day |
| P1 Contract lane | Create `bluedots-e2e` with `contracts/` only. Event schema + valid/poison fixtures. `oasdiff` job in all four repos. Producer and consumer Ajv tests. The `harness-selftest` canary job | ~2–3 days |
| P2 Stack + J1 | `compose.e2e.yaml`, stub embedder, Keycloak Admin-API harness, the step library and its five extension points, generated clients, generalized fixture generator. J1 on `purple_dot`. Retires runbook steps 1–3 and 6 | ~1 week |
| P3 J2 + J5 | stream→search, lifecycle pause/retire, DLQ, `native_fallback` degradation. Voice bot flow | ~3 days |
| P4 J3 + J4 | notification delivery + retry via stub provider. Consent and PII cross-org denial | ~3 days |
| P5 Network matrix | `blue_dot` full, `orange_dot` J1 | ~2 days |
| Later | Playwright UI layer; post-deploy smoke in `bluedots-automation` | — |

Sizes are rough and assume one developer.

P1 is the phase to start with. It ships in days, needs no containers, and
directly targets the failure class that has recurred repeatedly (#103, #104,
#112, #115, #122, aggr#399). P2 is the expensive phase and its value depends on
P1 already being in place.

## Open questions

1. **Does the standard GitHub runner hold the full stack?** A dozen-odd containers plus
   Postgres on 16GB is plausible with the stub embedder but unproven. If it does
   not fit, the escape is a larger runner. To be settled empirically in P2, not
   argued in advance.
2. **Which host does the voice bot's `POST /search` actually target** —
   signals-dpg's `/network/item/discover` BFF or signals-search's `/v1/search`
   directly? J5 assumes the BFF, since that is the path with the documented
   fallback. Confirm with the voice team before P3.
3. **Do integration tests move out from under `sonar`?** signals-dpg's ~25
   integration suites currently run inside the `sonar` job with
   `continue-on-error`, so a regression there is advisory. Promoting them to
   their own blocking job is adjacent to this work and cheap, but it is a
   separate decision.
