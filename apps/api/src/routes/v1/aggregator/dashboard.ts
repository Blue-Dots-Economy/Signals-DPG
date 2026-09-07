import type {
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { item_metrics } from '../../../../db/postgres/schema/metrics.js';
import { readConfiguredDomains } from '@/utils/org_metadata';
import { eq, and, sql, desc, getTableColumns, inArray } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  resolve_private_display_names,
  type NameResolutionLog,
} from '@/utils/private_display_name';
import {
  DashboardRequestQuery,
  DashboardResponse,
  type DashboardRequestQuery as DQ,
} from '@dpg/schemas';
import {
  check_and_refresh_if_stale,
  TTL_SECONDS,
} from '@/services/metrics/staleness';

/**
 * GET /api/v1/aggregator/dashboard
 *
 * Returns a per-domain rollup + paginated items list for the acting
 * aggregator. The set of in-scope domains is determined by
 * `organization.metadata.domains` (a JSON string column); callers
 * can narrow to one with `?domain=`.
 *
 * Auth/acting_org resolution happens upstream in aggregator_routes'
 * preHandler chain. This handler enforces:
 *   - acting org_type === 'aggregator'           → 403 NOT_AGGREGATOR
 *   - org.metadata.domains is non-empty array    → 400 NO_DOMAINS_CONFIGURED
 *   - ?domain= (when present) is in that set     → 400 DOMAIN_NOT_CONFIGURED
 *
 * Per-domain staleness is refreshed in parallel via Promise.all. The
 * top-level metadata.last_computed_at is the earliest across all scoped
 * domains; metadata.refreshed is true if any domain was refreshed.
 */
type DashboardRequest = FastifyRequest<{ Querystring: DQ }>;

/** Every lifecycle_status value an item can hold. */
const ALL_LIFECYCLES = ['draft', 'live', 'paused', 'retired'] as const;
/** Applied when the caller supplies no valid lifecycle value. */
const DEFAULT_LIFECYCLES = ['live', 'draft'] as const;

/**
 * Resolve the `?lifecycle=` query into a concrete set of lifecycle_status
 * values to filter on. Splits the comma list, trims, drops unknown values,
 * and falls back to the default (live + draft) when nothing valid remains
 * (absent param, empty string, or all-invalid input).
 */
export function resolve_lifecycle_filter(lifecycle: string | undefined): string[] {
  const requested = lifecycle?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  const valid = requested.filter((s) => (ALL_LIFECYCLES as readonly string[]).includes(s));
  return valid.length ? valid : [...DEFAULT_LIFECYCLES];
}

export const aggregator_dashboard: FastifyPluginAsync = async (app) => {
  app.route({
    method: 'GET',
    url: '/dashboard',
    schema: {
      tags: ['aggregator'],
      querystring: DashboardRequestQuery,
      response: { 200: DashboardResponse },
    },
    handler: aggregator_dashboard_handler,
  });
};

export const aggregator_dashboard_handler = async (
  request: DashboardRequest,
  reply: FastifyReply,
) => {
  const acting = request.acting_org;
  if (!acting || acting.org_type !== 'aggregator') {
    return reply.code(403).send({
      error: 'NOT_AGGREGATOR',
      message: 'caller must act on behalf of an aggregator org',
    });
  }

  const configured_domains = await readConfiguredDomains(acting.org_id);
  if (configured_domains.length === 0) {
    return reply.code(400).send({
      error: 'NO_DOMAINS_CONFIGURED',
      message: 'org.metadata.domains is empty — re-upsert with domains array',
    });
  }

  const { page, limit, domain: requested_domain, status, refresh, lifecycle } = request.query;
  let scope: string[] = configured_domains;
  if (requested_domain) {
    if (!configured_domains.includes(requested_domain)) {
      return reply.code(400).send({
        error: 'DOMAIN_NOT_CONFIGURED',
        message: `?domain=${requested_domain} is not in org.metadata.domains`,
      });
    }
    scope = [requested_domain];
  }

  // Parallel staleness check per (org, domain) — each has its own
  // advisory-lock key (see services/metrics/staleness.ts), so domains
  // can refresh concurrently without blocking each other.
  const staleness = await Promise.all(
    scope.map((d) => check_and_refresh_if_stale(acting.org_id, d, refresh)),
  );
  const earliest_last_computed = staleness
    .map((s) => s.last_computed_at)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const any_refreshed = staleness.some((s) => s.refreshed);

  const by_domain: Record<string, unknown> = {};
  for (const d of scope) {
    by_domain[d] = await build_domain_block(acting.org_id, d, page, limit, status, lifecycle, request.log);
  }

  return {
    by_domain,
    metadata: {
      last_computed_at: earliest_last_computed?.toISOString() ?? null,
      ttl_seconds: TTL_SECONDS,
      refreshed: any_refreshed,
    },
  };
};

async function build_domain_block(
  org_id: string,
  domain: string,
  page: number,
  limit: number,
  status: string | undefined,
  lifecycle: string | undefined,
  log?: NameResolutionLog,
) {
  // Resolve the requested lifecycle set (comma-list → known values, default
  // live+draft). `lifecycleList` is the SQL fragment for the raw rollup/mode
  // queries; `lifecycleFilter` drives the query-builder `inArray` below.
  const lifecycleFilter = resolve_lifecycle_filter(lifecycle);
  const lifecycleList = sql.join(lifecycleFilter.map((s) => sql`${s}`), sql`, `);

  const base_where = and(
    eq(item_metrics.onboardedByOrgId, org_id),
    eq(item_metrics.itemDomain, domain),
    inArray(item_metrics.lifecycleStatus, lifecycleFilter),
  );
  const filter_where = status
    ? and(base_where, eq(item_metrics.profileStatus, status))
    : base_where;

  // Per-(direction,bucket) integer extraction from the jsonb action maps.
  const jint = (col: AnyPgColumn, bucket: string) =>
    sql`COALESCE((${col}->>${bucket})::int, 0)`;
  const dirSum = (col: AnyPgColumn) =>
    sql`(${jint(col, 'create')} + ${jint(col, 'accept')} + ${jint(col, 'reject')} + ${jint(col, 'cancel')})`;
  // Total actions on a row = initiated + received across all buckets.
  const rowTotal = sql`(${dirSum(item_metrics.initiated)} + ${dirSum(item_metrics.received)})`;

  // Single aggregate query for the rollup tiles + derived metrics.
  // ?status= filters the items list but NOT the rollup counts — those
  // reflect the full domain population regardless of the status filter.
  const rollupRes: unknown = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total_items,
      COUNT(*) FILTER (WHERE ${item_metrics.profileCompletionPct} >= 100)::int AS complete_profiles,
      COUNT(*) FILTER (WHERE ${rowTotal} > 0)::int AS has_applications,

      COUNT(*) FILTER (WHERE ${item_metrics.profileStatus} = 'new')::int      AS s_new,
      COUNT(*) FILTER (WHERE ${item_metrics.profileStatus} = 'active')::int   AS s_active,
      COUNT(*) FILTER (WHERE ${item_metrics.profileStatus} = 'at_risk')::int  AS s_at_risk,
      COUNT(*) FILTER (WHERE ${item_metrics.profileStatus} = 'inactive')::int AS s_inactive,

      COALESCE(SUM(${jint(item_metrics.initiated, 'create')}), 0)::int AS bi_create,
      COALESCE(SUM(${jint(item_metrics.initiated, 'accept')}), 0)::int AS bi_accept,
      COALESCE(SUM(${jint(item_metrics.initiated, 'reject')}), 0)::int AS bi_reject,
      COALESCE(SUM(${jint(item_metrics.initiated, 'cancel')}), 0)::int AS bi_cancel,

      COALESCE(SUM(${jint(item_metrics.received, 'create')}), 0)::int AS br_create,
      COALESCE(SUM(${jint(item_metrics.received, 'accept')}), 0)::int AS br_accept,
      COALESCE(SUM(${jint(item_metrics.received, 'reject')}), 0)::int AS br_reject,
      COALESCE(SUM(${jint(item_metrics.received, 'cancel')}), 0)::int AS br_cancel,

      COUNT(DISTINCT ${item_metrics.ownerUserId})::int AS total_users,
      COALESCE(SUM(${rowTotal}), 0)::int AS total_actions,
      COUNT(DISTINCT ${item_metrics.ownerUserId}) FILTER (
        WHERE ${rowTotal} > 0
      )::int AS engaged_users
    FROM ${item_metrics}
    WHERE ${item_metrics.onboardedByOrgId} = ${org_id}
      AND ${item_metrics.itemDomain} = ${domain}
      AND ${item_metrics.lifecycleStatus} IN (${lifecycleList});
  `);
  const rollupRow: Record<string, number> = (Array.isArray(rollupRes)
    ? (rollupRes as Array<Record<string, number>>)[0]
    : ((rollupRes as { rows?: Array<Record<string, number>> }).rows ?? [])[0]) ?? {};

  const modeRes: unknown = await db.execute(sql`
    SELECT ${item_metrics.onboardedVia} AS via, COUNT(*)::int AS n
    FROM ${item_metrics}
    WHERE ${item_metrics.onboardedByOrgId} = ${org_id}
      AND ${item_metrics.itemDomain} = ${domain}
      AND ${item_metrics.lifecycleStatus} IN (${lifecycleList})
    GROUP BY ${item_metrics.onboardedVia};
  `);
  const modeRows: Array<{ via: string | null; n: number }> = Array.isArray(modeRes)
    ? (modeRes as Array<{ via: string | null; n: number }>)
    : ((modeRes as { rows?: Array<{ via: string | null; n: number }> }).rows ?? []);
  const mode_wise_counts: Record<string, number> = {};
  for (const r of modeRows) if (r?.via) mode_wise_counts[r.via] = r.n;

  const total_items = rollupRow.total_items ?? 0;
  const total_users = rollupRow.total_users ?? 0;
  const total_actions = rollupRow.total_actions ?? 0;
  const engaged_users = rollupRow.engaged_users ?? 0;

  const rollup = {
    total_items,
    complete_profiles: rollupRow.complete_profiles ?? 0,
    has_applications: rollupRow.has_applications ?? 0,
    by_status: {
      new: rollupRow.s_new ?? 0,
      active: rollupRow.s_active ?? 0,
      at_risk: rollupRow.s_at_risk ?? 0,
      inactive: rollupRow.s_inactive ?? 0,
    },
    by_initiated_action_status: {
      create: rollupRow.bi_create ?? 0,
      accept: rollupRow.bi_accept ?? 0,
      reject: rollupRow.bi_reject ?? 0,
      cancel: rollupRow.bi_cancel ?? 0,
    },
    by_received_action_status: {
      create: rollupRow.br_create ?? 0,
      accept: rollupRow.br_accept ?? 0,
      reject: rollupRow.br_reject ?? 0,
      cancel: rollupRow.br_cancel ?? 0,
    },
    total_users,
    avg_items_per_user: total_users > 0 ? total_items / total_users : 0,
    avg_actions_per_user: engaged_users > 0 ? total_actions / engaged_users : 0,
    mode_wise_counts,
  };

  const total_rows = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(item_metrics)
    .where(filter_where!)) as Array<{ n: number }>;
  const total_matching = total_rows[0]?.n ?? 0;

  const list_rows = await db
    .select(getTableColumns(item_metrics))
    .from(item_metrics)
    .where(filter_where!)
    .orderBy(desc(item_metrics.profileLastUpdatedAt), desc(item_metrics.itemId))
    .limit(limit)
    .offset((page - 1) * limit);

  // Every row here is a participant this aggregator onboarded
  // (filter_where pins onboarded_by_org_id), so revealing the private
  // display name needs no further authorization — same entitlement rule
  // as GET /admin/participant.
  const private_names = await resolve_private_display_names(list_rows, log);

  const items_out = list_rows.map((r) => ({
    profile_item_id: r.itemId,
    user_id: r.ownerUserId ?? null,

    item_network: r.itemNetwork,
    item_domain: r.itemDomain,
    item_type: r.itemType,
    name: private_names.get(r.itemId) ?? r.displayName,
    onboarded_via: r.onboardedVia,

    profile_status: r.profileStatus as 'new' | 'active' | 'at_risk' | 'inactive' | null,
    lifecycle_status: r.lifecycleStatus as 'draft' | 'live' | 'paused' | 'retired',
    profile_completion_pct: r.profileCompletionPct,
    profile_created_at: r.profileCreatedAt?.toISOString() ?? null,
    profile_last_updated_at: r.profileLastUpdatedAt?.toISOString() ?? null,
    age_days: r.ageDays,

    // Stored as jsonb maps by recompute; passed through unchanged. Counts are
    // full maps; last_*_at maps are sparse (only buckets that occurred).
    initiated: r.initiated ?? {},
    received: r.received ?? {},
    last_initiated_at: r.lastInitiatedAt ?? {},
    last_received_at: r.lastReceivedAt ?? {},

    actionable_tags: r.actionableTags ?? [],
  }));

  return {
    rollup,
    items: items_out,
    total_matching,
    next_cursor: list_rows.length === limit ? String(page + 1) : null,
  };
}

export default aggregator_dashboard;
