# Browser-QA findings — #644 / #645 / #646 epic (2026-09-04)

Reported by the user against the local stack on branch
`feat/644-list-view-sort-filters` (PR #665). Numbered for tracking; "root"
records the cause where it was traced before implementation began.

## Domain control

**Q1 — Collapse the domain control when only one domain is selectable.**
A signed-in seeker in a network whose interaction matrix has no seeker→seeker
edge still sees a `Seeker` button (disabled) beside `Provider`. When exactly
one domain is selectable, render no control at all — just state the domain
("Showing Providers"). Applies to list **and** map. Images 26, 27.

**Q7 — Facet groups do not follow the selected domain.** The Filters panel
appears to show the same field set whichever domain is picked; it should show
seeker fields for Seeker and provider fields for Provider. Needs empirical
confirmation per view — `filterFieldDomains` (home-page.tsx:946) keys off
`selectedDomain`, but on the **map** the toolbar writes `mapSelectedDomains`
via `handleMapDomainsChange` and never touches `selectedDomain`, so the panel
can be scoped to a stale domain there. Images 29, 31.

## Sort

**Q2 — Sort dropdown checkmark disagrees with the trigger.** The menu shows
"Relevance to your profile" ticked while the trigger reads "Newest". Cause is
correct-but-unexplained: signals-search is down locally, the server degrades
relevance → newest and reports it in `meta.sort_applied`; `SortSelect` labels
the trigger from `applied` but still marks `value` as checked. When relevance
is genuinely unavailable, drop the option from the menu entirely rather than
offer an order the server will not honour. Image 27.

**Q3 — "Newest" must name its basis.** Nothing tells the user the "6 days ago"
age comes from `items.created_at`. Label/help text should say so.

**Q11 — `nearest` does not reorder.** Reproduced logged in and logged out.
With "My profile" as the centre the order is unchanged from newest (image 37);
with "Current location" it *does* change (image 38). Suggests the ordering
centre is absent for the profile source while `nearestAvailable` still enables
the option — `BrowseToolbar` gates on `browseCoords`, the request builder gates
on `userLocation` (use-infinite-browse-items.ts:145). Needs network-tab
confirmation of whether `ordering_latitude/longitude` are on the wire.
Images 36, 37, 38.

## Applied-filter chips

**Q5 — Chips print raw schema keys.** `workExperience`,
`workExperienceYearsConditional`, `natureOfJobsInterestedIn`,
`collegeQualification`, `candidateExperienceType` … The Filters panel already
resolves proper titles ("Work Experience", "Years of Work Experience"), so the
chip bar must reuse the same label source. Images 29, 30.

**Q8 — Clear-all does not persist.** Apply a facet → Clear all (clears) →
reload → the facet is back. Root: `useAppliedFilterChips` is wired with
`setFieldFilters: setMapSelectedFields` (home-page.tsx:1466) — the raw state
setter, not `handleMapFieldsChange`, which is what strips the `?f_*` query
params. State clears, URL does not, and the URL re-seeds on reload. Chip
removal has the same defect. Images 33, 34, 35.

**Q9 — Filter count includes the domain.** One facet chip shows a badge of 2.
Root: `activeCount = selectedDomains.length + enumActiveCount`
(browse-filters-panel.tsx:160). Domain is no longer a panel facet, so it must
not be counted. Image 35.

## Filtering correctness

**Q6 — Applied facets do not match returned items.** Map with
`gender: Don't want to share` + `workExperienceYearsConditional: 15+ Years` +
`workExperience: Returning after a break` returns a provider card whose
Work Experience (Years) is "1 Year" (image 31). A `candidateExperienceType:
Returning after a break` filter returns a seeker whose Work Experience is
"Fresher" (image 32). Note both cases mix seeker-schema and provider-schema
field keys across a multi-domain selection, which is likely entangled with Q7.

## Layout

**Q10 — Sidebar/toolbar divider mismatch may persist.** Fixed at
`components/ui/sidebar.tsx` (commit b3fbab4f) and verified logged out
(separator 8→247px inside a 256px sidebar). User's screenshots may predate the
commit, and the logged-in state (a profile in the sidebar) was not re-measured.
Re-verify logged in.

## Open questions answered separately

- Q4 — provenance of the Area radius ladder (5/10/25/50 km).
- Q12 — whether facets apply on the map given `/markers` returns coordinates.

---

# Second QA round (2026-09-04)

**N1 — Area made no sense on the map. FIXED.** It was also inert:
`useMapMarkers` is called with the viewport, never with `area`, so the control
changed nothing there. Removed from map view, same as Sort (spec D26).

**N2 — dense-cell-at-max-zoom.** See the answer recorded below; the escape
hatch is "switch to the list", which #644 made unbounded. The map itself still
cannot plot more than its cap, and the `viewport` area mode that would have
made "the area I'm looking at" one click was deliberately skipped.

**N3 — empty-sidebar divider alignment. FIXED.** The group now stretches to
`--dpg-toolbar-h` (measured by PageShell) and owns its own bottom border, so
the two rules form one line at y=150. Empty state only, per the user.

**N4 — map viewport resets but the count does not. FIXED (see round 4 below).**
Diagnosis: `focusPoint={userLocation}` makes `MapView` compute
`initialViewSet: true`, which mounts `SetView`; on remount `SetView`'s
`prevCenter` ref is null, so it unconditionally `map.setView(focusPoint,
PROFILE_ZOOM)`. That snap races `ViewportReporter`'s mount emit, and the
post-snap `moveend` emit is debounced — so `mapViewport` (which the count is
derived from) can keep the pre-switch bounds while the map displays the
snapped view.
Corroborating evidence: the mismatch requires a resolved `userLocation`. With
geolocation denied there is no `focusPoint`, no `SetView`, no snap — and the
count stayed consistent across three list<->map switches in that state.
Fix options: (a) persist center/zoom across the switch — needs `SetView` to
take the initial view and the nonce-snap target as separate inputs, since
today one center/zoom serves both; (b) reset `mapViewport` on leaving the map
so the reporter re-derives it. (a) is the better UX and removes the whole
mismatch class.

**N5 — the two map counts. FIXED (see round 4 below).** The toolbar count on the map is
`mapMarkers.total`: viewport-scoped AND multi-domain (measured 94 = 22
provider + 72 seeker), while the list's is single-domain and network-wide
(22). Proposal: keep the on-map pill as the viewport count, and make the
toolbar count filter-scoped and location-independent so it matches the list —
plus an explicit "N with location, M without" so the map/list gap is stated
rather than inferred. Needs one extra count request (`/discover` with
`limit: 1` gives the filter-scoped total; markers without a bbox gives
"has a location").

**N6 — "Showing N of M" removed from the list. FIXED.**

---

# Third QA round (P-series)

**P1 — a date/distance pill opened "Match Score Details". FIXED.**
`MatchScoreButton` passed `onViewDetails` for every metric kind. The handler
is now relevance-only, and `MatchScoreBadge` renders a `<span>` instead of a
`<button>` when it has nothing to open — so a non-relevance pill is neither
focusable nor labelled "Tap for details".

**P2 — "Showing Provider" → "Showing Providers". FIXED.** New
`pluralizeDomainLabel` prefers a `plural_label` on the domain (English rules
are not safe for a schema-driven label) and falls back to -s/-ies, no-op for
an already-plural label.

**P3 — the page-header domain title. REMOVED.** Duplicated the toolbar, and
was wrong on the map: it named one domain while several could be selected
(Seeker + Provider read "Seeker"). `ContentHeader.title` is optional now;
`resolveHeaderDomain` / `resolveHeaderDescription` deleted.

**P4 — dead-code audit. DONE.** `tsc --noUnusedLocals` is the tool here (no
eslint in this repo) and is clean; it is what surfaced the orphaned header
vars. Five i18n keys orphaned by this epic removed from all three locales
(`match.confidence`, `match.factors_heading`, `match.ai_reasoning_heading`,
`filters.domain_group`, `home.browse_all`) — verified against the merge-base
that each had exactly one caller before this epic. `home.map_count_first` was
already orphaned at the base, so left alone. Remaining unused exports are all
component prop-type interfaces, which is this codebase's convention (several
are consumed by tests or re-exported from `index.ts`) — left as-is rather than
churned.

**P5 — no distance pill under `nearest`. FIXED.** Per-item `distanceMeters`
exists in the discover item schema but only the signals-search path fills it;
the native fallback orders by distance while projecting no distance column.
Backfilled client-side from `item_locations` + the ordering centre. Also
exposed that the home-page browse mock never returned `sortApplied`, so the
metric pill had no test coverage at all — now threaded through.

---

# GATE before marking PR #665 ready

**Mobile-view QA of everything this PR introduces.** Explicitly requested, and
not yet done — all QA so far has been desktop-width. Cover at minimum:

- the browse toolbar's single row (sort / area / chips / clear-all / count +
  "N not on the map") — it wraps, so check it does not eat the viewport
- the domain control: 3 domains on a phone (up-gzb has three), the horizontal
  scroll rather than wrap, and the collapsed "Showing <Domains>" heading
- the browse-context row: domain heading left, "Search near" + Select right,
  at a width where they must wrap onto two lines
- the Area control's custom-radius input, tick and clear, with a numeric
  keyboard; `pointer-coarse:min-h-11` touch targets on every new control
- the card metric pill (span vs button) and the filters panel as a bottom
  sheet (`ResponsiveDialog` → Drawer on mobile)
- the map: count pill, cluster badges, and the error-boundary fallback box

---

# Fourth round — resolutions, and what is genuinely still open

**N2 — dense-map escape hatch. FIXED, cross-repo.** signals-search added a
`bbox` spatial op (#152, `8189c68`), which removed the reason spec D6 dropped
`area: 'viewport'`. Contract §1.5 records the wire shape; DPG has the schema,
the client clause, the native-path bbox, the UI mode, and a "Search this area"
button on the map. The "approximate" caveat #644 asked for is gone with the
approximation.

**N4 — FIXED.** `shouldRefetch` reuses a cached result when the new bbox is
contained in the previous padded one, which is right for markers but left
`meta.total` describing the larger fetched area. The count is now derived from
the markers inside the bbox actually on screen, guarded by a coverage check so
a not-yet-refetched zoom-out keeps the server total instead of under-reporting.

**N5 — FIXED.** The filter bar shows the FILTER total in both views (so it
matches the list), the on-map pill owns the VIEWPORT count, and the shortfall
is stated as "· N not on the map". Measuring "mappable" required a global
bbox, not a bbox-less call — the latter counts every match regardless of
coordinates, so the difference was always zero.

## Still open

1. **Mobile-view QA — the PR-ready gate above. NOT DONE.** All QA has been
   desktop-width.
2. **signals-search path never exercised end to end locally.** Every e2e check
   has run against the NATIVE fallback, because no signals-search is running
   here. Covered instead by request-builder tests (what DPG sends), the other
   repo's SQL tests (what it does), the §9 cross-repo fixture, and a
   signals-search/native parity suite — but no single local test runs both
   processes together. Closable by bringing up the worker with a stub embedder.
3. **Bug found, not filed: a `±90/±180` bbox returns 0 rows.** Measured:
   `±80/±170` → 72, `±90/±180` → 0. Worked around by insetting the global box
   in `useBrowseTotals`; the underlying predicate is still wrong at the exact
   global envelope.
4. **Bug found, not filed: the geo read-model lags.** On blue_dot, 4 items
   have coordinates but no `item_search` row, so they can never appear as pins
   and land in the "not on the map" count alongside genuinely location-less
   items. Related to the known lifecycle/index race.
5. **#404 still needs its "remove the standalone filter facet panel" checkbox
   dropped** before it is planned — #645 re-scoped it, and the panel is now
   load-bearing (it is the facet editor the chip bar reads out).
6. **Keyset paging** remains a follow-up: LIMIT/OFFSET is correct now that
   every ORDER BY has an `item_id` tiebreaker, but it still scans.
7. **Merge order:** signals-search #152 must land before the Signals-DPG half.
