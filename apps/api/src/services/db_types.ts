import type { db } from '@api/db/postgres/drizzle_config';

/**
 * The "db client or open transaction" executor type, in a leaf module both
 * `item_service.ts` and `services/aggregator/default_aggregator.ts` can import.
 *
 * It lived in `item_service.ts`, but that module imports the go-live
 * classifier, which needs the default-aggregator service — so the second
 * consumer could not import the type back without a cycle and had to copy the
 * `Parameters<Parameters<typeof db.transaction>[0]>[0]` incantation. One
 * definition, no cycle.
 *
 * `import type` only: this module must never pull the configured db client into
 * a runtime graph, so the standalone ops scripts (which build their own pool
 * and skip the API's env validation) can still import anything that uses it.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type DbOrTx = typeof db | Tx;
