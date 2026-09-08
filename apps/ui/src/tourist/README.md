# orange_dot Tourist Discovery UI

A standalone, **login-free** web app for the `orange_dot` network. A visitor opens
it, the browser asks for their location, and they discover practitioners around
them on a map (and in a nearest-first list). There are **no accounts, no profiles,
no sidebar, and no "my actions"** — just discovery. Each practitioner card offers
three actions: **Call**, **Website**, and **Get Directions**.

It lives entirely under `apps/ui/src/tourist/` as a **second Vite build entry**
inside the existing `apps/ui`, selected at build/dev time by `VITE_APP=tourist`.
The normal signals UI is untouched — the tourist code is dormant unless that flag
is set, so this can ship on the same branch and be lifted into its own repo later.

- Design spec: [`docs/superpowers/specs/2026-06-11-orange-dot-tourist-ui-design.md`](../../../../docs/superpowers/specs/2026-06-11-orange-dot-tourist-ui-design.md)
- Implementation plan: [`docs/superpowers/plans/2026-06-11-orange-dot-tourist-ui.md`](../../../../docs/superpowers/plans/2026-06-11-orange-dot-tourist-ui.md)

## Running it locally

The tourist UI is just a frontend; it talks to the **existing signals-dpg API**
configured to serve `orange_dot`. No backend changes are needed — the
`/api/v1/network/schemas` and `/api/v1/network/item/fetch` read endpoints are
reachable anonymously.

1. **Bring up the API for `orange_dot`** (Postgres + Redis + the API serving
   `orange_dot/practitioner`). The repo's normal local-run flow does this; in
   short: `docker compose up -d db redis`, set `SERVED_DOMAINS="orange_dot/practitioner"`
   and `NETWORK_CONFIG_LOCAL_FILE` to the orange `network.json` in the root `.env`,
   apply `apps/api/db/postgres/schema.sql`, and start the API on `:2742`.
2. **Start the tourist UI** (Vite dev server on `:3000`):
   ```bash
   pnpm dev:tourist
   ```
   This runs `vite` with `VITE_APP=tourist VITE_NETWORK_ID=orange_dot`. Open
   http://localhost:3000.

To run any **other** dot's normal signals UI instead, do **not** set `VITE_APP`
(use `pnpm dev:ui` with `VITE_NETWORK_ID=<dot>` as usual).

### Build

```bash
pnpm build:tourist
```
Outputs to `apps/ui/dist/tourist/` (its own `index.html`, separate from the
signals build's `dist/`). Serve that directory statically; it expects the API at
the configured `VITE_API_URL` (defaults to `http://localhost:2742`).

## How the separation works

| Concern | Mechanism |
|---|---|
| Entry | `apps/ui/index.tourist.html` → `src/tourist/main.tourist.tsx` |
| Build/dev selection | `VITE_APP=tourist` in `apps/ui/vite.config.ts` (dev rewrites `/` to the tourist entry; build sets `outDir: dist/tourist` + the input). When unset, the signals build is byte-identical. |
| Scripts | root + `apps/ui` `dev:tourist` / `build:tourist`; `turbo.json` tasks |
| Network | runtime-resolved (`?network=` → `VITE_NETWORK_NAME` → `VITE_NETWORK_ID` → `'orange_dot'` default); brand resolved in parallel (`?brand=` → `VITE_BRAND_NAME` → `VITE_DEFAULT_BRAND` → `'standard'`). See `resolve-tourist-config.ts`. |
| Backend | the shared signals-dpg API, read anonymously — **no backend code changes** |

## Files

- `main.tourist.tsx` — React entry. Mounts the provider chain
  (`ThemeModeProvider` → `TooltipProvider` → `QueryClientProvider`) + i18n + the
  map-provider side-effect import, then renders `<TouristApp/>`. **No** AuthProvider/router.
- `tourist-app.tsx` — orchestration. Fetches the orange network config +
  practitioner items (React Query, anonymous), resolves the visitor's location,
  owns search / view-mode / filter state, runs the search + enum-filter pipeline,
  and renders the shell + map/list + location banner + loading/error/empty states.
- `tourist-top-bar.tsx` — slim app bar: orange logo, search, Map/List toggle,
  filters slot, language + theme. Composes the same leaf controls as the signals
  `TopBar` **without** its auth/sidebar/router dependencies.
- `tourist-map.tsx` — wraps the shared `MapView`; fills its container (`h-full`),
  renders `PractitionerCard` popups, and supplies the category icon resolver.
- `tourist-list.tsx` — practitioners as `PractitionerCard`s, sorted nearest-first
  when the visitor's location is known; empty state otherwise.
- `practitioner-card.tsx` — wraps the shared `ItemCard` and supplies the three
  actions.
- `practitioner-actions.tsx` — the Call / Website / Get Directions buttons; each
  is hidden when its field is absent.
- `practitioner-data.ts` — pure helpers: `itemToCardItem`, `getPrimaryLocation`,
  `matchesSearch`, and the `CardItem` type.
- `category-icons.ts` — maps the practitioner `category` enum to a marker icon
  (see below).
- `enable-location-banner.tsx` — shown when geolocation is denied/unavailable.
- `*.test.tsx` / `*.test.ts` — vitest + React Testing Library unit tests.

## Reused from the signals app (imported read-only)

`components/map/map-container.tsx` (`MapView`), `components/map/browse-filters-panel.tsx`,
`components/cards/item-card.tsx`, `lib/enum-filters.ts`, `lib/geo/*`
(`distance`, `directions`, `types`), `hooks/use-browser-location.ts`,
`lib/network-api.ts`, `lib/item-api.ts`, the shadcn UI primitives, and the
language/theme switchers.

## Behaviour notes

- **Location.** Uses `useBrowserLocation` directly (no profile path). On load it
  auto-requests the browser location once. Granted → map centres on the visitor,
  list sorts nearest-first. Denied/unavailable → map centres on a region default
  (Udupi, `[13.3409, 74.7421]`, zoom 12; override with `VITE_TOURIST_DEFAULT_CENTER`)
  and the Enable-location banner offers to re-request. Discovery still works
  without permission.
- **Marker icons by category.** `MapView` takes an optional `resolveMarkerIcon`
  prop (defaulting to the signals domain-based icon, so signals is unchanged). The
  tourist map passes `resolvePractitionerIcon`, which keys on `data.category`:
  Stay → BedDouble, Artists → Palette, Activities → Compass, GI Products →
  ShoppingBag, Curated → Sparkles, fallback → MapPin.
- **Get Directions** (`lib/geo/directions.ts`) is platform-aware: Android `geo:`
  chooser, iOS Apple Maps, desktop Google Maps directions. **Call** uses `tel:`
  (`+91` prefix for bare 10-digit numbers). **Website** opens in a new tab,
  normalised to `https://`.
- **Clusters** show just the total count (single-domain network → no per-domain
  breakdown chips).
- **i18n.** Card actions and states use `tourist.*` keys present in
  `src/i18n/locales/{en,kn,hi}.json`.
- **Theming.** `index.tourist.html` sets `data-network="orange_dot"`, so the
  Vite brand-theme plugin injects the orange palette and the app uses the orange
  logo + favicon.

## Backend / data

- The app only **reads**. It calls `fetchNetworkConfig('orange_dot')` and
  `fetchNetworkItems({ item_network: 'orange_dot', item_domain: 'practitioner',
  item_type: 'profile_1.0', limit: 100 })`. The API caps page size at 100.
- Practitioners are created/managed elsewhere (the signals app or seeding) — the
  tourist UI never writes. `contact_phone` and `website` are public fields in the
  orange practitioner schema; locations come back in `item_locations`.

## Tests

```bash
pnpm --filter ui test            # whole UI suite (includes the tourist tests)
```
The tourist unit tests cover the pure helpers (`directions`, `practitioner-data`,
`category-icons`) and the components (`practitioner-actions`, `practitioner-card`,
`enable-location-banner`, `tourist-top-bar`, `tourist-list`). `tourist-app` and
`tourist-map` are exercised via build + manual QA rather than unit tests.
