# Brand assets (logos, favicons & brand overrides)

Per-network and per-brand assets for `signals-ui`. The UI loads logos by
convention — drop files in the right folder with the exact names below and
they are picked up automatically; no code change is needed for an existing
network or brand shape.

## Architecture overview

The UI supports two independent runtime dimensions:

- **Network** — the shared contract layer (`blue_dot`, `orange_dot`, …). Sets
  the base CSS token palette via `data-network` on `<html>`.
- **Brand** — an optional white-label skin layered on top of a network (e.g.
  `upsdm` on `blue_dot`, `onetac` on `orange_dot`). Sets CSS overrides via
  `data-brand` on `<html>`.

Both dimensions are resolved at runtime using the same priority chain:

```
?network= / ?brand= query param
  → window.__DPG_UI_CONFIG__.VITE_NETWORK_NAME / .VITE_BRAND_NAME  (Helm /config.js)
    → build-time VITE_NETWORK_ID / VITE_DEFAULT_BRAND
      → default ('blue_dot' / 'standard')
```

`standard` (or unset) means the agnostic network theme — no brand override.
A single Docker image serves every network × brand combination; the chart
controls which is active via `/config.js`.

## Folder & naming conventions

### Network logos (base path)

One folder per network, named by the **kebab-case** network id
(`blue_dot` → `blue-dot/`):

```
public/brand/<network-kebab>/
  logo.png
  logo-light.png
  logo-with-strapline.png
  logo-with-strapline-light.png
  logo-on-brand.png
  favicon.png            # square-mark networks only (see Favicon)
```

### Brand-specific logos (override path)

When a brand requires its own logo assets, add them under a brand sub-folder:

```
public/brand/<network-kebab>/<brand-slug>/
  logo.png
  logo-light.png
  logo-with-strapline.png
  logo-with-strapline-light.png
  logo-on-brand.png
  favicon.png            # if the brand has a PNG favicon
```

The runtime helper `brandLogoUrl(networkId, variant, brandSlug)` resolves to
the brand path first and falls back to the network path via `<img onError>` if
the brand asset is absent. This means you only need to add the variants that
differ from the network defaults.

### Current brands

| Network | Brand slug | Logo folder |
|---------|------------|-------------|
| `blue_dot` | `upsdm` | `public/brand/blue-dot/upsdm/` |
| `blue_dot` | `up-gzb` | `public/brand/blue-dot/up-gzb/` |
| `blue_dot` | `ka-dhwd` | `public/brand/blue-dot/ka-dhwd/` |
| `orange_dot` | `onetac` | `public/brand/orange-dot/onetac/` |
| `purple_dot` | `alimco` | `public/brand/purple-dot/alimco/` |

The base `blue_dot` / `orange_dot` folders are the standard (brand-agnostic)
defaults for each network.

`alimco` is the ALIMCO rollout on `purple_dot`. Every variant is currently a
byte-identical copy of the base `purple-dot/` artwork — a placeholder until the
real ALIMCO marks are supplied, at which point files are replaced in place. The
copies are strictly redundant (`brandLogoUrl` already falls back to the network
path when a brand asset is absent); they exist so the folder is self-contained
and each variant can be swapped one at a time as artwork arrives.

alimco has **no `brand.json` under `examples/schemas/`**, so it deliberately
carries no `__BRAND_REGISTRY__` entry and no
`[data-network=purple_dot][data-brand=alimco]` CSS block: it inherits
purple_dot's palette, `faviconType`, `logoShape` and copy. Add one there if
alimco ever needs its own colours, favicon or title.

`up-gzb` and `ka-dhwd` carry the **refreshed Blue Dots lockup** (uppercase
wordmark, solid dot, "Seeded by EkStep") supplied for the Ghaziabad and Dharwad
rollouts, while the base `blue-dot/` folder keeps the current lockup every other
deployment renders. The two brands ship the same artwork and the same
`brand.json` today; they are separate folders so either can diverge without
touching the other. Only the strapline lockup was supplied, so every variant
here is that single artwork — see the note under Variant set.

## Variant set

| File | Variant key | Use | Background |
|------|-------------|-----|------------|
| `logo.png` | `default` | Primary colour logo (header, sidebar) | light |
| `logo-light.png` | `light` | Light/white version | **dark** theme & dark hero |
| `logo-with-strapline.png` | `withStrapline` | Adds the "Seeded by …" strapline (auth / hero / footer) | light |
| `logo-with-strapline-light.png` | `withStraplineLight` | Strapline version | dark |
| `logo-on-brand.png` | `onBrand` | Tuned for the brand-colour hero background | brand colour |

- **`logo.png` and `logo-light.png` are required** — the app has light/dark
  themes and auto-selects the light variant on dark backgrounds.
- `up-gzb` / `ka-dhwd` ship the same strapline lockup for every variant: the designer
  supplied only the with-strapline artwork (dark + light), and nothing in the
  UI requests `withStrapline`/`onBrand` today — `portal-header.tsx` asks for
  `default`/`light` only. Swap in a trimmed wordmark for `logo.png` if a
  no-strapline version is ever supplied.
- The others are recommended; omit `onBrand` if `logo.png` already reads well
  on the hero background.

## Format

- **PNG, 32-bit RGBA, transparent background.** Transparency is required —
  logos render on white sidebars, dark headers, and coloured hero backgrounds.
- **SVG is not currently supported** (the loader resolves to `.png`). Ship PNG.
- Optimise/compress: keep each file **< ~150 KB**.

## Dimensions & aspect ratio

Logos render by **height** (`object-contain`, width auto, capped by a
max-width), so the aspect ratio is preserved — keep transparent padding
**trimmed tight** (internal whitespace makes the mark look small).

| Mark shape | Aspect | Recommended source size |
|------------|--------|-------------------------|
| Horizontal wordmark / lockup (e.g. blue, purple) | ~5 : 1 | ~900–1200 px wide (≈180–240 px tall); strapline variants ~900×240–290 |
| Compact / square mark (e.g. orange) | ~1.78 : 1 or 1 : 1 | ~512 px on the long edge |

Rendered display heights for context (provide **2–3× for retina**, i.e.
≥ ~180–240 px tall):
- Wordmark: ~28 px (sidebar) → ~48 px (auth/hero)
- Square mark: ~48 px → ~80 px

## Favicon

The favicon type — SVG auto-generated or real PNG — is controlled by the
`faviconType` field in `brand.json` (see Brand config below):

- `"faviconType": "svg"` — the theme-provider generates a colour-matched
  dot-mark from the `--brand-cta` CSS token. No `favicon.png` needed. Suitable
  for wide wordmark networks.
- `"faviconType": "png"` — the theme-provider loads `favicon.png` from the
  brand's logo folder. The file must be a **square PNG, ≥ 180×180** (180 = Apple
  touch icon; ideally also 512×512). Suitable for square/compact marks.

The `faviconType` for the active network (or brand) is declared in its
`brand.json` and fed into `__BRAND_REGISTRY__` at build time; no manual
per-network list needs to be maintained in code.

## Brand config (`brand.json`)

Each network and brand may have a `brand.json` config file at:

```
examples/schemas/<network>/brand.json          # network-level defaults
examples/schemas/<network>/<brand>/brand.json  # per-brand override (delta only)
```

### Override-only model

Per-brand `brand.json` files declare **only the fields that differ** from the
network base. Anything not specified inherits from the network defaults via CSS
cascade — the `:root[data-network][data-brand]` rule wins over
`:root[data-network]` without you specifying every token.

### CSS theme tokens

Token overrides **must** go in a `theme:` block. The Vite CSS plugin is
override-only and only honours `theme:`, not `colours:`. A brand that needs
colour token overrides must include a `theme:` block, for example:

```json
{
  "logoShape": "square",
  "faviconType": "png",
  "copy": { "title": "My Brand" },
  "theme": {
    "primary":           "#004080",
    "primaryForeground": "#ffffff",
    "cta":               "#004080",
    "ctaForeground":     "#ffffff"
  }
}
```

Note: the `colours:` block (palette metadata) is NOT read by the CSS plugin at
runtime. Only `theme:` keys are injected as CSS custom properties.

### Non-CSS brand fields

A minimal brand that only needs a custom name, logo shape, and favicon type —
but inherits the network's colour palette unchanged — omits the `theme:` block
entirely:

```json
{
  "logoShape": "square",
  "faviconType": "png",
  "copy": { "title": "UPSDM" }
}
```

These non-CSS fields are read by `resolveBrandMeta()` independently of the CSS
plugin; no `theme:` block is required when colour overrides are not needed.

| Field | Type | Effect |
|-------|------|--------|
| `logoShape` | `'square'` \| `'wordmark'` | Controls header sizing for the logo mark |
| `faviconType` | `'png'` \| `'svg'` | Whether to load `favicon.png` or auto-generate an SVG dot-mark |
| `copy.title` | `string` | Browser tab title / app name |
| `copy.tagline` | `string` | Hero tagline (optional) |

These fields are read by `resolveBrandMeta()` and fed into `__BRAND_REGISTRY__`
at build time. The `logo:` block inside `brand.json` is **not** read at runtime
for logo resolution — use the folder convention above instead. Note that some
existing brand configs (e.g. `orange_dot/onetac/brand.json`) still contain a
legacy `logo:` block inherited from earlier configs — it is silently ignored;
logos always resolve via the `<network-kebab>/<brand-slug>/` folder convention.

## How to add a new brand

1. **Create the brand config:**
   ```
   examples/schemas/<network>/<brand-slug>/brand.json
   ```
   Declare only the delta fields. Minimum viable brand with a custom name and
   PNG favicon:
   ```json
   {
     "logoShape": "square",
     "faviconType": "png",
     "copy": { "title": "My Brand Name" }
   }
   ```

2. **Add logo assets** (only the variants that differ from the network):
   ```
   apps/ui/public/brand/<network-kebab>/<brand-slug>/
     logo.png
     logo-light.png
     favicon.png          # if faviconType = "png"
   ```
   Missing variants fall back to the network's base folder automatically.

3. **Deploy:**
   Set `VITE_NETWORK_NAME=<network>` and `VITE_BRAND_NAME=<brand-slug>` in
   Helm values so they appear in `/config.js` (`window.__DPG_UI_CONFIG__`).
   Omit `VITE_BRAND_NAME` (or set to `standard`) for the brand-agnostic
   network deployment.

4. **Verify locally** (optional):
   ```
   VITE_NETWORK_ID=<network> VITE_DEFAULT_BRAND=<brand-slug> pnpm dev:ui
   ```
   Or use `?brand=<brand-slug>` in the browser query string.

## Source of truth

Designer assets are authored in **aggregator-dpg's `brand.json` logo set** and
copied verbatim into this folder. Add/update them there first, then sync here
so the two stay aligned.
