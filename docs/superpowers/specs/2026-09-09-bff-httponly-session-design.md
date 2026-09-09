# Browser Session Behind an httpOnly Cookie (BFF) — Design

**Findings:** `AUTH-VULN-03` (Signals-DPG as Seeker), `AUTH-VULN-04` (Signals-DPG as Provider) — Aug-2026 VAPT
**Related epic:** [signals-dpg#420](https://github.com/Blue-Dots-Economy/signals-dpg/issues/420) (Central IAM & Auth)
**Date:** 2026-09-09
**Branch:** `feat/bff-httponly-session` (off `feature`)

## Problem

The UI performs the OIDC authorization-code exchange in the browser and keeps
the result in `localStorage`:

- `apps/ui/src/lib/auth-token.ts` writes the Keycloak **access token** under the
  fixed key `auth_token`.
- `oidc-client-ts` maintains its own store under `oidc.user:<authority>:<client>`,
  which holds the **refresh token** and the id token.

Both keys are readable by any script executing on the origin. The pentest read
them, and confirmed that the extracted values authenticate against the API from
outside the browser entirely — the refresh token in particular can be replayed
against Keycloak to mint fresh access tokens indefinitely, so the exposure does
not end when the stolen access token expires.

Two properties make this worse than a generic XSS consequence:

1. **The credential outlives the page.** An attacker who reads storage once
   holds a working credential on their own machine for the refresh token's whole
   lifetime. Nothing in the app can revoke it.
2. **It is the full session.** These are not scoped tokens. They are what the
   API accepts as "this user", including on admin-adjacent surfaces the user's
   roles reach.

The class of fix is well established and is the one `aggregator-dpg` already
runs: the browser must not hold the credential at all.

## Goals

- No token of any kind reaches browser-readable storage — `localStorage`,
  `sessionStorage`, IndexedDB, or a script-readable cookie.
- The user-visible login flow is unchanged: same Keycloak screen, same OTP, same
  consent gate, same landing decisions.
- Existing service-to-service integrations keep working with no change on their
  side.
- The `AUTH_PROVIDER=betterauth` rollback path keeps working.

## Non-goals

- **Not a Keycloak migration.** `AUTH_PROVIDER=keycloak` is assumed already
  live; this changes only where the resulting session lives.
- **Not a change to authorization.** The client allowlist, the realm-role gate,
  self-signup gating and acting-org rules are all unchanged. Only the transport
  of the session changes.
- **No new identity provider, no new client.** The design must work with the
  public `signals-ui` client that the realm already registers.
- **No database migration.** Sessions live in Redis; nothing in Postgres moves.
- **The tourist app is out of scope** — it is anonymous and holds no session.
  There is no token, storage or `Authorization` usage anywhere under
  `apps/ui/src/tourist/`, so it needs no equivalent treatment.

## Options considered

### Option A — keep the exchange in the browser, hold tokens in memory only

Drop `localStorage`, keep the access token in a module variable, and re-acquire
it via a silent iframe/refresh on reload.

**Rejected.** It narrows the window without closing the hole: the token is still
in the page's address space, so the same XSS that read storage can read the
variable or simply call the API through the app's own client. It also breaks the
refresh story — a page reload has nothing to restore from, so either the refresh
token goes back into storage (defeating the point) or every reload bounces
through Keycloak.

### Option B — httpOnly cookie + backend-for-frontend (chosen)

Move the code exchange to the API. The browser receives an opaque session id in
an `httpOnly` cookie it cannot read; tokens live server-side in Redis.

**Chosen.** It is the only option where the credential is *absent* from the
browser rather than merely harder to reach, it matches the model `aggregator-dpg`
already runs (so the two repos converge rather than diverge), and it needs no
realm-level client change.

The cost is honest and is accounted for below: a cookie is attached by the
browser automatically, which is the one respect in which it is weaker than an
`Authorization` header. That is what §6 exists to answer.

## Design

### 1. Where the exchange happens

**Today**

```
browser ──> Keycloak ──> browser (?code=…)
                              │
                              └─ browser exchanges code for tokens
                                 browser writes tokens to localStorage
```

**Proposed**

```
browser ──> API /auth/session/login ──> Keycloak ──> API /auth/session/callback
                                                          │
                                                          ├─ API exchanges code
                                                          ├─ API stores tokens in Redis
                                                          └─ Set-Cookie: sid=<opaque>
                                                             302 → <app>/auth/callback
```

The PKCE code verifier is minted on the API, held against the flow's `state`,
and read back in the callback. It never reaches the browser — which is the whole
reason the exchange has to move rather than merely the storage.

PKCE is used with the **public** `signals-ui` client rather than introducing a
confidential one. Because the verifier never leaves the server, a public client
is sufficient here, and reusing the registered client is what keeps this a
code-only change on the Keycloak side (see §10).

### 2. New API surface

Four routes under `/api/v1/auth`, in `apps/api/src/routes/v1/auth/session.ts`:

| Route | Purpose |
|---|---|
| `GET /session/login` | Mint `state` + PKCE, park the flow, 302 to Keycloak |
| `GET /session/callback` | Exchange the code, open a session, `Set-Cookie`, 302 to the app |
| `GET /session` | "Am I logged in, and what CSRF token should I send?" |
| `POST /session/logout` | Destroy the session, clear the cookie, return the Keycloak end-session URL |

`GET /session/login` returns **404** when `AUTH_PROVIDER` is not `keycloak`, so
a betterauth instance does not advertise a half-working flow.

**No response on any path may contain a token.** This is the property the whole
design rests on, so it is asserted directly in tests (§9) over the flattened
headers *and* body of each response, rather than being left to review.

### 3. Session store — `apps/api/src/services/auth/browser_session.ts`

Redis-backed, keyed by an opaque 32-byte (256-bit) random id.

**Session ids are stored hashed.** The cookie carries the raw id; the store only
ever sees its SHA-256. Redis is shared infrastructure and its keys surface in
`KEYS`/`MONITOR` output, backups and support dumps — a raw id there would be a
bearer credential sitting in plaintext, which is the shape of the problem this
work exists to remove. Hashing means a leaked key listing cannot be replayed as
a login.

Stored per session:

```ts
interface BrowserSession {
  accessToken: string;
  refreshToken: string;
  accessTokenExp: number;   // epoch ms
  refreshTokenExp: number;  // epoch ms
  idToken?: string;         // logout hint only — see §7
  csrfToken: string;
  appOrigin: string;        // see §8
  createdAt: number;
}
```

**TTL is the lesser of an 8-hour sliding window and the refresh token's own
remaining life.** Without the second bound a session would appear alive after
Keycloak had stopped honouring its refresh token, and the user would hit a
failure mid-request instead of a clean re-login. An already-expired refresh
token floors the TTL at 1 second rather than passing a non-positive `EX` to
Redis, which would turn a stale session into a 500 instead of a logout.

The 8-hour window is deliberately aligned with the realm's `ssoSessionMaxLifespan`
(28800s), which the same VAPT round reduced from 10h under `AUTH-VULN-08`. A
local session outliving the SSO session it was derived from would be a second
instance of the bug that finding describes.

### 4. Cookie attributes

```ts
{
  httpOnly: true,
  secure: instance.INSTANCE_ENV !== 'development',
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_TTL_SECONDS,
}
```

- **`httpOnly`** is the control. Script cannot read the value at all, which is
  what closes the finding.
- **`secure` is conditional, not hardcoded.** Local dev is plain http, where a
  `Secure` cookie is silently dropped — which presents as "login does nothing"
  and is very expensive to diagnose.
- **`sameSite: 'lax'`, not `'strict'`.** The login *returns* from Keycloak via a
  top-level cross-site GET. `Strict` withholds the cookie on that navigation, so
  the user would land back on the app still logged out. `Lax` sends it on
  top-level navigations while still withholding it from cross-site POSTs, which
  is the case that matters. §6 covers the remainder.
- **No cookie signing.** The value is an opaque random id with no meaning
  outside Redis, so signing it would add a key to manage and prove nothing the
  session lookup does not already prove.

**Registration constraint:** `@fastify/cookie` must be registered at the **root**
scope and **before any route**, because it decorates `request.cookies` and
`reply.setCookie`. Registered later, or inside an encapsulated plugin scope, the
session routes and the cookie auth path see no cookies at all — and the failure
is silent on the read side (`request.cookies` is simply `undefined`), so it
reads as "the user is never logged in" rather than as an error.

### 5. Request authentication — `apps/api/plugins/auth/resolve_browser_session.ts`

A new resolver runs in `auth_middleware` **ahead of** the bearer path:

1. No `sid` cookie → `fallthrough`, so service and anonymous requests take the
   existing paths. A request with no session is not an error.
2. Cookie present but no session behind it → clear the cookie and 401, so the
   browser stops re-sending a credential that can never work again.
3. CSRF check (§6).
4. If the access token is at or within 30s of expiry, refresh it server-side and
   persist **both** rotated tokens. Keycloak rotates refresh tokens; keeping the
   old one would work once and then log the user out at the next refresh. A
   refusal from Keycloak destroys the session rather than leaving it holding
   credentials Keycloak will not honour.
5. `verifyKeycloakToken`, then `resolveHumanSession`.

Step 5 matters for review: **the existing authorization gates are reached
unchanged.** `resolveHumanSession` is extracted from `resolve_session.ts` and
called directly, so the client allowlist, the realm-role gate and provisioning
all still run against the same claims. Only how the token reached the API
changes.

The order — cookie before bearer — is what makes the change additive for service
callers: they send no cookie, fall through, and land on exactly the path they
use today.

### 6. CSRF

A cookie is attached automatically by the browser. That is the one way this is
weaker than the `Authorization` header it replaces, so `SameSite=Lax` is backed
by a second, server-side control.

**Double-submit token.** Each session carries a random `csrfToken`, returned to
the UI by `GET /auth/session` as readable JSON. The UI echoes it in
`x-csrf-token` on every state-changing request. A cross-site page can cause the
cookie to be sent but cannot read that JSON response, so it cannot supply the
header.

- `GET`/`HEAD`/`OPTIONS` are exempt — they cannot change state.
- Missing, empty or mismatched → **403 `CSRF_TOKEN_INVALID`**.
- Compared with `timingSafeEqual` behind a length pre-check (the length is not
  the secret, and `timingSafeEqual` throws on a length mismatch — an unguarded
  call would surface a bad token as a 500 rather than a 403).
- A CSRF failure **must not** clear the cookie. The session is fine; it is the
  request that is not. Logging the user out here would let any cross-site page
  sign them out at will.

The CSRF token is the one value that is deliberately script-readable. It is not
a credential on its own — it authorises nothing without the cookie.

**Ordering note:** Fastify runs schema validation *before* `preHandler`, so a
request with a malformed body is rejected as a 400 before the CSRF check runs.
That is not a gap (no state changes on a 400), but tests asserting the CSRF
behaviour must send a **schema-valid** body or they assert nothing.

### 7. Logout

`POST /session/logout` destroys the server-side session, clears the cookie, and
returns the Keycloak end-session URL for the UI to navigate to.

Both halves are required. Dropping only the local session leaves the SSO session
alive, so the next login silently signs the same user straight back in without
asking for credentials.

Two details the realm forces:

- **`post_logout_redirect_uri` must be `<appOrigin>/auth/login`.** The realm
  registers post-logout URIs as **exact matches with no wildcard** — `/` and
  `/auth/login` only. Sending the API's own origin, or a path with a trailing-
  slash mismatch, is silently refused.
- **`id_token_hint` must be supplied.** Without it Keycloak cannot tell whose
  session is ending and interrupts the user with a "Do you want to log out?"
  confirmation screen. `oidc-client-ts` supplies this hint today from its own
  store, so omitting it would be a visible regression. This is the only reason
  the id token is retained in the session at all; it never reaches the browser.

### 8. The UI and the API are not assumed to share an origin

Locally they are `:5173`/`:3000` and `:2742`. A deployment may put them on one
host (path-routed) or two.

Consequences:

- The callback cannot redirect to a bare path and assume it lands on the app.
- An unchecked origin taken from the request would be an **open redirect** —
  `?appOrigin=https://evil.test` would authenticate the user for real and then
  land them on the attacker's page holding a live session.

**Design:** the UI passes `window.location.origin` as `?appOrigin=` on
`/session/login`. The API validates it against `allowed_origins` — the existing
CORS allowlist — and falls back to its own origin if it does not match. That
list is exactly right and needs no new env var: any origin the UI can actually
call this API from is already in it by necessity, and nothing else can be. The
validated value is carried in the flow state and stored on the session, so
logout (§7) can use it too.

`returnTo` is constrained separately by `safeReturnTo`: it must start with a
single `/`. Protocol-relative `//host` is rejected explicitly, since a naive
"starts with `/`" check admits it.

### 9. Flow state — `apps/api/src/services/auth/oidc_flow_state.ts`

The in-flight half of a login (verifier, nonce, `returnTo`, `consentAttempt`,
`redirectUri`, `appOrigin`) is held in Redis keyed by the **SHA-256 of `state`**,
with a 5-minute TTL, and read with `GETDEL`.

- Keyed by hash for the same reason as the session id: `state` is a credential
  for this flow and must not sit in a key listing.
- **Single-use.** `GETDEL` deletes as it reads, so a replayed callback finds
  nothing and is rejected rather than minting a second session from one
  authorization.
- Short TTL because this only has to survive one Keycloak round-trip; a longer
  window merely widens the replay surface on `state`.

Holding this server-side rather than in a cookie is what keeps the PKCE verifier
off the browser.

### 10. Closing the browser bearer channel

Leaving `Authorization: Bearer <user token>` accepted would leave the vulnerable
path alive next to the fixed one: anything that obtained a user token could still
call the API directly, which is precisely what the pentest demonstrated. An
httpOnly cookie is worth nothing while a second, script-attachable credential is
accepted for the same identity.

**Therefore: a human token presented as a bearer is refused —
401 `BEARER_SESSION_NOT_SUPPORTED` — however valid it is.** The fork stays on
`isServiceAccountToken`, so:

| Caller | Credential | Status |
|---|---|---|
| Integrating DPG (voice-dpg, aggregator-dpg) | `client_credentials` bearer | **unchanged** |
| Integrating DPG | `x-api-key` | **unchanged** (checked first, returns before this code) |
| Browser user | cookie | new |
| Browser user | bearer | refused |

Every human client Signals serves is the browser SPA, which this design drives
end to end. Adding a human client that *cannot* hold a cookie — a native app,
say — means giving it a channel of its own, not re-opening this one for
everybody. That trade should be revisited only with a concrete client in hand.

**This is the one change with blast radius outside the browser**, so it needs
explicit sign-off, and §12 lists how it will be verified against the real
integration collections before merge.

### 11. UI changes

- **New:** `apps/ui/src/lib/bff-session.ts` — `fetchBffSession`,
  `startBffLogin`, `endBffSession`, `getCsrfToken`, `clearCsrfToken`. It holds
  no credential; the CSRF token is kept in a module variable and re-read from
  the API on reload, never persisted.
- **Deleted:** `apps/ui/src/lib/auth-token.ts` and
  `apps/ui/src/lib/oidc-client.ts`, plus the `oidc-client-ts` dependency — its
  store is the second half of the finding, so leaving the package installed
  would leave the mechanism available to reintroduce.
- **`api-client.ts` / `action-api.ts`:** the Bearer interceptor becomes a CSRF
  interceptor on non-safe methods. `withCredentials: true` is already set on
  both clients, so the cookie rides along cross-origin without further change.
- **`auth-context.tsx`:** the session is restored by asking the API rather than
  by reading storage. The existing precedence guard (`authEpochRef`) is retained
  — a first login can still race the mount-time restore, and the guard costs one
  integer.
- **`oidc-callback-page.tsx`:** the exchange is removed. The page reads
  `returnTo` / `consentAttempt` from the URL the API redirects it to. Everything
  that happens *after* a session exists — consent resume, the wrong-portal
  domain gate, the U18 guardian gate, the first-time-login profile redirect — is
  untouched. Preserving that behaviour exactly is a hard requirement, not a
  best effort.
- **`startBffLogin` is a full navigation, not a fetch.** The flow ends in a
  Keycloak redirect and a `Set-Cookie` on the way back, neither of which
  survives an XHR.

**Legacy cleanup.** Not writing new tokens does nothing about the ones already
sitting in every user's browser — and those are the tokens the pentest actually
read. `apps/ui/src/lib/purge-legacy-auth-storage.ts` removes `auth_token` and
any `oidc.*` keys on boot of **both** entry points (`main.tsx` and
`main.tourist.tsx`). It must collect keys before removing them, since mutating
a storage object mid-iteration reindexes it and silently skips entries, and it
must not throw where storage is unavailable (Safari private mode, blocked
third-party contexts) or the app fails to boot.

### 12. Keycloak realm

Because the browser is now redirected back to the **API**, the API's callback
must be a registered redirect URI for `signals-ui`.

- `infra/keycloak/realms/bluedots-realm.json` gains
  `__API_BASE_URL__/api/v1/auth/session/callback` in `redirectUris` and
  `__API_BASE_URL__` in `webOrigins`; `localhost:3000` is added alongside 5173.
- `infra/keycloak/render-realm.sh` gains an `API_BASE_URL` placeholder,
  **defaulting to `PUBLIC_BASE_URL`** — correct wherever the UI and API share a
  host, which is the common deployment shape.

**Constraint:** Keycloak stores a client `description` in a `VARCHAR(255)`
column. A longer value fails the whole realm import, not just that field.

**This template change does not reach an existing realm.** `--import-realm`
skips a realm that already exists, and the init Job reconciles clients and
service-account roles only. Rollout implications are in §14.

### 13. `AUTH_PROVIDER=betterauth`

Unaffected, and must stay that way — it is the documented rollback path.

Its session is already a cookie that better-auth sets and reads itself, and
`withCredentials: true` is already set on the shared axios client, so the Bearer
header the UI also sent on that path is redundant. Removing token storage
therefore costs the betterauth path nothing. This will be verified end to end
rather than assumed (§15).

## Files affected

**New — API**

| File | Role |
|---|---|
| `apps/api/src/services/auth/oidc_exchange.ts` | Server-side PKCE exchange + refresh |
| `apps/api/src/services/auth/oidc_flow_state.ts` | Single-use flow state, redirect guards |
| `apps/api/src/services/auth/browser_session.ts` | Redis session store |
| `apps/api/src/routes/v1/auth/session.ts` | The four routes |
| `apps/api/plugins/auth/resolve_browser_session.ts` | Cookie auth channel + CSRF |

**Modified — API**

| File | Change |
|---|---|
| `apps/api/src/app.ts` | Register `@fastify/cookie` at root scope |
| `apps/api/plugins/auth/auth_middleware.ts` | Cookie channel ahead of bearer |
| `apps/api/plugins/auth/resolve_session.ts` | Export `resolveHumanSession`; refuse human bearers |
| `apps/api/src/routes/v1/v1_routes.ts` | Register `auth_session` |
| `openapi.json` | Regenerate — four new paths |

**New / modified — UI**

| File | Change |
|---|---|
| `apps/ui/src/lib/bff-session.ts` | New — session client |
| `apps/ui/src/lib/purge-legacy-auth-storage.ts` | New — one-time cleanup |
| `apps/ui/src/lib/auth-token.ts`, `lib/oidc-client.ts` | **Deleted** |
| `apps/ui/src/lib/api-client.ts`, `lib/action-api.ts` | Bearer → CSRF interceptor |
| `apps/ui/src/contexts/auth-context.tsx` | Restore/login/logout via the BFF |
| `apps/ui/src/pages/auth/oidc-callback-page.tsx` | Exchange removed; params from URL |
| `apps/ui/src/main.tsx`, `src/tourist/main.tourist.tsx` | Call the purge on boot |
| `apps/ui/package.json` | Drop `oidc-client-ts` |

**Infra**

`infra/keycloak/realms/bluedots-realm.json`, `infra/keycloak/render-realm.sh`,
`local-setup/docker-compose.yml` (`API_BASE_URL`).

## Testing

### Unit

New suites for each new module. The assertions that carry security weight, and
which must not be left to review:

- **`browser_session`** — the raw session id never appears in any Redis argument;
  TTL is bounded by the refresh token; an expired refresh token floors at 1s, not
  a negative `EX`; `updateSession` derives its TTL from the **new** expiry.
- **`oidc_flow_state`** — keyed by hash, not by `state`; `GETDEL` not `GET`;
  `safeReturnTo` rejects absolute and protocol-relative URLs; `safeAppOrigin`
  rejects a near-miss such as `https://app.example.org.evil.test` rather than
  matching on a prefix.
- **`oidc_exchange`** — the challenge is the S256 of the verifier; browser URLs
  use the public issuer while token requests use the internal one; a failed
  token response reports **only the status**, with the whole serialised error
  asserted not to contain the refresh token.
- **`resolve_browser_session`** — no cookie falls through; CSRF is enforced on
  every non-safe method and skipped on safe ones; a CSRF failure does not clear
  the cookie and does not reach provisioning; both tokens rotate on refresh; a
  refused refresh destroys the session.
- **`session` routes** — the "no token in any response" property, asserted over
  flattened headers + body on the callback and on `GET /session`.

Existing suites that assert token storage must be **inverted, not deleted** —
e.g. `expect(localStorage.getItem('auth_token')).toBeNull()` — so the absence is
pinned rather than merely untested.

### End-to-end, in a real browser against a real Keycloak

Unit tests cannot show that the flow works. The following will be exercised
against `local-setup`'s Keycloak with the real `bluedots` realm, driving Chrome:

1. Full login (Keycloak OTP via mailpit) → consent gate → landing.
2. Signed in: `localStorage`/`sessionStorage` hold no credential and
   `document.cookie` is **empty** — the cookie is invisible to script.
3. Page reload restores the session with nothing in storage.
4. An authenticated write (profile creation) carries `x-csrf-token` and no
   `Authorization` header.
5. A state-changing request with missing / wrong / empty CSRF → 403.
6. A **genuine, unexpired** user access token, lifted from the session store and
   presented as a bearer, → 401; the same identity over the cookie → 200. This
   is the pentest's own replay, and it is the single most important assertion in
   this document.
7. A stale or forged `sid` → 401 **and** the cookie is cleared.
8. An access token forced to near-expiry is refreshed server-side mid-session;
   both tokens rotate and the user sees nothing.
9. Sign-out destroys the session, ends the Keycloak SSO session, and lands on
   `/auth/login` with no interstitial.
10. `?returnTo=` and `?appOrigin=` pointing off-origin are both discarded.

### Regression — the integrations that must not break

Run before merge, not after:

- **`Voice Bot API flow (Keycloak bearer)` Postman collection.** Its token
  request is `grant_type=client_credentials`, so it takes the service path;
  confirm a real service token still authenticates on `/admin/participant`
  (read and write), with an unauthenticated control to prove the pass is real.
- **`Voice Bot API flow (x-api-key)` collection** — the key check runs first and
  returns before any of this code; confirm precedence is intact (a bad key must
  still fail as `INVALID_API_KEY`, not as a bearer).
- **`AUTH_PROVIDER=betterauth`** — a full OTP login with no bearer anywhere,
  confirming the session rides on better-auth's own cookie.

## Rollout

### Before deploy

**Verify the realm accepts the API's callback**, per environment. These are
read-only GETs against the realm and need no credentials:

| Probe (`client_id=signals-ui`) | Expected |
|---|---|
| `redirect_uri=<api-origin>/api/v1/auth/session/callback` | 200, login page |
| `redirect_uri=https://evil.test/x` (control) | 400 `Invalid parameter: redirect_uri` |
| `post_logout_redirect_uri=<app-origin>/auth/login` | 302 |
| `post_logout_redirect_uri=https://evil.test/auth/login` (control) | 400 |

The controls are not optional — without them a 200 could mean the realm accepts
anything.

Two shapes need a **manual realm edit** first, because the template change does
not reach an existing realm (§12):

1. **The API is on its own host.** `__PUBLIC_BASE_URL__/*` does not cover it —
   add `<api-origin>/api/v1/auth/session/callback` to *Valid redirect URIs*.
   Without it Keycloak refuses the redirect and **nobody can log in**.
2. **Two UI hosts share one realm** (a per-domain seeker/provider portal split).
   `render-realm.sh` substitutes **one** `PUBLIC_BASE_URL`, so the second host is
   registered nowhere. Note the failure is asymmetric: post-logout URIs are exact
   matches, so a missing entry breaks **sign-out only** while login still works —
   the kind of fault that surfaces in production rather than in a smoke test.

### Deploy ordering

The UI and API are separate images and this changes the contract between them, so
a half-deployed pair fails closed in **both** directions:

| Combination | Result |
|---|---|
| new API + old UI | The old UI sends its stored token as a bearer, which the new API refuses by design → users signed out, cannot sign back in. |
| old API + new UI | The new UI calls `/auth/session/login`, which does not exist → login impossible. |

**Deploy both in one window, API first.** A short interval of the middle row is
unavoidable and resolves when the UI image rolls.

**Every signed-in user will be logged out once by this release** — their old
token stops being accepted and the cookie does not exist yet. This is expected
and is the fix working. Announce it rather than fielding it as an incident.
Nothing is lost: profiles, consent and actions are all server-side.

No database migration ships with this, so rolling the pair back together is
clean.

### After deploy

Re-run probes 2, 5, 6 and 7 from the end-to-end list against the deployed
environment. Probe 6 in particular is the finding's own reproduction and is what
a retest will run.

## Risks and open questions

| # | Risk | Mitigation / status |
|---|---|---|
| R1 | A non-browser human client appears later (native app, CLI) and needs a bearer. | None exists today. Give it a channel of its own rather than re-opening §10 for everybody. **Open — needs product confirmation that none is planned.** |
| R2 | UI and API on different registrable domains (not just different hosts). `SameSite=Lax` is site-based, so subdomains of one registrable domain are fine; genuinely cross-*site* would require `SameSite=None; Secure`. | Not the current topology anywhere. **Open — confirm no environment is cross-site before merge.** |
| R3 | Redis outage now signs everyone out, where previously a stored token kept working. | Accepted: Redis is already a hard dependency of the API. Worth stating explicitly to whoever owns the SLO. |
| R4 | Session data grows in Redis. | Bounded by the 8h TTL and one key per active login; the same order as the existing OTP and cache keys. |
| R5 | A user with the old UI cached in their browser after deploy. | Covered by the deploy-ordering note; resolves on their next reload. |

## Acceptance

1. No token of any kind is present in `localStorage`, `sessionStorage` or
   `document.cookie` at any point in the signed-in lifecycle.
2. A genuine, unexpired user access token presented as `Authorization: Bearer`
   is rejected; the same identity over the cookie succeeds.
3. Tokens already in a user's browser from the previous build are removed on
   next load.
4. State-changing requests without a valid CSRF token are rejected with 403.
5. `returnTo` and `appOrigin` cannot redirect a freshly authenticated user
   off-origin.
6. The `client_credentials` bearer and `x-api-key` integration paths are
   byte-for-byte unchanged in behaviour.
7. `AUTH_PROVIDER=betterauth` continues to work as the rollback path.
8. Login, consent, the U18 gate, the wrong-portal gate, the first-time-login
   redirect and sign-out behave exactly as they do today.
