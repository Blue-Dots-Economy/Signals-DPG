# CLAUDE.md — apps/ui

Guidance specific to working inside `apps/ui`. Read the root `CLAUDE.md` first for the network/domain/instance/item/action vocabulary — it's defined backend-first there; this file only restates it where the frontend's usage differs or adds something.

**Frontend-specific vocabulary note:** the UI never talks to Postgres directly — it fetches a network's `network.json` (via `@dpg/schemas`' schema registry over HTTP) and renders forms/cards from the `item_schemas`/`card` config inside it. "Schema-driven" means the UI has no hardcoded knowledge of any domain's fields; adding a field to a network only requires editing `network.json`, not this app's code. See `src/engine/README.md` for how that resolution actually works — read it before touching anything under `src/engine/`.

## `runtime-env.ts` — the single most important undocumented mechanism here

`src/lib/runtime-env.ts`'s `getRuntimeEnv()` reads `window.__DPG_UI_CONFIG__` (written into `/config.js` by the Helm chart at deploy time) **before** falling back to the Vite build-time `import.meta.env`. This is what lets one built Docker image be reconfigured per deployment (different network, different API URL, different brand) without a rebuild. If you're adding a new configurable value, decide up front whether it needs to be reconfigurable post-build (route it through `getRuntimeEnv`) or is truly build-time-fixed (plain `import.meta.env` is fine) — most new config should go through `getRuntimeEnv`.

## The `@dpg/schemas/location_fields` alias is deliberate — don't "simplify" it

`vite.config.ts` aliases `@dpg/schemas/location_fields` directly to `packages/schemas/src/location_fields.ts`, bypassing the normal `@dpg/*` → `packages/*/src` mapping (which resolves through the package's barrel `index.ts`). This exists specifically so the browser bundle doesn't pull in `@dpg/database`/`pg` transitively through the schemas barrel — `location_fields.ts` is the one export from `@dpg/schemas` the UI needs that doesn't depend on the database package. If you see an import reaching for a *different* narrow export from `@dpg/schemas`, it needs the same carve-out, not a "just import from the barrel" fix.

## Two build/dev entry points

`VITE_APP=tourist` (see `package.json`'s `dev:tourist`/`build:tourist` scripts) switches to a second, login-free, read-only entry point layered on the same component tree. See `src/tourist/README.md` for the full picture — it's current and doesn't need duplicating here.

## Theming is two layers, not one

- **Per-network base theme** (`src/theme/network-themes.ts`, `theme-provider.tsx`) — one of several hardcoded palettes selected by network id.
- **Per-brand white-label override** (`src/theme/resolve-brand.ts`, `brand-assets.ts`, `brand-meta.ts`) — layered on top for a specific brand within a network (e.g. `upsdm` on `blue_dot`), driven by `examples/schemas/<network>/[<brand>/]brand.json` and injected via the `brandThemePlugin()` custom Vite plugin (`vite.config.ts`) at build/dev time.

Both resolve independently through the same priority chain: `?query` param → `window.__DPG_UI_CONFIG__` → build-time `VITE_*` → default.

`docs/design/ui-network-theming.md` describes the network layer accurately but **predates the brand layer** — for brand-specific asset/config conventions, `apps/ui/public/brand/README.md` is the current source of truth, not the design doc.

## i18n

`docs/design/ui-localization-design.md` covers the mechanism (i18next, `import.meta.glob`-bundled `locales/*.json`, `VITE_ENABLED_LANGUAGES` override) accurately, including the unset fallback of `DEFAULT_ENABLED_CODES = ['en', 'hi']` (`src/i18n/index.ts`) that deliberately keeps the retained-but-inactive `kn` locale off. Set `VITE_ENABLED_LANGUAGES=en,hi,kn` to re-enable it — **via the chart's `ui.runtimeConfig`, not a pod env var**: the value is read from runtime config first because `import.meta.env` is inlined at build time and CI publishes the UI image with no `VITE_` build args. The same applies to `VITE_MAP_DEFAULT_CENTER` / `VITE_MAP_DEFAULT_ZOOM`. Schema-driven content (a network's own field titles) is explicitly out of scope for i18n — only UI chrome is localized.

## Data fetching

No generated API client. `src/lib/api-client.ts` builds one shared `axios` instance with **two** interceptors — a request one attaching the per-session CSRF token on unsafe methods (the session itself rides an httpOnly cookie the browser sends automatically), and a response one that ends the session when the server says it is gone (see below) — and each `src/lib/*-api.ts` file (`auth-api`, `item-api`, `network-api`, `action-api`, `consent-api`, `wallet-api`, `digilocker-api`, `match-score-api`, `support-api`, `bulk-api`) wraps a specific set of endpoints by hand. React Query (`@tanstack/react-query`) is the caching layer, used via hooks (`use-network-config.ts`, `use-consent-config.ts`, `use-consent-gate.ts`, etc.) rather than context — `auth-context.tsx` is the only React Context in the app.

## Session expiry is a two-part chain — both parts are required

A dead session must terminate the client's, not just fail one request. The
pieces are deliberately in separate modules because the detector has no React
context and the reactor needs the QueryClient:

1. **`lib/api-client.ts`** — the response interceptor raises
   `emitSessionExpired()` on a 401 that means "your session is gone". Under the
   cookie session that code is `UNAUTHORIZED`, which an anonymous caller also
   receives, so the trigger additionally requires `getCsrfToken() !== null` —
   the non-React signal that this browser held a session.
   `TOKEN_EXPIRED`/`NO_ACTIVE_SESSION` are kept for the betterauth and service
   paths. Narrow on purpose: a 401 from a route the user merely may not call has
   to stay an ordinary error, and a 5xx never qualifies (the API answers a
   dependency outage with 503 precisely so it does NOT read as a logout — see
   `bff-session.ts`'s `unknown`).
2. **`contexts/auth-context.tsx`** — subscribes and does the terminal work:
   clear the CSRF token, `setUser(null)` (which is what actually stops polling,
   since every polled query carries `enabled: isAuthenticated`), cancel and drop
   the query cache, toast, and navigate to
   `/auth/login?reason=expired&redirect=…`.

**Why this is still needed after the BFF.** Renewal moved server-side, so the
old "renewed token never copied into storage" fault is gone — but nothing
replaced the *detection*. `fetchSession` runs on mount only and there is no
global error hook, so a session dying mid-use is discovered ONLY here. Without
it the app keeps rendering as signed-in and polls 401s indefinitely.

`lib/auth-events.ts` sits between them and **fires once per page lifetime**.
That latch matters: four queries poll `/api/v1/action/fetch`, so one expiry
surfaces as a burst of concurrent 401s, and without it each would trigger its
own logout and navigation. It is also why the anonymous-caller gate lives in the
interceptor rather than the handler — an anonymous 401 reaching the emitter
would spend the latch and swallow a real expiry later in the same page.

Relatedly, `lib/query-client.ts`'s `retry` never retries a 401/403 — an auth
failure cannot succeed without new credentials, so retrying it only multiplies
the noise. Read the status off `error.response.status` (axios) as well as
`error.status`.

The aggregator-dpg web app implements the same refresh-then-logout policy, split
server/client across its BFF (`apps/web/src/lib/upstream-client.ts` and
`apps/web/src/services/http.ts`) — worth reading if you change the policy here,
so the two products don't diverge.

## Largest files (candidates for splitting if you're touching them heavily)

`pages/home-page.tsx` (~1370 lines — filters, map/list toggle, domain tabs, search all in one page), `pages/profile-form-page.tsx` (~670 lines), `components/forms/schema-form.tsx` (~500 lines). Not broken, just large — expect to spend time finding the right spot before editing rather than assuming a small, focused file.
