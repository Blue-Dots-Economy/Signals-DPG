/**
 * Unit tests for default-aggregator resolution + tagging (SS-3, #640).
 *
 * The column these functions read decides who may decrypt an inbound
 * population's PII, so the behaviours pinned here are the safety ones: the
 * write-once tagging, and "no default nominated" as a normal state. Defaults
 * are per binding, so a seeker aggregator and a provider aggregator coexist;
 * the exclusivity trigger stops two orgs claiming the same binding.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const dbState = {
  /** Rows the org lookup returns — length drives the 0 / 1 / 2+ branches. */
  orgRows: [] as Array<{ id: string }>,
  /** Rows the user lookup returns. */
  userRows: [] as Array<{ onboardedByOrgId: string | null }>,
  /** Rows the tagging UPDATE ... RETURNING reports as written. */
  taggedRows: [] as Array<{ id: string }>,
  /** Every SQL object handed to `execute`, so we can assert on the query. */
  executed: [] as unknown[],
};

vi.mock('@api/db/postgres/drizzle_config', () => {
  const execute = vi.fn((query: unknown) => {
    dbState.executed.push(query);
    const sqlText = JSON.stringify(query);
    // The tag write is an UPDATE ... RETURNING; the resolution is a SELECT.
    return Promise.resolve({
      rows: sqlText.includes('UPDATE') ? dbState.taggedRows : dbState.orgRows,
    });
  });
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(dbState.userRows)),
      })),
    })),
  }));
  return { db: { select, execute } };
});

const { db } = await import('@api/db/postgres/drizzle_config');
const {
  bindingKey,
  defaultAggregatorQuery,
  resolveDefaultAggregator,
  tagUserWithDefaultAggregator,
  resolveOwnerGateContext,
} = await import('../default_aggregator.js');

beforeEach(() => {
  dbState.orgRows = [];
  dbState.userRows = [];
  dbState.taggedRows = [];
  dbState.executed = [];
  vi.clearAllMocks();
});

describe('bindingKey', () => {
  it('is network-qualified, matching served_domain_guard', () => {
    expect(bindingKey('blue_dot', 'seeker')).toBe('blue_dot/seeker');
  });
});

describe('defaultAggregatorQuery', () => {
  // Both halves matter: without the `&&` overlap the query would return any
  // default (handing a provider signup to the seeker aggregator), and without
  // `type = 'aggregator'` a network_service org could own an inbound population.
  it('filters to the aggregator holding THIS binding', () => {
    const rendered = JSON.stringify(defaultAggregatorQuery('blue_dot/seeker'));
    expect(rendered).toContain('default_for_bindings &&');
    expect(rendered).toContain('blue_dot/seeker');
    expect(rendered).toContain("type = 'aggregator'");
    expect(rendered).toContain('LIMIT 1');
  });
});

describe('resolveDefaultAggregator', () => {
  it('runs the shared query and applies the rule', async () => {
    dbState.orgRows = [{ id: 'org_agg_1' }];
    await expect(resolveDefaultAggregator(db, 'blue_dot', 'seeker')).resolves.toEqual({ org_id: 'org_agg_1' });
    expect(dbState.executed).toHaveLength(1);
  });

});

describe('tagUserWithDefaultAggregator', () => {
  it('reports tagged when the guarded UPDATE wrote a row', async () => {
    dbState.taggedRows = [{ id: 'user_1' }];
    await expect(
      tagUserWithDefaultAggregator(db, 'user_1', 'blue_dot', 'seeker'),
    ).resolves.toEqual({ tagged: true });
  });

  it('reports not tagged when it matched no rows', async () => {
    dbState.taggedRows = [];
    await expect(
      tagUserWithDefaultAggregator(db, 'user_1', 'blue_dot', 'seeker'),
    ).resolves.toEqual({ tagged: false });
  });

  // One statement, so an already-owned user costs a single PK-guarded UPDATE
  // that matches nothing — the org lookup never runs for them.
  it('is a single statement, not resolve-then-write', async () => {
    dbState.taggedRows = [{ id: 'user_1' }];
    await tagUserWithDefaultAggregator(db, 'user_1', 'blue_dot', 'seeker');
    expect(dbState.executed).toHaveLength(1);
  });

  it('guards on IS NULL so the tag is write-once, and scopes to the binding', async () => {
    dbState.taggedRows = [{ id: 'user_1' }];
    await tagUserWithDefaultAggregator(db, 'user_1', 'blue_dot', 'seeker');
    const stmt = JSON.stringify(dbState.executed[0]);
    expect(stmt).toContain('onboarded_by_org_id IS NULL');
    expect(stmt).toContain('blue_dot/seeker');
    // EXISTS stops it writing NULL over NULL when no default is nominated.
    expect(stmt).toContain('EXISTS');
  });

  // A participant onboarded months ago already carries a real onboarded_at, and
  // item_metrics.age_days / profile_status derive from it — overwriting would
  // resurface a dormant user as brand new.
  it('coalesces onboarded_at and onboarded_via rather than overwriting', async () => {
    dbState.taggedRows = [{ id: 'user_1' }];
    await tagUserWithDefaultAggregator(db, 'user_1', 'blue_dot', 'seeker');
    const stmt = JSON.stringify(dbState.executed[0]);
    expect(stmt).toContain("coalesce(onboarded_via, 'self')");
    expect(stmt).toContain('coalesce(onboarded_at, now())');
  });
});

describe('resolveOwnerGateContext', () => {
  it('reports an owned user with a resolved default', () => {
    dbState.userRows = [{ onboardedByOrgId: 'org_agg_1' }];
    dbState.orgRows = [{ id: 'org_agg_1' }];
    return expect(resolveOwnerGateContext(db, 'user_1', 'blue_dot', 'seeker')).resolves.toEqual({
      has_owner: true,
      default_configured: true,
    });
  });

  it('reports an unowned user', () => {
    dbState.userRows = [{ onboardedByOrgId: null }];
    dbState.orgRows = [{ id: 'org_agg_1' }];
    return expect(resolveOwnerGateContext(db, 'user_1', 'blue_dot', 'seeker')).resolves.toEqual({
      has_owner: false,
      default_configured: true,
    });
  });

  it('reports none so the gate stays inert pre-launch', () => {
    dbState.userRows = [{ onboardedByOrgId: null }];
    dbState.orgRows = [];
    return expect(resolveOwnerGateContext(db, 'user_1', 'blue_dot', 'seeker')).resolves.toEqual({
      has_owner: false,
      default_configured: false,
    });
  });


  it('treats a missing user row as unowned (fail closed)', () => {
    dbState.userRows = [];
    dbState.orgRows = [{ id: 'org_agg_1' }];
    return expect(resolveOwnerGateContext(db, 'user_1', 'blue_dot', 'seeker')).resolves.toEqual({
      has_owner: false,
      default_configured: true,
    });
  });

  it('resolves the default for the given binding', async () => {
    dbState.userRows = [{ onboardedByOrgId: 'org_agg_1' }];
    dbState.orgRows = [{ id: 'org_agg_1' }];
    const ctx = await resolveOwnerGateContext(db, 'user_1', 'blue_dot', 'seeker');
    expect(ctx).toEqual({ has_owner: true, default_configured: true });
    expect(JSON.stringify(dbState.executed[0])).toContain('blue_dot/seeker');
  });
});
