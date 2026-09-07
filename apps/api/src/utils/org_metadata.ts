import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { organization } from '@api/db/postgres/schema/auth';

/**
 * Reading an aggregator's declared item domains off `organization.metadata`.
 *
 * `metadata` is a JSON *string* column (a better-auth convention), and
 * `POST /api/v1/admin/aggregator/upsert` writes `{ external_id, domains, ... }`
 * into it so a new field needs no migration on the org table. The aggregator
 * dashboard and the aggregator export had each grown their own copy of the
 * same defensive parse, so it lives here once.
 *
 * Always defensive: a null column, malformed JSON, a missing `domains` key or
 * non-string entries all degrade to `[]` rather than throwing. Callers decide
 * what an empty list means — both current callers return 400
 * `NO_DOMAINS_CONFIGURED`.
 */

/** Parse the declared domains out of a raw `organization.metadata` value. */
function parseConfiguredDomains(metadata: string | null | undefined): string[] {
  if (!metadata) return [];
  try {
    const meta = JSON.parse(metadata) as { domains?: unknown };
    if (!Array.isArray(meta.domains)) return [];
    return meta.domains.filter((d): d is string => typeof d === 'string');
  } catch {
    return [];
  }
}

/**
 * The domains an org declares, read straight from its row.
 *
 * @returns the declared domains, or `[]` when the org is missing, has no
 *   metadata, or its metadata does not carry a usable `domains` array.
 */
export async function readConfiguredDomains(orgId: string): Promise<string[]> {
  const [org] = (await db
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1)) as Array<{ metadata: string | null }>;

  return parseConfiguredDomains(org?.metadata);
}
