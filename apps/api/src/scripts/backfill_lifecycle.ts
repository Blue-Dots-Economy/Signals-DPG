/**
 * backfill_lifecycle — recompute items.lifecycle_status for existing rows.
 *
 * #180: when a network.json `required[]` changes, an item that was written
 * `live` may no longer be required-complete (or vice-versa). A blanket DEFAULT
 * is wrong either way. This command re-runs each item through the SAME pure
 * classifier used on writes (`classify_item`: `paused` sticky; otherwise
 * `live` iff required-complete AND profile-creation consent accepted) over its
 * stored state, and updates `lifecycle_status` only where it actually changed.
 *
 * `consent_accepted` per item = has a `profile_creation` row in the consent
 * ledger (same signal as backfill_demote_consentless). So this is the general
 * recompute across BOTH gate dimensions (completeness + consent), covering the
 * required[]-changed case the consent-only backfill doesn't.
 *
 * No decryption needed: the stored public `item_state` carries masks for
 * provided private fields, and `is_populated(mask)` is true — so completeness
 * matches write-time exactly.
 *
 * On-demand + idempotent — run it when a served network's item schema changes.
 * Ships compiled in the api image; run:
 *   node dist/scripts/backfill_lifecycle.js [--network N] [--domain D] [--item-type T] [--dry-run]
 *   (local: pnpm --filter api db:backfill:lifecycle -- --dry-run)
 */
import { and, eq, asc, sql, type SQL } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { classify_item, type LifecycleStatus } from '@/services/items/classifier';
import { get_item_schema, type JSONSchemaLike } from '@/services/metrics/schema_lookup';

const BATCH_SIZE = 1000;

interface Args {
  network?: string;
  domain?: string;
  itemType?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--network': a.network = argv[++i]; break;
      case '--domain': a.domain = argv[++i]; break;
      case '--item-type': a.itemType = argv[++i]; break;
      case '--dry-run': a.dryRun = true; break;
      case '--': break; // arg separator forwarded by pnpm/npm — ignore
      default: throw new Error(`unknown arg: ${argv[i]}`);
    }
  }
  return a;
}

// Cache resolved schemas per (network/domain/item_type). A null value means the
// schema couldn't be resolved (unserved / removed) — those items are skipped.
const schemaCache = new Map<string, JSONSchemaLike | null>();
async function schemaFor(network: string, domain: string, itemType: string): Promise<JSONSchemaLike | null> {
  const key = `${network}/${domain}/${itemType}`;
  if (schemaCache.has(key)) return schemaCache.get(key)!;
  let schema: JSONSchemaLike | null = null;
  try {
    schema = await get_item_schema(network, domain, itemType);
  } catch {
    schema = null;
  }
  schemaCache.set(key, schema);
  return schema;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `backfill_lifecycle: scope=${args.network ?? '*'}/${args.domain ?? '*'}/${args.itemType ?? '*'}` +
      `${args.dryRun ? ' (dry-run)' : ''}`,
  );

  const scope: Array<SQL | undefined> = [
    args.network ? eq(items.item_network, args.network) : undefined,
    args.domain ? eq(items.item_domain, args.domain) : undefined,
    args.itemType ? eq(items.item_type, args.itemType) : undefined,
  ];

  let scanned = 0;
  let changed = 0;
  let skipped = 0;
  const transitions: Record<string, number> = {};

  // The classifier gates `live` on required-completeness AND profile-creation
  // consent. An item is consent-accepted iff it has a `profile_creation` row in
  // the consent ledger. Load that id set once (matches backfill_demote_consentless).
  const consentedResult = await db.execute(
    sql`SELECT DISTINCT item_id FROM consent_record
        WHERE level = 'item' AND consent_category = 'profile_creation' AND item_id IS NOT NULL`
  );
  const consented = new Set(
    ((consentedResult as unknown as { rows: Array<{ item_id: string }> }).rows ?? []).map(
      (r) => r.item_id
    )
  );

  // Offset pagination is stable here: the only column we UPDATE is
  // lifecycle_status, never the ORDER BY keys (the composite PK), so the row
  // set and its ordering don't shift between batches.
  const whereScope = and(...scope);
  for (let offset = 0; ; offset += BATCH_SIZE) {
    const rows = await db
      .select({
        item_network: items.item_network,
        item_domain: items.item_domain,
        item_type: items.item_type,
        item_id: items.item_id,
        item_state: items.item_state,
        lifecycle_status: items.lifecycle_status,
      })
      .from(items)
      .where(whereScope)
      .orderBy(asc(items.item_network), asc(items.item_domain), asc(items.item_type), asc(items.item_id))
      .limit(BATCH_SIZE)
      .offset(offset);

    if (rows.length === 0) break;

    for (const row of rows) {
      scanned++;
      const schema = await schemaFor(row.item_network, row.item_domain, row.item_type);
      if (!schema) {
        skipped++;
        continue;
      }
      const current = row.lifecycle_status as LifecycleStatus;
      // No `gates` passed, so `owner_required` (#640) is not evaluated here —
      // a lifecycle backfill must not demote a population for want of an
      // owning aggregator. See `GO_LIVE_GATE_CHECKS.owner_required`.
      const next = classify_item({
        schema,
        merged_state: (row.item_state ?? {}) as Record<string, unknown>,
        current_status: current,
        consent_accepted: consented.has(row.item_id),
      }).lifecycle_status;

      if (next !== current) {
        transitions[`${current}->${next}`] = (transitions[`${current}->${next}`] ?? 0) + 1;
        changed++;
        if (!args.dryRun) {
          await db
            .update(items)
            .set({ lifecycle_status: next })
            .where(
              and(
                eq(items.item_network, row.item_network),
                eq(items.item_domain, row.item_domain),
                eq(items.item_type, row.item_type),
                eq(items.item_id, row.item_id),
              ),
            );
        }
      }
    }

    if (rows.length < BATCH_SIZE) break;
  }

  console.log(
    `backfill_lifecycle: scanned=${scanned} changed=${changed} skipped=${skipped}` +
      `${args.dryRun ? ' (dry-run — no writes)' : ''}`,
  );
  for (const [k, v] of Object.entries(transitions)) console.log(`  ${k}: ${v}`);
  console.log('backfill_lifecycle: done.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('backfill_lifecycle failed:', err);
    process.exit(1);
  });
