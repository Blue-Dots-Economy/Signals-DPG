import type {
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { Readable } from 'node:stream';
import { db } from '@api/db/postgres/drizzle_config';
import { item_metrics } from '../../../../db/postgres/schema/metrics.js';
import { readConfiguredDomains } from '@/utils/org_metadata';
import { eq, and, inArray, asc, getTableColumns } from 'drizzle-orm';
import { ExportQuery, type ExportQuery as ExportQueryType } from '@dpg/schemas';
import { check_and_refresh_if_stale } from '@/services/metrics/staleness';
import {
  resolve_private_display_names,
  type NameResolutionLog,
} from '@/utils/private_display_name';

const COLUMNS = [
  'profile_item_id',
  'user_id',
  'item_network',
  'item_domain',
  'item_type',
  'name',
  'onboarded_via',
  'profile_status',
  'profile_completion_pct',
  'profile_created_at',
  'profile_last_updated_at',
  'age_days',
  'initiated_create',
  'initiated_accept',
  'initiated_reject',
  'initiated_cancel',
  'received_create',
  'received_accept',
  'received_reject',
  'received_cancel',
  'last_initiated_create_at',
  'last_initiated_accept_at',
  'last_initiated_reject_at',
  'last_initiated_cancel_at',
  'last_received_create_at',
  'last_received_accept_at',
  'last_received_reject_at',
  'last_received_cancel_at',
  'actionable_tags',
] as const;

const PAGE_SIZE = 5000;

const csv_escape = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  let s: string;
  if (Array.isArray(v)) s = v.join('|');
  else if (v instanceof Date) s = v.toISOString();
  else s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

async function* generate_csv(
  aggregator_id: string,
  scope: string[],
  status: string | undefined,
  log?: NameResolutionLog,
): AsyncGenerator<string> {
  yield COLUMNS.join(',') + '\n';

  const base_where = and(
    eq(item_metrics.onboardedByOrgId, aggregator_id),
    inArray(item_metrics.itemDomain, scope),
  );
  const where = status
    ? and(base_where, eq(item_metrics.profileStatus, status))
    : base_where;

  let offset = 0;
  for (;;) {
    const rows = await db
      .select(getTableColumns(item_metrics))
      .from(item_metrics)
      .where(where!)
      .orderBy(asc(item_metrics.itemDomain), asc(item_metrics.itemId))
      .limit(PAGE_SIZE)
      .offset(offset);

    if (rows.length === 0) break;

    // Same entitlement as the dashboard list: every row belongs to the
    // acting aggregator, so private display names are revealed.
    const private_names = await resolve_private_display_names(rows, log);

    for (const r of rows) {
      const initiated = r.initiated ?? {};
      const received = r.received ?? {};
      const lastInitiated = r.lastInitiatedAt ?? {};
      const lastReceived = r.lastReceivedAt ?? {};
      const projected: Record<(typeof COLUMNS)[number], unknown> = {
        profile_item_id: r.itemId,
        user_id: r.ownerUserId,
        item_network: r.itemNetwork,
        item_domain: r.itemDomain,
        item_type: r.itemType,
        name: private_names.get(r.itemId) ?? r.displayName,
        onboarded_via: r.onboardedVia,
        profile_status: r.profileStatus,
        profile_completion_pct: r.profileCompletionPct,
        profile_created_at: r.profileCreatedAt,
        profile_last_updated_at: r.profileLastUpdatedAt,
        age_days: r.ageDays,
        initiated_create: initiated.create ?? 0,
        initiated_accept: initiated.accept ?? 0,
        initiated_reject: initiated.reject ?? 0,
        initiated_cancel: initiated.cancel ?? 0,
        received_create: received.create ?? 0,
        received_accept: received.accept ?? 0,
        received_reject: received.reject ?? 0,
        received_cancel: received.cancel ?? 0,
        last_initiated_create_at: lastInitiated.create ?? null,
        last_initiated_accept_at: lastInitiated.accept ?? null,
        last_initiated_reject_at: lastInitiated.reject ?? null,
        last_initiated_cancel_at: lastInitiated.cancel ?? null,
        last_received_create_at: lastReceived.create ?? null,
        last_received_accept_at: lastReceived.accept ?? null,
        last_received_reject_at: lastReceived.reject ?? null,
        last_received_cancel_at: lastReceived.cancel ?? null,
        actionable_tags: r.actionableTags,
      };
      yield COLUMNS.map((c) => csv_escape(projected[c])).join(',') + '\n';
    }

    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
}

type ExportRequest = FastifyRequest<{ Querystring: ExportQueryType }>;

export const aggregator_export: FastifyPluginAsync = async (app) => {
  app.route({
    method: 'GET',
    url: '/dashboard/export',
    schema: { tags: ['aggregator'], querystring: ExportQuery },
    handler: async (request: ExportRequest, reply: FastifyReply) => {
      const acting = request.acting_org;
      if (!acting || acting.org_type !== 'aggregator') {
        return reply.code(403).send({
          error: 'NOT_AGGREGATOR',
          message: 'caller must act on behalf of an aggregator org',
        });
      }

      const configured = await readConfiguredDomains(acting.org_id);
      if (configured.length === 0) {
        return reply.code(400).send({
          error: 'NO_DOMAINS_CONFIGURED',
          message: 'org.metadata.domains is empty — re-upsert with domains array',
        });
      }

      const { domain: requested_domain, status, refresh } = request.query;
      let scope = configured;
      if (requested_domain) {
        if (!configured.includes(requested_domain)) {
          return reply.code(400).send({
            error: 'DOMAIN_NOT_CONFIGURED',
            message: `?domain=${requested_domain} is not in org.metadata.domains`,
          });
        }
        scope = [requested_domain];
      }

      await Promise.all(
        scope.map((d) => check_and_refresh_if_stale(acting.org_id, d, refresh)),
      );

      const filename = `items_${acting.org_id}_${new Date()
        .toISOString()
        .slice(0, 10)}.csv`;
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`);

      return reply.send(
        Readable.from(generate_csv(acting.org_id, scope, status, request.log)),
      );
    },
  });
};

export default aggregator_export;
