import axios from 'axios';
import { createApiClient } from './api-client';
import { unwrapBulkSingle, postBulkEnvelope, type BulkEnvelope } from './bulk';

// ─── Contact-details types ────────────────────────────────────────

export type ContactDetailsErrorCode =
  | 'UNAUTHORIZED'
  | 'ACTION_NOT_FOUND'
  | 'NOT_ACTION_PARTICIPANT'
  | 'PII_NOT_REVEALED'
  | 'CROSS_INSTANCE_REVEAL_NOT_SUPPORTED'
  | 'OTHER_ITEM_NOT_FOUND'
  | 'INTERNAL_SERVER_ERROR';

export interface ContactDetailsErrorBody {
  error: ContactDetailsErrorCode;
  message: string;
}

export interface ContactDetailsOtherActorItem {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_instance_url: string | null;
  item_schema_url: string | null;
  item_state: Record<string, unknown>;
  item_locations: Array<{ lat: number; lng: number; label?: string }>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ContactDetailsResponse {
  action_id: string;
  action_status: string;
  /** false → `item` is the masked pre-reveal view (a party is not live/paused). */
  revealed: boolean;
  /** When not revealed: `self` = viewer's own profile not live; `other` = counterparty's. */
  reveal_blocked_reason?: 'self' | 'other' | 'retired';
  other_actor: {
    item: ContactDetailsOtherActorItem;
  };
}

/** Error thrown by getActionContactDetails on non-2xx responses */
export interface ContactDetailsError extends Error {
  status: number;
  code: ContactDetailsErrorCode;
}

const apiClient = createApiClient();

/**
 * Which client an action goes out on — always the same-origin one.
 *
 * `sourceInstanceUrl` used to build a client pointed at the source item's
 * recorded `item_instance_url`. That worked while the session was a bearer
 * token, which could be attached to any host. The session is a cookie now
 * (AUTH-VULN-03/04), and a cookie is scoped to the origin that set it — so a
 * request to any other host simply carries no session and comes back
 * `401 UNAUTHORIZED`. That is not a thing a header can fix: it is what
 * same-origin means.
 *
 * It is also the correct target regardless. `POST /action/perform` requires the
 * SOURCE item to be local — it runs `isServedDomainBinding` on the source and
 * then `fetchLocalItemSnapshot` — and an instance serves every domain of its
 * network (per-domain deploys split only the UI, so the seeker and provider
 * portals are two hostnames in front of one API). The recorded
 * `item_instance_url` is that same API under its canonical hostname, which is
 * precisely the host the browser has no cookie for.
 *
 * Cross-instance is still handled, just not from here: the local API forwards
 * to the TARGET's instance over the HMAC-signed peer route
 * (`network/action/perform`). The browser was never the right place for that
 * hop, because it holds no peer credential.
 */
function actionClient() {
  return apiClient;
}

// ─── Types ───────────────────────────────────────────────────────

export interface ItemRef {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_id: string;
}

export interface TargetItemRef extends ItemRef {
  item_instance_url: string;
}

/**
 * Sentinel key used by ActionModal to smuggle the consent block through the
 * onSubmit(formData) signature into the parent's PerformActionPayload assembly
 * (see action-modal.tsx producer + home-page.tsx consumer).
 */
export const ACTION_CONSENT_SENTINEL = '__consent' as const;

/**
 * Payload for performing an action (initiated by source user)
 * Sent as a single object to POST /api/v1/action/perform
 * For bulk actions, use performActionsBulk which posts to /api/v1/action/perform/bulk
 */
export interface PerformActionPayload {
  action_type: string;
  source_item: ItemRef;
  target_item: TargetItemRef;
  requirements_snapshot: Record<string, unknown>;
  consent?: { acknowledged: true; version: number; brand?: string | null };
}

/**
 * Response from perform action API
 */
export interface PerformActionResponse {
  action_id: string;
  action_type: string;
  action_status: string;
  update_count: number;
  source_item_id: string;
  target_item_id: string;
}

/**
 * Payload for updating action status (target user response)
 * Matches the actual API schema: POST /api/v1/action/update-status
 */
export interface UpdateActionStatusPayload {
  action_id: string;
  action_status: string;
  remarks?: string;
  consent?: { acknowledged: true; version: number; brand?: string | null };
}

/**
 * Response from update action status API
 */
export interface UpdateActionStatusResponse {
  action_id: string;
  action_type: string;
  action_status: string;
  update_count: number;
}

/**
 * Query parameters for fetching actions
 */
export interface FetchMyActionsQuery {
  action_id?: string;
  // A single value or multiple (OR'd) values — the server's
  // FetchOwnedActionsQuerySchema accepts either and normalizes to an array
  // (#439). Widened from a single string so "My Actions" can multi-select.
  action_type?: string | string[];
  action_status?: string | string[];
  item_id?: string;
  ownership_role?: 'all' | 'initiated' | 'received';
  // #439: server-side sort key. Defaults to 'recent' server-side when omitted.
  sort?: 'recent' | 'oldest' | 'match_score' | 'distance';
  // #439: non-PII item_state facet selections (OR within a field, AND across
  // fields), applied against the counterparty item on each action — same
  // shape as the map/discover facet filter (`DiscoverFacetFilter`).
  facets?: Array<{ field: string; values: string[] }>;
  limit?: number;
  offset?: number;
}

/**
 * Action with ownership roles returned from API
 */
export interface Action {
  action_id: string;
  action_type: string;
  action_status: string;
  update_count: number;
  source_item_id: string;
  source_item_network: string;
  source_item_domain: string;
  source_item_type: string;
  source_item_owner: string | null;
  source_item_locations?: Array<{ lat: number; lng: number; label?: string }>;
  target_item_id: string;
  target_item_network: string;
  target_item_domain: string;
  target_item_type: string;
  target_item_owner: string | null;
  target_item_locations?: Array<{ lat: number; lng: number; label?: string }>;
  requirements_snapshot: Record<string, unknown>;
  // Reason attached when the action was rejected/cancelled — the actor's own
  // remark, or a system remark (e.g. when the counterparty retired, #347).
  remarks?: string | null;
  created_at: string;
  updated_at: string;
  ownership_roles: ('initiated' | 'received')[];
  // Human-readable names resolved server-side from each item's
  // display_name_field (falls back to the item id when unavailable).
  source_item_name?: string | null;
  target_item_name?: string | null;
  // #439: present when a match-score/facet/distance pipeline ran for this
  // row's page (match_score fetch or `sort=distance`/facets enrichment
  // path) — null when not computed (e.g. no location on one side for
  // distance, or the score service wasn't consulted for this row).
  match_score?: number | null;
  distance_m?: number | null;
}

/**
 * Response from fetch actions API
 */
export interface FetchMyActionsResponse {
  meta: {
    total: number;
    limit: number;
    offset: number;
  };
  actions: Action[];
}

/**
 * Action event (status history)
 */
export interface ActionEvent {
  event_id: string;
  action_type: string;
  action_id: string;
  update_count: number;
  action_status: string;
  source_item_id: string;
  source_item_network: string;
  source_item_domain: string;
  source_item_type: string;
  source_item_owner: string | null;
  source_item_locations?: Array<{ lat: number; lng: number; label?: string }>;
  target_item_id: string;
  target_item_network: string;
  target_item_domain: string;
  target_item_type: string;
  target_item_owner: string | null;
  target_item_locations?: Array<{ lat: number; lng: number; label?: string }>;
  event_payload: Record<string, unknown>;
  remarks: string | null;
  origin_instance_domain: string;
  created_at: string;
  ownership_roles: ('initiated' | 'received')[];
}

/**
 * Response from fetch action events API
 */
export interface FetchActionEventsResponse {
  meta: {
    total: number;
    limit: number;
    offset: number;
  };
  events: ActionEvent[];
}

/**
 * Query parameters for fetching action events
 */
export interface FetchActionEventsQuery {
  action_type: string;
  action_id: string;
  update_count?: number;
  limit?: number;
  offset?: number;
}

// ─── Guardian OTP (U18) ─────────────────────────────────────────────

/**
 * Machine-readable error codes the guardian-OTP challenge/response flow can
 * surface on a bulk result entry's `error` field (perform_action /
 * update_action_status), so `action-modal` can branch on them.
 */
export type GuardianOtpErrorCode =
  | 'GUARDIAN_OTP_REQUIRED'
  | 'GUARDIAN_OTP_INVALID'
  | 'GUARDIAN_OTP_THROTTLED'
  | 'GUARDIAN_OTP_RATE_LIMITED'
  | 'OTP_PROVIDER_UNAVAILABLE';

const GUARDIAN_OTP_ERROR_CODES: readonly GuardianOtpErrorCode[] = [
  'GUARDIAN_OTP_REQUIRED',
  'GUARDIAN_OTP_INVALID',
  'GUARDIAN_OTP_THROTTLED',
  'GUARDIAN_OTP_RATE_LIMITED',
  'OTP_PROVIDER_UNAVAILABLE',
];

/**
 * Classifies a bulk result entry's `error` field (e.g. from
 * `BulkEnvelope.results[i]` or a thrown `BulkSingleError`) as a
 * `GuardianOtpErrorCode`, or `null` if it isn't one of those codes (including
 * a success entry with no `error` field at all).
 */
// The profile-consent guardian OTP routes (/u18/profile-consent/*) use
// different code strings than the action routes; map them to the shared set so
// GuardianOtpDialog shows the right message (e.g. INVALID_OTP -> "Incorrect code"
// instead of a generic error).
const GUARDIAN_OTP_CODE_ALIASES: Record<string, GuardianOtpErrorCode> = {
  INVALID_OTP: 'GUARDIAN_OTP_INVALID',
  OTP_VERIFY_THROTTLED: 'GUARDIAN_OTP_THROTTLED',
  OTP_RATE_LIMITED: 'GUARDIAN_OTP_RATE_LIMITED',
  OTP_PROVIDER_UNAVAILABLE: 'OTP_PROVIDER_UNAVAILABLE',
};

export function guardianOtpErrorOf(
  entry: { error?: string } | null | undefined,
): GuardianOtpErrorCode | null {
  const code = entry?.error;
  if (code === undefined) return null;
  if ((GUARDIAN_OTP_ERROR_CODES as readonly string[]).includes(code)) {
    return code as GuardianOtpErrorCode;
  }
  return GUARDIAN_OTP_CODE_ALIASES[code] ?? null;
}

/**
 * Classifies a *thrown* error as a `GuardianOtpErrorCode`, or `null` if it
 * isn't one. Single-item calls (`performAction`/`updateActionStatus`) throw a
 * `BulkSingleError` (via `unwrapBulkSingle`) carrying the machine code on
 * `.code`; a raw axios error carries it on `response.data.error`. This lets
 * `action-modal`/`action-handler`/`action-status-updater` share one place
 * that knows how to pull the code out of a caught error regardless of shape.
 */
export function guardianOtpErrorFromThrown(err: unknown): GuardianOtpErrorCode | null {
  if (axios.isAxiosError(err)) {
    return guardianOtpErrorOf(err.response?.data as { error?: string } | undefined);
  }
  const code = (err as { code?: string } | null | undefined)?.code;
  return guardianOtpErrorOf({ error: code });
}

// ─── API Functions ────────────────────────────────────────────────

/**
 * Perform an action (initiate cross-instance action)
 * Source user calls this to start an action with a target item
 * 
 * Note: This MUST be called on the SOURCE instance (where source item exists).
 * The source instance validates the source item exists, then forwards to target.
 * 
 * @param payload - The action payload
 * @param _sourceInstanceUrl - Accepted for call-site compatibility and ignored:
 *   the action always goes to this origin, because that is the only place the
 *   browser holds a session. See `actionClient`.
 * @param guardianOtp - Optional: guardian OTP code to resubmit this same action with,
 *   after a prior call returned a `GUARDIAN_OTP_REQUIRED` per-item error. Sent as
 *   `guardian_otp` on the payload.
 */
export async function performAction(
  payload: PerformActionPayload,
  _sourceInstanceUrl?: string,
  guardianOtp?: string,
): Promise<PerformActionResponse> {
  // `sourceInstanceUrl` is retained on the signature (callers resolve and pass
  // it, and it is meaningful to them) but no longer selects a host — see
  // `actionClient`.
  const client = actionClient();

  const body = guardianOtp ? { ...payload, guardian_otp: guardianOtp } : payload;

  return unwrapBulkSingle(
    // Feature #293: single-object body to /perform. `body` carries guardian_otp
    // when resubmitting a minor's action after a GUARDIAN_OTP_REQUIRED.
    client.post<BulkEnvelope<PerformActionResponse>>('/api/v1/action/perform', body),
  );
}

/**
 * Update action status (target user response)
 * Target user calls this to accept, reject, or complete an action
 *
 * @param guardianOtp - Optional: guardian OTP code to resubmit this same action with,
 *   after a prior call returned a `GUARDIAN_OTP_REQUIRED` per-item error. Sent as
 *   `guardian_otp` on the payload.
 */
export async function updateActionStatus(
  payload: UpdateActionStatusPayload,
  guardianOtp?: string,
): Promise<UpdateActionStatusResponse> {
  const body = guardianOtp ? { ...payload, guardian_otp: guardianOtp } : payload;
  return unwrapBulkSingle(
    apiClient.post<BulkEnvelope<UpdateActionStatusResponse>>('/api/v1/action/update-status', [body]),
  );
}

/**
 * Perform multiple actions in one bulk call. All payloads share the same source
 * instance (the source item's instance), so a single array POST is correct; the
 * backend loops per-item over the peer endpoint. Returns the full envelope so
 * callers can surface partial-success (207).
 */
export async function performActionsBulk(
  payloads: PerformActionPayload[],
  _sourceInstanceUrl?: string,
  guardianOtp?: string,
): Promise<BulkEnvelope<PerformActionResponse>> {
  const client = actionClient();
  const body = guardianOtp
    ? payloads.map((payload) => ({ ...payload, guardian_otp: guardianOtp }))
    : payloads;
  return postBulkEnvelope<PerformActionResponse>(
    // Feature #293: array goes to the dedicated /perform/bulk route. `body`
    // carries guardian_otp on each payload when set.
    client.post<BulkEnvelope<PerformActionResponse>>('/api/v1/action/perform/bulk', body),
  );
}

/**
 * Update multiple action statuses in one bulk call. All target actions are
 * self-owned and live on the caller's instance, so a single array POST is
 * correct. Returns the full envelope.
 */
export async function updateActionStatusBulk(
  payloads: UpdateActionStatusPayload[],
  guardianOtp?: string,
): Promise<BulkEnvelope<UpdateActionStatusResponse>> {
  const body = guardianOtp
    ? payloads.map((payload) => ({ ...payload, guardian_otp: guardianOtp }))
    : payloads;
  return postBulkEnvelope<UpdateActionStatusResponse>(
    // `body` carries the single guardian OTP on each payload when set, so a
    // minor's whole accept batch clears with one code (#393).
    apiClient.post<BulkEnvelope<UpdateActionStatusResponse>>('/api/v1/action/update-status', body),
  );
}

/**
 * Appends a single-or-array query param as REPEATED keys (one `params.append`
 * per value) — matches how the server's `FetchOwnedActionsQuerySchema`
 * (`action_type`/`action_status`, #439) accepts either a lone value or a
 * repeated one and normalizes both to an array server-side. A bare string
 * still appends exactly once, so single-value callers are unaffected.
 */
function appendRepeated(params: URLSearchParams, key: string, value: string | string[] | undefined) {
  if (value === undefined) return;
  for (const v of Array.isArray(value) ? value : [value]) {
    params.append(key, v);
  }
}

/**
 * Appends `facets` in the `qs` bracket-notation the API's `/action/fetch`
 * route expects: `facets[0][field]=..&facets[0][values][0]=..&...`. The
 * route registers `fastify-qs` specifically so this nested
 * array-of-objects shape parses into `FetchOwnedActionsQuerySchema.facets`
 * (see `apps/api/src/app.ts` + the route's enrich test) — plain
 * `URLSearchParams`/JSON-encoding would NOT be parsed by the server's
 * default querystring parser, so this must NOT be JSON.stringify'd (unlike
 * discover's `filters`, which travels as a POST JSON body, not a query
 * string).
 */
function appendFacets(params: URLSearchParams, facets: FetchMyActionsQuery['facets']) {
  if (!facets?.length) return;
  facets.forEach((facet, i) => {
    params.append(`facets[${i}][field]`, facet.field);
    facet.values.forEach((v, j) => {
      params.append(`facets[${i}][values][${j}]`, v);
    });
  });
}

/**
 * Fetch my actions with filtering and pagination
 * Use ownership_role to filter: 'initiated' | 'received' | 'all'
 */
export async function fetchMyActions(
  query: FetchMyActionsQuery = {},
  signal?: AbortSignal
): Promise<FetchMyActionsResponse> {
  const params = new URLSearchParams();

  // Always set ownership_role, default to 'all'
  params.set('ownership_role', query.ownership_role ?? 'all');

  if (query.action_id) params.set('action_id', query.action_id);
  appendRepeated(params, 'action_type', query.action_type);
  appendRepeated(params, 'action_status', query.action_status);
  if (query.item_id) params.set('item_id', query.item_id);
  if (query.sort) params.set('sort', query.sort);
  appendFacets(params, query.facets);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));

  const response = await apiClient.get<FetchMyActionsResponse>('/api/v1/action/fetch', {
    params,
    signal,
  });
  return response.data;
}

/**
 * Fetch events/history for a specific action
 */
export async function fetchActionEvents(
  query: FetchActionEventsQuery,
  signal?: AbortSignal
): Promise<FetchActionEventsResponse> {
  const params = new URLSearchParams();

  params.set('action_type', query.action_type);
  params.set('action_id', query.action_id);
  if (query.update_count !== undefined) {
    params.set('update_count', String(query.update_count));
  }
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));

  const response = await apiClient.get<FetchActionEventsResponse>('/api/v1/action/fetch-events', {
    params,
    signal,
  });
  return response.data;
}

/**
 * Fetch contact details for the other party in an accepted action.
 * Only succeeds when the action status has PII reveal enabled.
 *
 * @param actionId - The action UUID
 */
export async function getActionContactDetails(
  actionId: string
): Promise<ContactDetailsResponse> {
  try {
    const response = await apiClient.get<ContactDetailsResponse>(
      `/api/v1/action/${actionId}/contact-details`,
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
    return response.data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      const body = err.response.data as Partial<ContactDetailsErrorBody>;
      const message = body.message ?? `HTTP error ${err.response.status}`;
      const code: ContactDetailsErrorCode = body.error ?? 'INTERNAL_SERVER_ERROR';
      const typed = new Error(message) as ContactDetailsError;
      typed.status = err.response.status;
      typed.code = code;
      throw typed;
    }
    throw err;
  }
}
