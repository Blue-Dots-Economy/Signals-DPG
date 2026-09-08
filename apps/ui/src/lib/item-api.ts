import { createApiClient } from './api-client';

const apiClient = createApiClient();

export type ItemLocation = { lat: number; lng: number; label?: string };

export interface CreateItemPayload {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_instance_url?: string;
  item_schema_url?: string;
  item_state: Record<string, unknown>;
  item_locations?: ItemLocation[];
  consent?: { category: 'profile_creation'; version: number; brand?: string | null };
}

export interface CreateItemResponse {
  item_type: string;
  item_id: string;
}

export interface FetchItemsQuery {
  item_id?: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_instance_url?: string;
  item_schema_url?: string;
  created_by_me?: boolean;
  /** Include retired profiles (default excludes them). Used by the login-redirect
   * check so a retired-only user isn't treated as profile-less. */
  include_retired?: boolean;
  limit?: number;
  offset?: number;
}

export interface Item {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_instance_url: string | null;
  item_schema_url: string | null;
  item_state: Record<string, unknown>;
  item_locations: ItemLocation[];
  created_at: string;
  updated_at: string;
  lifecycle_status?: 'draft' | 'live' | 'paused' | 'retired';
  // #394: only populated on items returned by the discover BFF
  // (`fetchDiscover` in `@/lib/network-api`, `DiscoverResponse.items`) — the
  // SAME cosine-similarity relevance score `/api/v1/match-score/calculate`
  // computes via signals-search `/v1/relevance`.
  //
  // On the wire it is the RAW cosine (~0-1); `fetchDiscover` rescales it to
  // **0-100** before it reaches any component, so by the time it is on an
  // `Item` it is already a percentage. See `toPercentScale` there — that is
  // the only place that knows the wire scale.
  //
  // Absent on native-fetched items (`fetchItems`/`fetchNetworkItems`), which
  // never set it. `distanceMeters` is unused today but carried for parity
  // with the discover response shape.
  score?: number;
  distanceMeters?: number;
}

export interface FetchItemsResponse {
  meta: {
    total: number;
    limit: number;
    offset: number;
    // Only populated by the inter-instance network fetch
    // (`/api/v1/network/item/fetch`, see `fetchNetworkItems` in
    // `@/lib/network-api`) — `true` when a peer instance didn't answer in
    // time and the merged result is known-incomplete (#203 §6). The
    // instance-local `/api/v1/item/fetch` (`fetchItems` below) never sets
    // these, hence optional here rather than widening every caller.
    partial?: boolean;
    unavailable_instances?: string[];
  };
  items: Item[];
}

export interface UpdateItemPayload {
  item_instance_url?: string;
  item_schema_url?: string;
  item_state?: Record<string, unknown>;
  item_locations?: ItemLocation[];
}

export interface UpdateItemResponse {
  item: Item;
}

export interface ApiError {
  error: string;
  message: string;
}

export async function createItem(payload: CreateItemPayload): Promise<CreateItemResponse> {
  const response = await apiClient.post<CreateItemResponse>('/api/v1/item/create', payload);
  return response.data;
}

export async function fetchItems(query: FetchItemsQuery, signal?: AbortSignal): Promise<FetchItemsResponse> {
  const params = new URLSearchParams();

  params.set('item_network', query.item_network);
  params.set('item_domain', query.item_domain);
  params.set('item_type', query.item_type);

  if (query.item_id) params.set('item_id', query.item_id);
  if (query.item_instance_url) params.set('item_instance_url', query.item_instance_url);
  if (query.item_schema_url) params.set('item_schema_url', query.item_schema_url);
  if (query.created_by_me) params.set('created_by_me', 'true');
  if (query.include_retired) params.set('include_retired', 'true');
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));

  const response = await apiClient.get<FetchItemsResponse>('/api/v1/item/fetch', { params, signal });
  return response.data;
}

export async function updateItem(itemId: string, payload: UpdateItemPayload): Promise<UpdateItemResponse> {
  const response = await apiClient.patch<UpdateItemResponse>(`/api/v1/item/${itemId}`, payload);
  return response.data;
}

export type ItemLifecycleAction = 'pause' | 'unpause' | 'retire';

export interface ItemLifecycleResponse {
  item_id: string;
  lifecycle_status: 'draft' | 'live' | 'paused' | 'retired';
}

/**
 * Change a profile's lifecycle. `pause` (only valid on `live`) / `unpause`
 * re-validate completeness (#346). `retire` (#347) is TERMINAL and
 * irreversible: it wipes PII, cancels open connections, de-indexes the profile
 * and removes it from the owner's list — there is no transition back.
 */
export async function setItemLifecycle(
  itemId: string,
  action: ItemLifecycleAction,
): Promise<ItemLifecycleResponse> {
  const response = await apiClient.post<ItemLifecycleResponse>('/api/v1/item/lifecycle', {
    item_id: itemId,
    action,
  });
  return response.data;
}

// Re-export action-related types and functions from action-api.ts
export {
  type ItemRef,
  type TargetItemRef,
  type PerformActionPayload,
  type PerformActionResponse,
  performAction,
  performActionsBulk,
} from './action-api';
