import type { RJSFSchema } from '@rjsf/utils';
import type { LucideIcon } from 'lucide-react';
import type { GoLiveGate } from '@dpg/schemas';

// ─── Schema Types ───────────────────────────────────────────────

export interface DotProfileSchema {
  info: string;
  name: string;
  version: string;
  details: {
    dot: string;
    domain: string;
  };
  schema_type: 'profile';
  schema: RJSFSchema;
}

export interface DotActionSchema {
  action_type: string;
  from_domain: string;
  to_domain: string;
  requirement_schema: RJSFSchema;
  event_schema?: RJSFSchema;
  reveals_pii_on_status?: string[];
}

// ─── Status Rules ──────────────────────────────────────────────

/**
 * A single status rule from the network config. The `when` field is either a
 * predicate object (evaluated by the server) or the literal string "default"
 * (always-match fallback, must be last in the array).
 */
export interface StatusRule {
  status: string;
  /** Human-readable label for display. Falls back to `status` when absent. */
  label?: string;
  /** Optional longer description for tooltips / filter panel copy. */
  description?: string;
  /**
   * Predicate evaluated by the server. The client receives this opaquely; it
   * is used only to enumerate the distinct status values for the filter panel.
   */
  when: Record<string, unknown> | 'default';
}

/**
 * Per-domain card display config (network.json `card` block). Controls which
 * fields a card shows by default and which become "view more" rows, plus the
 * heading / avatar source. All fields optional — the UI falls back to a
 * best-guess when a domain has no `card` block.
 */
export interface DotCardConfig {
  /** Field key whose value is the card heading. */
  title_field?: string;
  /** Optional field key rendered as a secondary line under the title. */
  subtitle_field?: string;
  /** Field key used to derive avatar initials (defaults to title_field). */
  avatar_from?: string;
  /** Ordered field keys shown collapsed; everything else moves behind "view more". */
  default_fields?: string[];
  /**
   * Ordered field keys revealed behind "view more". When provided, ONLY these
   * (in this order) are shown as extra rows and any other schema field is
   * omitted from the card entirely. When omitted, all remaining non-empty
   * schema fields are shown (in schema order) — the previous behaviour.
   */
  extra_fields?: string[];
}

export interface DotNetworkDomain {
  id: string;
  description: string;
  /**
   * Optional display label (network.json). When present the UI shows this
   * instead of title-casing the domain id — e.g. id `provider` shown as
   * "Service Provider". Falls back to the title-cased id when unset.
   */
  label?: string;
  /**
   * Optional per-domain override for the sidebar "My Profile(s)" group heading
   * (e.g. "My Jobs" for a provider). Network-authored in network.json; falls
   * back to the generic label when unset.
   */
  my_items_label?: string;
  default_item_schemas?: {
    profile: RJSFSchema;
  };
  item_schemas?: Record<string, RJSFSchema>;
  /**
   * Lifecycle status rules for items in this domain. Defined in network.json
   * per-domain. The client uses these to enumerate filter options and to
   * derive a best-effort status for each item client-side (see item-status.ts).
   */
  status_rules?: StatusRule[];
  /** Card display config — see {@link DotCardConfig}. */
  card?: DotCardConfig;
  /**
   * U18 guardian consent (Phase 6): when true, a minor holding a profile in
   * this domain is routed through the guardian consent flow instead of the
   * ordinary adult consent gate. Mirrors `guardian_consent_required` in
   * network.json (see apps/api/src/services/minor.ts on the server side).
   */
  guardian_consent_required?: boolean;
  /**
   * Go-live gate tokens for this domain (mirrors `go_live_required` in
   * network.json). When present and it does NOT include `consent_required`,
   * the UI skips the Terms/Privacy consent gate at signup for this domain —
   * the profile goes live on completeness alone. Absent ⇒ treat as requiring
   * consent (safe default).
   */
  // Imported rather than re-declared: the vocabulary is owned by
  // PROFILE_GO_LIVE_GATES in @dpg/schemas, so a new token cannot silently
  // leave this union behind (it already had — `owner_required`, #640).
  go_live_required?: GoLiveGate[];
  /**
   * Optional per-domain "why complete your profile" prompt shown at the top of
   * the create/edit page (#376), to motivate a first-time user to finish. The
   * message is role-specific (a seeker's "why" ≠ a provider's), so it's authored
   * per domain in network.json; when unset, a generic i18n fallback is used.
   * Presentational only — not part of item validation.
   */
  profile_completion_prompt?: {
    heading: string;
    body: string;
  };
}

export interface DotNetworkInteraction {
  from_network?: string;
  from_domain: string;
  from_items?: string[];
  to_network?: string;
  to_domain: string;
  to_items?: string[];
  requirement_schema: RJSFSchema;
  event_schema?: RJSFSchema;
  reveals_pii_on_status?: string[];
}

export interface DotNetworkInstance {
  domain_id: string;
  instance_name?: string;
  instance_url: string;
  custom_item_schema_urls?: Record<string, string>;
}

export interface DotNetworkAction {
  description: string;
  interactions: DotNetworkInteraction[];
}

export interface DotNetworkSchema {
  id: string;
  display_name: string;
  description: string;
  schema_standard: string;
  /**
   * Network-wide toggle for the pause (voluntarily-hide) feature. When false,
   * the UI hides the "Pause profile" control. Absent ⇒ enabled (default). (#346)
   */
  pause_enabled?: boolean;
  domains: DotNetworkDomain[];
  instances?: DotNetworkInstance[];
  actions: Record<string, DotNetworkAction>;
}

// ─── Schema Input Types ────────────────────────────────────────

export type SchemaInput =
  | RJSFSchema
  | DotProfileSchema
  | DotNetworkSchema
  | DotActionSchema
  | string
  | { url: string }
  | { api: string; baseUrl?: string };

// ─── Card Types ────────────────────────────────────────────────

export interface CardField {
  key: string;
  label: string;
  value: unknown;
  type: string;
  format?: string;
}

export interface ActionButton {
  type: string;
  label: string;
  actionSchema: DotActionSchema;
}

// ─── Map Types ─────────────────────────────────────────────────

export type MapMarkerPrecision = 'exact' | 'geocoded_full_address';

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  label: string;
  data: Record<string, unknown>;
  precision: MapMarkerPrecision;
  geocodedFrom?: string;
  /** The item's domain string (e.g. "seeker", "provider"). Used to pick the marker icon. */
  domain?: string;
}

export interface MapProviderProps {
  center: [number, number];
  zoom: number;
  markers: MapMarker[];
  onMarkerClick?: (id: string) => void;
  /** When true, the provider should NOT auto-fit bounds on first render */
  initialViewSet?: boolean;
  /**
   * Monotonic counter bumped by the caller on an explicit "recenter" intent
   * (e.g. the user picks a location source). The provider recenters on `center`
   * even when the coordinate is unchanged — so re-selecting the same anchor
   * after the user has panned still snaps back. Ignored when `initialViewSet`
   * is false.
   */
  focusNonce?: number;
  /**
   * Monotonic counter bumped by the caller to close any currently open marker
   * popup (e.g. right before a Connect/Apply action opens a modal) — the
   * marker popup renders in a high stacking context (a map overlay), so on
   * mobile it would otherwise sit on top of a bottom-sheet modal. Mirrors
   * `focusNonce`'s "bump signals intent" pattern, but the effect is closing
   * the popup rather than recentering the map.
   */
  closePopupNonce?: number;
  /**
   * The user's own resolved location (profile OR browser geolocation — see
   * `useUserLocation`). When set, the provider renders a single distinct
   * "You are here" self-marker at this point, separate from the item pins and
   * never clustered/clickable. Null/undefined → no self-marker (e.g. no profile
   * location AND browser geolocation is denied/blocked).
   */
  selfLocation?: { lat: number; lng: number } | null;
  children?: React.ReactNode;
  /** Optional custom popup renderer; falls back to the default MarkerPopupCard. */
  renderPopup?: (marker: MapMarker) => React.ReactNode;
  /**
   * Optional per-marker icon resolver. Defaults to a domain-based lucide icon
   * (see `getIconForDomain`). Callers can override to pick an icon from other
   * marker data (e.g. the tourist app keys on `data.category`). Signals leaves
   * this unset, so its markers are unchanged.
   */
  resolveIcon?: (marker: MapMarker) => LucideIcon;
  /**
   * Optional per-marker image resolver. When it returns a URL, the marker is
   * rendered as that image (in a white circle) instead of the lucide pin —
   * used by the tourist app to show the RubiX favicon for RubiX listings.
   * Returns null/undefined to fall back to the icon pin.
   */
  resolveMarkerImage?: (marker: MapMarker) => string | null | undefined;
  /**
   * Optional viewport-change callback. When provided, the active provider
   * emits `{lat, lng, radiusMeters}` on debounced (~300ms) `moveend`/`idle`.
   * Unset (e.g. the tourist app) → the provider attaches no listener at all,
   * so panning/zooming behaves exactly as before this prop existed.
   */
  onViewportChange?: (viewport: MapViewport) => void;
}

export interface MapProvider {
  name: string;
  component: React.ComponentType<MapProviderProps>;
}

/**
 * The map's current viewport, reported on debounced pan/zoom settle
 * (Leaflet `moveend` / Google `idle`). `radiusMeters` is the half-diagonal —
 * the great-circle distance from `center` to a corner of the current bounds —
 * a simple, provider-agnostic proxy for "how much area is visible".
 *
 * `zoom` (#203 §7) is the native map zoom level at the moment of the report.
 * Optional — additive on top of the original `{lat, lng, radiusMeters}` shape
 * so callers that construct a `MapViewport` by hand (existing tests, the
 * `useMapMarkers` bucketing logic) don't need to supply it. Both live map
 * providers always populate it when emitting to `onViewportChange`; it is
 * currently consumed only by the home-page's anonymous count-first gating.
 *
 * `minLat`/`minLng`/`maxLat`/`maxLng` (#203 map-serverside-search Task 4) are
 * the current `map.getBounds()` corners — the bbox the server-side markers
 * query filters by, replacing the client-computed radius for the map path.
 * Optional for the same reason `zoom` is: both live providers always
 * populate them alongside `zoom` on every emit going forward, but the list's
 * distance path, the tourist app (never emits at all), and hand-built
 * viewports in existing tests only ever have center + radius. Callers that
 * need the bbox (`useMapMarkers`, the markers query key) fall back to the
 * radius shape when these are unset.
 */
export interface MapViewport {
  lat: number;
  lng: number;
  radiusMeters: number;
  zoom?: number;
  minLat?: number;
  minLng?: number;
  maxLat?: number;
  maxLng?: number;
}

// ─── Plugin Types ──────────────────────────────────────────────

export interface RendererPlugin {
  name: string;
  components: Map<string, React.ComponentType<Record<string, unknown>>>;
}

// ─── View Mode ─────────────────────────────────────────────────

export type ViewMode = 'list' | 'map';

// ─── Filter State ──────────────────────────────────────────────

export interface FilterState {
  search: string;
  selectedDomain: string | null;
  viewMode: ViewMode;
  /**
   * Active status filter values (e.g. ["new", "active"]). An empty array means
   * "show all" (no status filter applied).
   */
  selectedStatuses: string[];
  /**
   * Active domain filter values for the map filters panel (multi-select,
   * separate from the sidebar's single-domain tab selector).
   * An empty array means "show all domains".
   */
  selectedDomains: string[];
}
