# Cross-Service Functional Testing Design

**Audience:** the system architect, DPG service owners, and the DevOps/release engineer, who need to understand how the functional journeys spanning signals-dpg, aggregator-dpg, signals-search and notification-service become an automated release gate instead of a manual runbook pass.

---

## Contents

1. [Introduction](#1-introduction)
2. [Background & Problem Statement](#2-background--problem-statement)
3. [Key Design Problems](#3-key-design-problems)
4. [Design](#4-design)
5. [Summary](#5-summary)

> This is the review overview. Per-journey endpoint detail and assertions live
> in the P1–P5 implementation plans; the companion
> `2026-09-02-cross-service-functional-testing-design.md` carries the full
> decision record and rationale.

---

## 1. Introduction

A **journey** is one flow that crosses at least one service boundary — a
participant onboarded by an aggregator appearing on that aggregator's
dashboard, say. Journeys are the tests no single repo can write, because no
single repo contains both ends.

This document describes two layers that automate them: a **contract layer**
verifying provider/consumer wire agreement on every pull request, and a
**journey layer** driving real journeys against the exact container images a
release ships.

Terms, consistent with `signals-dpg/CLAUDE.md`: **network** is the shared
contract (`purple_dot`); **domain** a role within it (`seeker`); **item** a
versioned schema-typed record; **action** an interaction between items. One
term is new here — a **capability** is a business-language grouping of
journeys ("Participant onboarding"), and capabilities, not journeys, are what
the non-technical report reports on (§4.4).

---

## 2. Background & Problem Statement

### Background

Functional verification is today a human procedure.
`docs/operations/e2e-purple-dot-runbook.md` is 479 lines and six steps: three
driven through the aggregator UI (self-registration with an OTP read out of
Mailpit, QR link creation, CSV bulk upload), two scripted, and one where an
operator compares dashboard numbers against a table in the document.

The scenario is not the weak part. It already ships a deterministic fixture
generator and fully enumerated expected values. What is missing is a machine to
execute it.

Everything below the journey is in better shape:

```
 layer                    state
 ──────────────────────    ────────────────────────────────────────────────
 unit                     strong    ~750 vitest files, 4 repos, per-PR
 service integration      uneven    signals-dpg ~25 suites but ADVISORY
                                    (inside sonar, continue-on-error);
                                    notification-service real Redis;
                                    signals-search Testcontainers;
                                    aggregator-dpg NONE — all mocked
 contract                 missing   openapi.json emitted and freshness-gated
                                    in 3 of 4 repos, never checked against
                                    a consumer
 cross-service journey    MANUAL    the purple_dot runbook
 UI end-to-end            missing   no Playwright/Cypress anywhere
 post-deploy smoke        missing   install.sh checks pod readiness only
```

### Problem Statement

**Problem 1 — the test runner is a person.**
*Core challenge:* a well-specified scenario cannot gate a release if running it
costs an operator an afternoon.
Because the cost is human time, the pass gets skipped exactly when deadlines
make it matter most. The three UI-driven steps are why the whole procedure is
manual, even though two steps are already scripted.

**Problem 2 — cross-repo contracts are unverified on both transports.**
*Core challenge:* a provider can break a consumer with a green build in its own
repo, because no consumer is present to object.
Over HTTP, every consumer's tests mock the provider's response shape. Over
events, the `signals:item-events` envelope is **declared twice** — as an
interface in signals-dpg's producer and a Zod schema in signals-search's
consumer — agreeing only by their authors' continued care. Note the asymmetry
that makes naive sharing wrong: the producer omits `occurred_at`, injected at
`xadd` time, while the consumer requires it. This is the failure class behind
signals-dpg #103, #104, #112, #115, #122 (tracked in #124) and aggregator-dpg
#399.

**Problem 3 — one network of four has any coverage.**
*Core challenge:* each `network.json` carries a different interaction matrix,
`metric_categories` and `status_rules`, so one network generalizes poorly.
`blue_dot` declares 31 vectorize-marked fields against `purple_dot`'s 9, making
it far more exposed to ingestion regressions. `orange_dot` is single-domain,
reaching the `items.created_by NOT NULL` path a two-domain network never does.

**Problem 4 — nothing is bound to a release, and nothing readable comes out.**
*Core challenge:* the artifacts are built but never exercised, and the people who
decide whether to ship cannot read a test runner's output.
All four services publish an image on a `20*-s*-rc*` tag; no workflow consumes
that fan-out. Separately, a green tick with no legible evidence behind it is
indistinguishable from a suite that asserts nothing — so the output is part of
the design, not a byproduct.

**Problem 5 — a set of hand-written tests is not a framework.**
*Core challenge:* the marginal cost of the sixth scenario decides whether this
system is alive in a year.
If each scenario hand-rolls its own HTTP calls, credentials and polling loops,
adding one means copying a couple of hundred lines and the copies drift. This is
the standard decay path: written once, never extended, quietly disabled when
red.

---

## 3. Key Design Problems

| # | Target | Direction |
|---|---|---|
| P1 | Run the journey without an operator | Hermetic stack in CI; identities minted through Keycloak's Admin API so the UI steps become API calls (§4.1, §4.2) |
| P2 | Verify both transports in the causing PR | `oasdiff breaking` per repo, plus one shared event-envelope schema asserted from both ends (§4.3) |
| P3 | Cover networks in proportion to risk | The network is a matrix parameter, not a copy (§4.5) |
| P4 | Bind to the release; emit legible evidence | Same fleet-wide tag; three output artifacts for three audiences (§4.2, §4.4) |
| P5 | Make scenario six cheap | Scenarios are **lists of named steps**, not code (§4.5) |

---

## 4. Design

### 4.1 The solution in one picture

```
 ┌── CONTRACT LAYER ──────────────── every service PR · ~90s · no containers ──┐
 │                                                                            │
 │   openapi.json ──oasdiff breaking──▶ fail if a consumer-visible break      │
 │   xadd payload ──▶ item-event.v1.json ◀── parseEvent  (asserted BOTH ends) │
 └────────────────────────────────────────────────────────────────────────────┘

 ┌── JOURNEY LAYER ───────────────────── every RC tag · ~5-8min · full stack ──┐
 │                                                                            │
 │  tag 202608-s1-rc1 ──▶ resolve 4 images to DIGESTS ──▶ compose up          │
 │                                                                            │
 │   ┌──────────────────────────────────────────────────────────────────┐     │
 │   │ postgres-pgvector   redis   keycloak   mailpit                   │     │
 │   │ stub-embedder       stub-sms-provider                            │     │
 │   │                                                                  │     │
 │   │  signals-dpg ◀──── aggregator (api + worker)                     │     │
 │   │       │ xadd                                                     │     │
 │   │       ├──────▶ signals-search (worker + api)                     │     │
 │   │       └──────▶ notification-service (svc + worker) ──▶ mailpit   │     │
 │   └──────────────────────────────────────────────────────────────────┘     │
 │                              │                                             │
 │        seed identities ──▶ run scenarios × networks ──▶ report            │
 └────────────────────────────────────────────────────────────────────────────┘
                                       │
                     ┌─────────────────┼─────────────────┐
                     ▼                 ▼                 ▼
              Tier 1 gate       Tier 2 run report   Tier 3 evidence sheet
              exit code         journey × network   business capabilities
              (CI)              (engineer)          (product / client)
```

Two properties of that picture are decisions rather than incidentals. The stack
is **hermetic** — booted per run from published digests, not a shared
environment — so a red run is reproducible locally and cannot be shared-state
flake. And the embedder is a **stub** returning deterministic,
dimension-correct vectors, because real TEI/bge-m3 wants ~8Gi against a 16GB
runner; the gate cares about the event contract, the index upsert and
retrievability, all of which the stub exercises, while ranking *quality* is an
offline eval rather than a release gate.

> **Note on what this deliberately does not cover:** a compose stack cannot
> validate Helm values, Kong ingress or cross-namespace wiring, and
> `DEPLOYMENT.md` already records that `install.sh` checks pod readiness only.
> That gap belongs to a post-deploy smoke phase in `bluedots-automation`
> **(planned)**, not to a compromise here. Browser/UI coverage is likewise out
> of scope for v1 **(planned)**.

### 4.2 The entry point

One command. CI and a developer's laptop differ only in flags — a suite whose
only working path is the CI path is a suite nobody reproduces.

```
pnpm journey                                   # everything
pnpm journey --journey J2                      # one scenario, all its networks
pnpm journey --network purple_dot              # one network, all its scenarios
pnpm journey --list                            # print the matrix, boot nothing
pnpm journey --keep-stack                      # leave containers up to debug
pnpm journey --images-from-tag 202608-s1-rc1   # what CI runs
```

`pnpm journey` is exactly what the CI workflow invokes. It runs five phases, and
each names its own failure so a red run says *where* it broke:

```
 1 resolve   tag → four image digests (poll, 20min budget)   RESOLVE_TIMEOUT
 2 up        compose up; await health + migrations           STACK_UNHEALTHY
 3 seed      Keycloak users, service identities, orgs        SEED_FAILED
 4 run       scenarios × networks under vitest               <scenario> FAILED
 5 report    render the three artifacts; capture triage      (never fails)
```

Phase 5 runs on success and failure alike (`always()` in the workflow). That is
structural, not a convenience: a gate that explains nothing when red is a gate
that gets disabled.

Phase 3 is what removes the runbook's manual steps. All three UI-driven steps
already have API routes; the only blocker was authentication. Because
`aggregator_id` and `aggregator_type` are Keycloak **user attributes** mapped to
JWT claims by protocol mappers in the checked-in realm, the harness creates a
real user through the Admin API and does a direct grant. The service then
performs its genuine authorization check — **no OTP scraping, and no test-only
code in the product.**

### 4.3 What the suite does

**The contract layer** runs in each service repo's PR CI. `oasdiff breaking`
diffs that repo's committed `openapi.json` against its base ref and fails only
on consumer-visible breaks — a removed endpoint or response field, a
newly-required parameter, a narrowed enum — so additive change is silent. This
works because of an existing property: three repos already fail CI when the
spec is stale against the code, so the spec is a trustworthy proxy for the
implementation. Alongside it, one shared JSON Schema describes the event
**wire** payload and is asserted from both the producer and the consumer against
one set of shared valid and poison fixtures.

> **Note on Pact:** consumer-driven contract testing was considered and
> rejected for v1 — it needs a broker plus sustained two-sided discipline, and
> for six known internal edges `oasdiff` plus shared fixtures reaches most of
> the value far cheaper. Revisit if external adopters begin consuming these APIs.

**The journey layer** covers five journeys, tiered by risk across three networks
rather than run as a full 5 × 4 matrix:

| Journey | Spans | Networks |
|---|---|---|
| Onboarding → dashboard | aggregator → signals-dpg | purple, blue, orange |
| Item → event → search hit | signals-dpg → signals-search | purple, blue |
| Action → notification delivered | signals-dpg → notification-service | purple, blue |
| Consent → PII disclosure gating | signals-dpg | purple, blue |
| Voice bot participant + action flow | external → signals-dpg + search | purple, blue |

`yellow_dot` is excluded; its one distinctive case — a network with zero
vectorize fields must index as a no-op rather than error — is a signals-search
unit test, which never needed a four-service stack.

Four asynchronous workers participate, so flake control is design rather than
detail: waits are **poll-with-deadline** helpers only (never `sleep`), the suite
asserts on **queue and stream drain** rather than elapsed time, dashboard reads
force a recompute first, and scenarios parallelize **by network** while
serializing within one. Concentrating every wait in one small module is what
makes this reviewable — a bare `sleep` in a diff can be rejected because the
alternative already exists and is named.

**Verifying the suite itself.** A falsely-green gate is worse than no gate: if a
wait helper silently resolves on timeout, every scenario passes vacuously. So
the harness carries its own fast unit tests (fixture determinism, report
rendering, the lint rules), **negative controls** — wait helpers tested against
a stub that never converges and required to time out, and a scenario run against
deliberately wrong expected values and required to fail — and a
`harness-selftest` CI job running two canary scenarios, one built to pass and
one built to fail, asserting the runner reported exactly one of each and exited
non-zero. Mutation-testing the harness was considered and rejected as poor value
against those three.

### 4.4 Output

Three artifacts, because three audiences need materially different things and
collapsing them serves none of them.

| Tier | Artifact | Audience |
|---|---|---|
| 1 | exit code + GitHub check — binary, no prose | CI, branch protection |
| 2 | journey × network grid, step trace, expected-vs-actual on failure | developer, release manager, architect |
| 3 | one-page evidence sheet, business language, aggregated by capability | product, client, compliance |

Tier 3 is the answer to whether a non-engineer can act on this:

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

What keeps this legible is a constraint, not a renderer. Every scenario and
every step carries a plain-English label written once, beside its definition
(§4.5), and **that label is the line the report prints**. Nothing is translated
at render time, so the business-facing report is structurally incapable of
drifting from what the tests assert — which is the usual reason such reports
stop being trusted.

The **NOT COVERED** block is generated, not written: derived from the
consumed-pair manifest's uncovered edges plus the declared non-goals. A report
listing only passes invites the reader to assume everything was checked; an
honest artifact states its own boundary, and generating it means it cannot go
stale.

On failure the run also emits a **triage bundle** as one artifact — per-service
container logs, a `pg_dump` of the touched tables, the four resolved digests,
the seeded identities, and the failing scenario's step trace — so "what state
was it in?" is answerable without a rerun.

> **Note on the canonical record:** `summary.json` is the source both renderers
> read; JUnit XML is derived from it purely to feed GitHub's check UI, since
> JUnit cannot carry a capability, a skip reason or digest provenance.
> Run-over-run trend data (flake rate, duration drift) is **(planned)** and
> needs only that these summaries be retained per tag.

### 4.5 Adding a scenario

A scenario is a **list of named steps**, not a program. This is the property
that makes the system a framework rather than a suite:

```ts
defineJourney({
  id:         'J6',
  title:      'A paused profile disappears from search and returns when unpaused',
  capability: 'search-and-discovery',
  networks:   ['purple_dot', 'blue_dot'],

  steps: [
    createProfile({ as: 'seeker' }),
    waitUntilSearchable(),
    expectFoundInSearch(),
    pauseProfile(),
    waitUntilNotSearchable(),
    expectNotFoundInSearch(),
    unpauseProfile(),
    waitUntilSearchable(),
    expectFoundInSearch(),
  ],
});
```

There is no TypeScript in that scenario — no `await`, no control flow, no
assertions expressed in test syntax. It reads as the scenario it is, and it is
the artifact a reviewer or an architect reads to know what is covered.

The TypeScript lives in the step library, written once, with each step's label
beside its implementation:

```ts
export const pauseProfile = step({
  label: 'Pause the profile',
  run: (ctx) => ctx.clients.signals.lifecycle({ item_id: ctx.state.item_id, to: 'paused' }),
});
```

Because the label is declared there, the Tier-2 report renders a trace anyone
can follow:

```
 ✓ Created a seeker profile
 ✓ Waited until it was searchable
 ✓ Found it in search
 ✓ Paused the profile
 ✗ Waited until it was no longer searchable — timed out after 30s
```

Steps compose from five extension points, and a step is the only place they are
reachable: **actors** (who is calling — `aggregatorOperator('seeker')`,
`voiceBot()`), **clients** (typed, *generated* from each service's
`openapi.json`), **awaiters** (the only sanctioned way to wait),
**projections** (what you assert on — `dashboardRollup`, `searchHits`,
`mailbox`), and **fixtures** (per-network seeded generators).

Generating the clients is load-bearing rather than cosmetic: since the four
specs are already CI-proven fresh, generation is free and buys a second contract
check — a provider that removes a response field breaks the harness
**typecheck**, before any container starts. The two layers reinforce each other
instead of merely coexisting.

The resulting cost of change is the real answer to "is it generalised enough":

| To add | You touch | Cost |
|---|---|---|
| A scenario from existing steps | one list | **no TypeScript** |
| A new step | one `step({ label, run })` | ~10 lines |
| **A whole new network** | a `network.json` + a `plan.json` | **no test code** |
| A new thing to assert on | one projection, then the step | ~half a day |
| A new service in the stack | compose entry + generated client + projection | 1–2 days |

The network row carries the generality claim and is the sharpest break from
today: a network is a **matrix parameter, not a copy**. The runbook cannot do
this — its expected values are prose written for `purple_dot`, so a second
network means a second document.

Three guard rails keep the readable-report property from eroding, enforced by
lint in the harness's own tests so they fail in review rather than in a report
months later. A `title` and a step `label` must read as prose and must not
contain a route path, an identifier or a service name. A `capability` must be
one of five declared slugs, so the reported taxonomy is closed and no scenario
can pass outside it. And a scenario needing genuine logic must say so
explicitly, via `custom({ label, run })` — a named, labelled escape hatch, so
dropping to raw code is visible in review and in the report rather than
invisible inside a function body.

> **Note on why not Gherkin:** a Gherkin layer would buy the same
> natural-language surface at the price of a step-definition indirection between
> the sentence and the code, plus a second runner. Here the sentence *is* the
> step's declared label and the list *is* the test, so there is nothing to keep
> in sync. `defineJourney` remains a thin typed wrapper over vitest —
> filtering, watch mode, stack traces and reporters all stay vitest's.

### 4.6 Open questions

1. **Does a standard GitHub runner hold the stack?** A dozen-odd containers on
   16GB is plausible with the stub embedder but unproven; the escape is a larger
   runner. To be settled empirically in P2, not argued in advance.
   *(provisional)*
2. **Which host does the voice bot's search call target** — signals-dpg's
   `/network/item/discover` BFF or signals-search's `/v1/search` directly? The
   voice scenario assumes the BFF, being the path with the documented fallback.
   Confirm with the voice team before that journey is built. *(provisional)*
3. **Should signals-dpg's integration suites leave the `sonar` job?** They run
   under `continue-on-error` today, making regressions advisory (§2). Cheap and
   adjacent, but a separate decision with its own CI-time cost.
4. **The journey layer cannot be a branch-protection check.** It runs on a tag,
   which exists only after merge, so "an RC is not promotable until green" is a
   **procedural** gate in the promotion checklist rather than an enforced rule.
   Running the suite on `develop→main` promotion PRs behind an opt-in label
   stays available **(planned)** if that proves too weak.

---

## 5. Summary

Functional verification across the DPG services is presently a 479-line human
procedure whose scenario is well specified and whose execution is not
automatable in its present form, because three of its six steps run through a
UI. This design replaces it with two layers of different cost and cadence.

The **contract layer** runs on every pull request in under two minutes with no
containers, diffing each repo's `openapi.json` for consumer-visible breaks and
pinning the event envelope with one schema asserted from both ends. It retires
the failure class that has recurred repeatedly across signals-dpg #103, #104,
#112, #115, #122 and aggregator-dpg #399.

The **journey layer** runs on each release-candidate tag in a new
`bluedots-e2e` repo, resolving all four service images at that tag to digests,
booting them hermetically, minting identities so real authorization paths are
exercised rather than bypassed, and running five journeys across three networks.

Two properties decide whether it survives a year of maintenance, and both are
design rather than implementation. A scenario is a **list of named steps with no
TypeScript in it**, and a new network is **configuration with no test code at
all** — so the marginal cost of scenario six stays low enough that the suite
keeps growing instead of ossifying. And the **label written beside each step is
the line the report prints**, which is what lets one run produce a CI exit code,
an engineer's failure trace, and a one-page evidence sheet a product owner can
act on — without any of the three drifting from what the tests assert.

The recommended build order inverts apparent size: the contract layer is a few
days' work and retires a recurring production failure class, while the journey
layer is roughly two weeks and depends on the contract layer having already
pinned the wire shapes beneath it.
