/**
 * Zoom-band marker caps (#203 map-serverside-search Task 6). Two per-zoom-band
 * caps replace the earlier flat `MAP_FETCH_LIMIT` cutoff on the bbox (live
 * map) path: a higher cap while clustering absorbs density (zoom below the
 * cluster-disable zoom) and a lower cap once clustering turns off and every
 * pin renders individually (zoom at/above it) — a cluster icon can represent
 * a cell far denser than an individual pin count would tolerate on screen.
 *
 * `capForZoom` is the SINGLE source of truth for both halves of the contract:
 * `useMapMarkers` uses it to compute the fetch `limit` (bbox path) AND the
 * "was this truncated?" check (`meta.total > cap`) — the same call, so the
 * two can never disagree. The over-dense "N+ in this area — zoom in"
 * indicator (`MapCountPill`) reads the hook's resulting `truncated` flag
 * rather than calling this directly.
 *
 * All three knobs are env-configurable via runtime-env (`getRuntimeEnv`, read
 * from `window.__DPG_UI_CONFIG__` written into `/config.js` at deploy time, so
 * one built image is retunable per deployment WITHOUT a rebuild — `config.js`
 * loads before the app bundle, so a module-load read here sees it):
 *   - `VITE_MAP_MARKER_CAP_CLUSTERED` (default 1000)
 *   - `VITE_MAP_MARKER_CAP_INDIVIDUAL` (default 500)
 *   - `VITE_MAP_CLUSTER_DISABLE_ZOOM` (default 14, mirrors
 *     `DEFAULT_CLUSTER_DISABLE_ZOOM` in `map-viewport-snap.ts`, which still
 *     owns the *cache-key* zoom band and stays env-unaware/pure)
 *
 * Mobile note (mobile spec F1): the individual cap being env-overridable to a
 * lower value for a mobile build is enough for now — no device detection
 * lives here.
 */
import { zoomBand, DEFAULT_CLUSTER_DISABLE_ZOOM } from './map-viewport-snap';
import { getRuntimeEnv } from './runtime-env';

const DEFAULT_CLUSTERED_MARKER_CAP = 1000;
const DEFAULT_INDIVIDUAL_MARKER_CAP = 500;

function readPositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/** Reads `VITE_MAP_MARKER_CAP_CLUSTERED`, falling back to 1000. Exported for tests. */
export function resolveClusteredMarkerCap(): number {
  return readPositiveIntEnv(getRuntimeEnv('VITE_MAP_MARKER_CAP_CLUSTERED'), DEFAULT_CLUSTERED_MARKER_CAP);
}

/** Reads `VITE_MAP_MARKER_CAP_INDIVIDUAL`, falling back to 500. Exported for tests. */
export function resolveIndividualMarkerCap(): number {
  return readPositiveIntEnv(getRuntimeEnv('VITE_MAP_MARKER_CAP_INDIVIDUAL'), DEFAULT_INDIVIDUAL_MARKER_CAP);
}

/**
 * Reads `VITE_MAP_CLUSTER_DISABLE_ZOOM`, falling back to
 * `DEFAULT_CLUSTER_DISABLE_ZOOM` (14). Exported for tests.
 */
export function resolveClusterDisableZoomEnv(): number {
  return readPositiveIntEnv(getRuntimeEnv('VITE_MAP_CLUSTER_DISABLE_ZOOM'), DEFAULT_CLUSTER_DISABLE_ZOOM);
}

// Resolved once at module load (mirrors the `MAP_FETCH_LIMIT` /
// `PROFILE_FETCH_LIMIT` pattern in `network-api.ts`) — a build's env doesn't
// change at runtime, so re-reading on every call would be pure overhead.
export const CLUSTERED_MARKER_CAP = resolveClusteredMarkerCap();
export const INDIVIDUAL_MARKER_CAP = resolveIndividualMarkerCap();
export const CLUSTER_DISABLE_ZOOM = resolveClusterDisableZoomEnv();

export interface CapForZoomOptions {
  clusterDisableZoom?: number;
  clusteredCap?: number;
  individualCap?: number;
}

/**
 * The active marker cap for a given zoom level: `individualCap` at/above the
 * cluster-disable zoom, `clusteredCap` below it. Pure function — defaults to
 * the env-resolved module constants above, but every knob is overridable per
 * call so callers (and tests) never need to re-import the module to exercise
 * a different threshold/cap.
 */
/**
 * The zoom at or beyond which "Search this area" is offered (#644 QA).
 *
 * Two conditions must hold, not one. The button is only useful when the
 * viewport is a *meaningful* area AND the map still cannot show everything in
 * it: at low zoom the honest advice is "zoom in" (which the count pill already
 * gives, and which fixes the problem on its own), so offering a jump to the
 * list there would be answering a question the user has not reached yet. At
 * high zoom with the set still truncated there is no further zoom to escape
 * to — that is the case #644 calls the dense-cell problem, and the list is the
 * escape hatch.
 */
export const SEARCH_AREA_MIN_ZOOM = 10;

export function capForZoom(zoom: number, options?: CapForZoomOptions): number {
  const clusterDisableZoom = options?.clusterDisableZoom ?? CLUSTER_DISABLE_ZOOM;
  const clusteredCap = options?.clusteredCap ?? CLUSTERED_MARKER_CAP;
  const individualCap = options?.individualCap ?? INDIVIDUAL_MARKER_CAP;
  return zoomBand(zoom, clusterDisableZoom) === 'individual' ? individualCap : clusteredCap;
}
