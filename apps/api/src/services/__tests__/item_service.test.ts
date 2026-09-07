import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
// Every dependency of item_service is mocked so these stay fast unit tests:
// the real create/update paths are only otherwise covered by the excluded
// *.integration.test.ts suites (which need live Postgres + Redis).
const {
  getCurrentApiBaseUrl,
  isServedDomainBinding,
  getNetworkConfigById,
  getDomainItemTypes,
  getDomainItemSchema,
  getInstanceCustomItemSchemaUrl,
  buildNetworkItemSchemaUrl,
  getOrFetchSchemaByUrl,
  validateAgainstJsonSchema,
  splitItemStateByPrivacy,
  maskPrivateState,
  mergeMasksIntoPublic,
  mergeItemStateWithPrivate,
  primaryAddressChanged,
  isPrimaryAddressBlank,
  isLocationFieldPrivate,
  classify_item,
  hasAcceptedProfileConsent,
  is_populated,
  encryptPiiBlob,
  decryptPiiBlob,
  getPiiKey,
  jitterCoordinate,
  geocodeLocationsFromState,
  guardianConsentRequired,
  guardianProfileConsentRow,
  apiConfig,
  geocodingConfig,
} = vi.hoisted(() => ({
  getCurrentApiBaseUrl: vi.fn(),
  isServedDomainBinding: vi.fn(),
  getNetworkConfigById: vi.fn(),
  getDomainItemTypes: vi.fn(),
  getDomainItemSchema: vi.fn(),
  getInstanceCustomItemSchemaUrl: vi.fn(),
  buildNetworkItemSchemaUrl: vi.fn(),
  getOrFetchSchemaByUrl: vi.fn(),
  validateAgainstJsonSchema: vi.fn(),
  splitItemStateByPrivacy: vi.fn(),
  maskPrivateState: vi.fn(),
  mergeMasksIntoPublic: vi.fn(),
  mergeItemStateWithPrivate: vi.fn(),
  primaryAddressChanged: vi.fn(),
  isPrimaryAddressBlank: vi.fn(),
  isLocationFieldPrivate: vi.fn(),
  classify_item: vi.fn(),
  hasAcceptedProfileConsent: vi.fn(),
  is_populated: vi.fn(),
  encryptPiiBlob: vi.fn(),
  decryptPiiBlob: vi.fn(),
  getPiiKey: vi.fn(),
  jitterCoordinate: vi.fn(),
  geocodeLocationsFromState: vi.fn(),
  guardianConsentRequired: vi.fn(),
  guardianProfileConsentRow: vi.fn(),
  apiConfig: { allow_extra_schema_data: false, max_profiles_per_user: 3 },
  geocodingConfig: { jitter_min_meters: 100, jitter_max_meters: 250 },
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
vi.mock('drizzle-orm', () => ({
  and: (...conds: any[]) => ({ op: 'and', conds }),
  eq: (col: any, val: any) => ({ op: 'eq', col, val }),
  count: () => ({ op: 'count' }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({
    op: 'sql',
    text: strings.join('?'),
    values,
  }),
}));

vi.mock('@dpg/schemas', () => ({
  getDomainItemSchema: (...a: any[]) => getDomainItemSchema(...a),
  getDomainItemTypes: (...a: any[]) => getDomainItemTypes(...a),
  getInstanceCustomItemSchemaUrl: (...a: any[]) => getInstanceCustomItemSchemaUrl(...a),
  isLocationFieldPrivate: (...a: any[]) => isLocationFieldPrivate(...a),
  maskPrivateState: (...a: any[]) => maskPrivateState(...a),
  mergeMasksIntoPublic: (...a: any[]) => mergeMasksIntoPublic(...a),
  mergeItemStateWithPrivate: (...a: any[]) => mergeItemStateWithPrivate(...a),
  primaryAddressChanged: (...a: any[]) => primaryAddressChanged(...a),
  isPrimaryAddressBlank: (...a: any[]) => isPrimaryAddressBlank(...a),
  splitItemStateByPrivacy: (...a: any[]) => splitItemStateByPrivacy(...a),
  validateAgainstJsonSchema: (...a: any[]) => validateAgainstJsonSchema(...a),
}));

vi.mock('../items/classifier.js', () => ({
  classify_item: (...a: any[]) => classify_item(...a),
  DEFAULT_GO_LIVE_GATES: ['schema_required'],
}));

vi.mock('../consent_acceptance.js', () => ({
  hasAcceptedProfileConsent: (...a: any[]) => hasAcceptedProfileConsent(...a),
}));

vi.mock('../metrics/profile_completion.js', () => ({
  is_populated: (...a: any[]) => is_populated(...a),
}));

vi.mock('@dpg/auth', () => ({
  encryptPiiBlob: (...a: any[]) => encryptPiiBlob(...a),
  decryptPiiBlob: (...a: any[]) => decryptPiiBlob(...a),
  getPiiKey: (...a: any[]) => getPiiKey(...a),
}));

vi.mock('@dpg/database', () => ({
  items: {
    item_network: 'items.item_network',
    item_domain: 'items.item_domain',
    item_type: 'items.item_type',
    item_id: 'items.item_id',
    item_instance_url: 'items.item_instance_url',
    item_schema_url: 'items.item_schema_url',
    item_state: 'items.item_state',
    item_private_state: 'items.item_private_state',
    item_locations: 'items.item_locations',
    lifecycle_status: 'items.lifecycle_status',
    created_by: 'items.created_by',
    created_at: 'items.created_at',
    updated_at: 'items.updated_at',
  },
}));

vi.mock('@api/db/postgres/schema', () => ({
  user: { id: 'user.id', age: 'user.age' },
  consent_record: {
    id: 'cr.id',
    userId: 'cr.userId',
    level: 'cr.level',
    consentCategory: 'cr.consentCategory',
    itemId: 'cr.itemId',
    source: 'cr.source',
    documentVersion: 'cr.documentVersion',
    acceptedAt: 'cr.acceptedAt',
    metadata: 'cr.metadata',
  },
}));

vi.mock('@api/db/postgres/drizzle_config', () => ({ db: {} }));

vi.mock('@/utils/served_domain_guard', () => ({
  isServedDomainBinding: (...a: any[]) => isServedDomainBinding(...a),
}));

vi.mock('../guardian_consent_rows', () => ({
  guardianProfileConsentRow: (...a: any[]) => guardianProfileConsentRow(...a),
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: (...a: any[]) => getNetworkConfigById(...a),
}));

vi.mock('@/services/minor', () => ({
  guardianConsentRequired: (...a: any[]) => guardianConsentRequired(...a),
  isMinor: (age: number) => age < 18,
}));

vi.mock('@/services/geocoding/resolve_locations_for_create', () => ({
  geocodeLocationsFromState: (...a: any[]) => geocodeLocationsFromState(...a),
}));

vi.mock('@/services/geocoding/jitter', () => ({
  jitterCoordinate: (...a: any[]) => jitterCoordinate(...a),
}));

vi.mock('@/network_schema_cache', () => ({
  buildNetworkItemSchemaUrl: (...a: any[]) => buildNetworkItemSchemaUrl(...a),
  getOrFetchSchemaByUrl: (...a: any[]) => getOrFetchSchemaByUrl(...a),
}));

vi.mock('@/config', () => ({ apiConfig, geocodingConfig, getCurrentApiBaseUrl }));
/* eslint-enable @typescript-eslint/no-explicit-any */

import {
  ItemServiceError,
  createItemInternal,
  guardianGateBlocksGoLive,
  isItemOwnedBy,
  jitterPrivateLocations,
  primaryLocation,
  promoteItemOnProfileConsent,
  sameLocations,
  updateItemInternal,
  upsertGuardianProfileConsentAndPromote,
  type DbOrTx,
  type ItemLocation,
} from '../item_service';

// --- fake drizzle executor -------------------------------------------------
type Row = Record<string, unknown>;

interface Recorded {
  inserts: Array<{ table: unknown; values: Row }>;
  updates: Array<{ set: Row; where: unknown }>;
  executes: unknown[];
  selectWheres: unknown[];
  conflicts: unknown[];
  order: string[];
}

function makeExec() {
  const rec: Recorded = {
    inserts: [],
    updates: [],
    executes: [],
    selectWheres: [],
    conflicts: [],
    order: [],
  };
  const queue: Row[][] = [];
  const state = {
    failWith: null as Error | null,
    /** What the domain-claim UPDATE returns. Non-empty `rows` = the user had no
     * domain and no items, so this create claimed it (the default). Set to
     * `{ rows: [] }` to simulate an already-locked user or a pre-0015 row,
     * which sends `assertSingleDomain` on to its SELECT — feed that read via
     * `queue`. */
    domainClaim: { rows: [{ id: 'u1' }] } as { rows: Array<{ id: string }> },
    /** `readLockedDomains`' column read (`SELECT domains FROM "user"`). */
    heldColumn: { rows: [] } as { rows: Array<{ domains: string[] | null }> },
    /** `readLockedDomains`' items fallback, reached only when the column read
     * came back empty — the pre-0015 legacy state. */
    itemDomains: { rows: [] } as { rows: Array<{ item_domain: string }> },
  };

  const next = (): Promise<Row[]> =>
    state.failWith
      ? Promise.reject(state.failWith)
      : Promise.resolve(queue.shift() ?? []);

  // Thenable: some call sites await `.where(...)` directly, others chain
  // `.limit(1)`. BOTH then callbacks are forwarded, otherwise a rejected query
  // would hang the await until the test timeout.
  const thenableRows = () => ({
    then: (res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) =>
      next().then(res, rej),
    limit: (_n: number) => next(),
    returning: (_cols?: Row) => next(),
  });

  const exec = {
    select: (_cols?: Row) => ({
      from: (_table: unknown) => ({
        where: (w?: unknown) => {
          rec.order.push('select');
          rec.selectWheres.push(w);
          return thenableRows();
        },
      }),
    }),
    execute: (q: unknown) => {
      rec.order.push('execute');
      rec.executes.push(q);
      // Routed by statement, so a test can drive the claim and the item-domain
      // fallback independently. The advisory-lock execute ignores its result,
      // so it can share the claim's shape. Returning `{ rows: [...] }` rather
      // than `[]` matters: without it every create here would consume a
      // positional `queue` entry for a read the real code skips.
      const text = sqlTextOf(q);
      // Discriminate on `SELECT DISTINCT`, not on `FROM items` — the claim's
      // own `NOT EXISTS (SELECT 1 FROM items WHERE created_by = …)` guard
      // matches the looser pattern.
      if (text.includes('SELECT DISTINCT item_domain')) {
        return Promise.resolve(state.itemDomains);
      }
      if (text.includes('SELECT domains FROM')) {
        return Promise.resolve(state.heldColumn);
      }
      return Promise.resolve(state.domainClaim);
    },
    insert: (table: unknown) => ({
      values: (values: Row) => {
        rec.order.push('insert');
        rec.inserts.push({ table, values });
        return {
          onConflictDoNothing: (o?: unknown) => {
            rec.conflicts.push(o);
            return { returning: (_cols?: Row) => next() };
          },
          onConflictDoUpdate: (o?: unknown) => {
            rec.conflicts.push(o);
            return Promise.resolve([]);
          },
          returning: (_cols?: Row) => next(),
        };
      },
    }),
    update: (_table: unknown) => ({
      set: (values: Row) => ({
        where: (w: unknown) => {
          rec.order.push('update');
          rec.updates.push({ set: values, where: w });
          return {
            then: (res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) =>
              Promise.resolve([] as Row[]).then(res, rej),
            returning: (_cols?: Row) => next(),
          };
        },
      }),
    }),
  };

  return { exec: exec as unknown as DbOrTx, rec, queue, state };
}

const ROW = { itemNetwork: 'blue_dot', itemDomain: 'student', itemType: 'profile_1.0', itemId: 'i1' };

/** The SQL text of a statement captured off the mocked `sql` tag (`drizzle-orm`
 * mock above joins the template strings with `?` for the interpolations). */
const sqlTextOf = (q: unknown): string => (q as { text?: string }).text ?? '';

function setDefaults() {
  getCurrentApiBaseUrl.mockReturnValue('https://api.test');
  isServedDomainBinding.mockReturnValue(true);
  getNetworkConfigById.mockResolvedValue({ domains: [{ id: 'student' }] });
  getDomainItemTypes.mockReturnValue(['profile_1.0']);
  getDomainItemSchema.mockReturnValue({ required: ['name'] });
  getInstanceCustomItemSchemaUrl.mockReturnValue(undefined);
  buildNetworkItemSchemaUrl.mockReturnValue('https://cfg.test/schema/profile_1.0');
  getOrFetchSchemaByUrl.mockResolvedValue({ required: ['name'] });
  validateAgainstJsonSchema.mockImplementation(() => undefined);
  splitItemStateByPrivacy.mockImplementation((_s: unknown, state: Row) => ({
    publicState: state,
    privateState: {},
  }));
  maskPrivateState.mockReturnValue({});
  mergeMasksIntoPublic.mockImplementation((pub: Row, masks: Row) => ({ ...pub, ...masks }));
  mergeItemStateWithPrivate.mockImplementation((pub: Row, priv: Row) => ({ ...pub, ...priv }));
  primaryAddressChanged.mockReturnValue(false);
  isPrimaryAddressBlank.mockReturnValue(false);
  isLocationFieldPrivate.mockReturnValue(false);
  classify_item.mockReturnValue({ lifecycle_status: 'draft' });
  hasAcceptedProfileConsent.mockResolvedValue(false);
  is_populated.mockImplementation((v: unknown) => v !== undefined && v !== null && v !== '');
  encryptPiiBlob.mockImplementation((plain: string) => `enc:${plain}`);
  decryptPiiBlob.mockImplementation((blob: string) => blob.replace(/^enc:/, ''));
  getPiiKey.mockReturnValue('pii-key');
  jitterCoordinate.mockImplementation((loc: ItemLocation) => ({ ...loc, lat: loc.lat + 0.001 }));
  geocodeLocationsFromState.mockResolvedValue([]);
  guardianConsentRequired.mockReturnValue(false);
  guardianProfileConsentRow.mockImplementation((args: { userId: string; itemId: string }) => ({
    userId: args.userId,
    itemId: args.itemId,
    source: 'guardian',
  }));
  apiConfig.allow_extra_schema_data = false;
  apiConfig.max_profiles_per_user = 3;
}

beforeEach(() => {
  vi.resetAllMocks();
  setDefaults();
});

const createParams = (over: Partial<Parameters<typeof createItemInternal>[1]> = {}) => ({
  item_network: 'blue_dot',
  item_domain: 'student',
  item_type: 'profile_1.0',
  created_by: 'u1',
  ...over,
});

// ---------------------------------------------------------------------------
describe('primaryLocation', () => {
  it('returns the first location', () => {
    expect(primaryLocation([{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }])).toEqual({ lat: 1, lng: 2 });
  });

  it('returns null for empty / null / undefined', () => {
    expect(primaryLocation([])).toBeNull();
    expect(primaryLocation(null)).toBeNull();
    expect(primaryLocation(undefined)).toBeNull();
  });
});

describe('sameLocations', () => {
  it('is true for identical arrays including labels', () => {
    expect(
      sameLocations([{ lat: 1, lng: 2, label: 'x' }], [{ lat: 1, lng: 2, label: 'x' }]),
    ).toBe(true);
  });

  it('treats a missing label as equal to an undefined label', () => {
    expect(sameLocations([{ lat: 1, lng: 2 }], [{ lat: 1, lng: 2, label: undefined }])).toBe(true);
  });

  it('is false on length, coordinate or label differences', () => {
    expect(sameLocations([{ lat: 1, lng: 2 }], [])).toBe(false);
    expect(sameLocations([{ lat: 1, lng: 2 }], [{ lat: 1, lng: 9 }])).toBe(false);
    expect(sameLocations([{ lat: 1, lng: 2 }], [{ lat: 9, lng: 2 }])).toBe(false);
    expect(
      sameLocations([{ lat: 1, lng: 2, label: 'a' }], [{ lat: 1, lng: 2, label: 'b' }]),
    ).toBe(false);
  });

  it('is order-sensitive', () => {
    const a = [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }];
    const b = [{ lat: 2, lng: 2 }, { lat: 1, lng: 1 }];
    expect(sameLocations(a, b)).toBe(false);
  });
});

describe('jitterPrivateLocations', () => {
  it('jitters every point of a PRIVATE location field with the configured annulus + PII key', () => {
    isLocationFieldPrivate.mockReturnValue(true);

    const out = jitterPrivateLocations([{ lat: 10, lng: 20 }, { lat: 30, lng: 40 }], { x: 1 });

    expect(out).toEqual([{ lat: 10.001, lng: 20 }, { lat: 30.001, lng: 40 }]);
    expect(jitterCoordinate).toHaveBeenCalledTimes(2);
    expect(jitterCoordinate).toHaveBeenNthCalledWith(1, { lat: 10, lng: 20 }, 100, 250, 'pii-key');
  });

  it('returns non-private locations unchanged', () => {
    isLocationFieldPrivate.mockReturnValue(false);
    const locs = [{ lat: 10, lng: 20 }];
    expect(jitterPrivateLocations(locs, { x: 1 })).toBe(locs);
    expect(jitterCoordinate).not.toHaveBeenCalled();
  });

  it('short-circuits on an empty list or a missing schema', () => {
    isLocationFieldPrivate.mockReturnValue(true);
    expect(jitterPrivateLocations([], { x: 1 })).toEqual([]);
    expect(jitterPrivateLocations([{ lat: 1, lng: 2 }], null)).toEqual([{ lat: 1, lng: 2 }]);
    expect(jitterPrivateLocations([{ lat: 1, lng: 2 }], undefined)).toEqual([{ lat: 1, lng: 2 }]);
    expect(jitterCoordinate).not.toHaveBeenCalled();
  });
});

describe('isItemOwnedBy', () => {
  const ref = { network: 'blue_dot', item_domain: 'student', item_type: 'profile_1.0', item_id: 'i1' };

  it('is true when the ownership-scoped query returns a row', async () => {
    const { exec, queue, rec } = makeExec();
    queue.push([{ created_by: 'u1' }]);

    await expect(isItemOwnedBy('u1', ref, exec)).resolves.toBe(true);
    // Partition-pruning columns + created_by are all part of the filter.
    expect(JSON.stringify(rec.selectWheres[0])).toContain('items.created_by');
    expect(JSON.stringify(rec.selectWheres[0])).toContain('items.item_network');
  });

  it('is false when no row matches', async () => {
    const { exec } = makeExec();
    await expect(isItemOwnedBy('u2', ref, exec)).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('createItemInternal — schema resolution guards', () => {
  it('400 UNSERVED_DOMAIN when the (network, domain) binding is not served', async () => {
    isServedDomainBinding.mockReturnValue(false);
    const { exec } = makeExec();

    await expect(createItemInternal(exec, createParams())).rejects.toMatchObject({
      statusCode: 400,
      errorCode: 'UNSERVED_DOMAIN',
    });
  });

  it('400 INVALID_ITEM_STATE forwarding the network-config error message', async () => {
    getNetworkConfigById.mockRejectedValue(new Error('no such network'));
    const { exec } = makeExec();

    await expect(createItemInternal(exec, createParams())).rejects.toMatchObject({
      statusCode: 400,
      errorCode: 'INVALID_ITEM_STATE',
      message: 'no such network',
    });
  });

  it('400 INVALID_ITEM_STATE when the item_type is not declared for the domain', async () => {
    getDomainItemTypes.mockReturnValue(['post_1.0']);
    const { exec } = makeExec();

    await expect(
      createItemInternal(exec, createParams()),
    ).rejects.toThrow(/Item type "profile_1.0" is not defined for domain "student"/);
  });

  it('400 INVALID_ITEM_STATE when item_state fails schema validation', async () => {
    validateAgainstJsonSchema.mockImplementation(() => {
      throw new Error('name must be a string');
    });
    const { exec } = makeExec();

    await expect(
      createItemInternal(exec, createParams({ item_state: { name: 7 } })),
    ).rejects.toMatchObject({ statusCode: 400, errorCode: 'INVALID_ITEM_STATE' });
  });

  it('validates with allowAdditionalProperties from config and required keys ignored', async () => {
    apiConfig.allow_extra_schema_data = true;
    getDomainItemSchema.mockReturnValue({ required: ['name', 'age'] });
    const { exec, queue } = makeExec();
    queue.push([{ n: 0 }]);
    queue.push([ROW]);

    await createItemInternal(exec, createParams({ item_state: { name: 'a' } }));

    expect(validateAgainstJsonSchema).toHaveBeenCalledWith(
      { required: ['name', 'age'] },
      { name: 'a' },
      'item_state',
      { allowAdditionalProperties: true, ignoredKeys: ['name', 'age'] },
    );
  });
});

describe('createItemInternal — backend-generated URLs', () => {
  it('generates item_instance_url + item_schema_url and ignores any client-supplied values', async () => {
    // A client cannot set these: they are not part of the service params, and
    // even smuggled through they must never reach the insert.
    const { exec, queue, rec } = makeExec();
    queue.push([{ n: 0 }]);
    queue.push([ROW]);

    const smuggled = {
      ...createParams(),
      item_instance_url: 'https://evil.example',
      item_schema_url: 'https://evil.example/schema',
    };
    await createItemInternal(exec, smuggled);

    expect(rec.inserts[0].values.item_instance_url).toBe('https://api.test');
    expect(rec.inserts[0].values.item_schema_url).toBe('https://cfg.test/schema/profile_1.0');
  });

  it('falls back to the instance-local schema URL when the network config has none', async () => {
    buildNetworkItemSchemaUrl.mockReturnValue(null);
    const { exec, queue, rec } = makeExec();
    queue.push([{ n: 0 }]);
    queue.push([ROW]);

    await createItemInternal(exec, createParams());

    expect(rec.inserts[0].values.item_schema_url).toBe(
      'https://api.test/api/v1/network/schema/blue_dot/student/profile_1.0',
    );
  });

  it('prefers an instance-custom schema URL and fetches that schema', async () => {
    getInstanceCustomItemSchemaUrl.mockReturnValue('https://api.test/custom/profile_1.0');
    getOrFetchSchemaByUrl.mockResolvedValue({ required: ['nickname'] });
    const { exec, queue, rec } = makeExec();
    queue.push([{ n: 0 }]);
    queue.push([ROW]);

    await createItemInternal(exec, createParams());

    expect(getOrFetchSchemaByUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaUrl: 'https://api.test/custom/profile_1.0',
        kind: 'instance_custom_item_schema',
      }),
    );
    expect(rec.inserts[0].values.item_schema_url).toBe('https://api.test/custom/profile_1.0');
    // The network-config schema is not consulted when a custom one resolved.
    expect(getDomainItemSchema).not.toHaveBeenCalled();
  });

  it('falls back to the network-config schema when the custom fetch yields nothing', async () => {
    getInstanceCustomItemSchemaUrl.mockReturnValue('https://api.test/custom/profile_1.0');
    getOrFetchSchemaByUrl.mockResolvedValue(null);
    const { exec, queue, rec } = makeExec();
    queue.push([{ n: 0 }]);
    queue.push([ROW]);

    await createItemInternal(exec, createParams());

    expect(getDomainItemSchema).toHaveBeenCalled();
    expect(rec.inserts[0].values.item_schema_url).toBe('https://cfg.test/schema/profile_1.0');
  });
});

describe('createItemInternal — single-domain lock', () => {
  // These assert the SQL of the claim, not just that *something* ran.
  //
  // A review found the recording half was entirely unpinned: replacing the
  // UPDATE with `SET domains = ARRAY['WRONG'] WHERE id = 'not-a-real-user'`,
  // guard deleted, still passed 161/161 tests. `rec.order` cannot tell the
  // claim apart from `assertProfileLimit`'s advisory lock — both are
  // `'execute'` — so an order-only assertion is satisfied by a no-op body.
  it('claims the domain with a guarded, caller-scoped UPDATE', async () => {
    const { exec, queue, rec } = makeExec();
    queue.push([{ n: 0 }]);
    queue.push([ROW]);

    await createItemInternal(exec, createParams());

    const claim = rec.executes[0] as { sql?: string; queryChunks?: unknown[]; values: unknown[] };
    const text = sqlTextOf(claim);
    expect(text).toMatch(/UPDATE "user"/);
    expect(text).toMatch(/SET domains = ARRAY/);
    // Write-once at the database level: a later create can never re-point an
    // existing lock, so moving someone stays an explicit operation.
    expect(text).toMatch(/domains IS NULL OR cardinality\(domains\) = 0/);
    // Correct before migration 0015 has run — see assertSingleDomain's note on
    // the post-upgrade deploy window.
    expect(text).toMatch(/NOT EXISTS \(SELECT 1 FROM items WHERE created_by =/);
    expect(text).toMatch(/RETURNING id/);
    // The domain being claimed, and the user it is scoped to.
    expect(claim.values).toContain('student');
    expect(claim.values).toContain('u1');
  });

  it('claiming successfully skips the follow-up read entirely', async () => {
    const { exec, queue, rec } = makeExec();
    queue.push([{ n: 0 }]);
    queue.push([ROW]);

    await createItemInternal(exec, createParams());

    // The claim returning a row IS the verdict — no SELECT on `user`, and no
    // read of `items`. The one select here is the profile cap's count.
    expect(rec.order.filter((o) => o === 'select')).toHaveLength(1);
    expect(rec.executes).toHaveLength(2); // claim + the cap's advisory lock
  });

  it('falls back to the item domains when the column is empty (pre-0015 rows)', async () => {
    // `admin/participant` never wrote `user.domains`, so a legacy participant
    // can hold a seeker profile with an empty column. The claim declines
    // (NOT EXISTS items fails), and the truth comes off `items`.
    const { exec, queue, rec, state } = makeExec();
    state.domainClaim = { rows: [] };
    state.heldColumn = { rows: [{ domains: [] }] }; // column read: empty
    state.itemDomains = { rows: [{ item_domain: 'seeker' }] };

    await expect(
      createItemInternal(exec, createParams({ item_domain: 'provider' })),
    ).rejects.toMatchObject({
      statusCode: 403,
      errorCode: 'DOMAIN_LOCKED',
      details: { locked_domain: 'seeker', requested_domain: 'provider' },
    });

    const fallback = sqlTextOf(
      rec.executes[rec.executes.length - 1] as { queryChunks?: unknown[] },
    );
    expect(fallback).toMatch(/SELECT DISTINCT item_domain FROM items/);
  });

  it('the item-domain fallback allows a create in the held domain', async () => {
    const { exec, queue, state } = makeExec();
    state.domainClaim = { rows: [] };
    state.heldColumn = { rows: [{ domains: [] }] };
    state.itemDomains = { rows: [{ item_domain: 'student' }] };
    queue.push([{ n: 0 }]);
    queue.push([ROW]);

    await expect(
      createItemInternal(exec, createParams()),
    ).resolves.toMatchObject({ itemId: ROW.itemId });
  });

  it('allows a create in the domain the user is already locked to', async () => {
    const { exec, queue, state } = makeExec();
    state.domainClaim = { rows: [] }; // already locked → claim writes nothing
    state.heldColumn = { rows: [{ domains: ['student'] }] };
    queue.push([{ n: 0 }]); // profile-cap count
    queue.push([ROW]);

    await expect(
      createItemInternal(exec, createParams()),
    ).resolves.toMatchObject({ itemId: ROW.itemId });
  });

  it('403 DOMAIN_LOCKED for a create in a different domain', async () => {
    const { exec, queue, state } = makeExec();
    state.domainClaim = { rows: [] };
    state.heldColumn = { rows: [{ domains: ['employer'] }] }; // createParams defaults to 'student'

    await expect(createItemInternal(exec, createParams())).rejects.toMatchObject({
      statusCode: 403,
      errorCode: 'DOMAIN_LOCKED',
      // The UI reads these off the body — see create_item.ts's error mapper.
      details: { locked_domain: 'employer', requested_domain: 'student' },
    });
  });

  it('rejects the SECOND domain, whichever one it is', async () => {
    const { exec, queue, state } = makeExec();
    state.domainClaim = { rows: [] };
    state.heldColumn = { rows: [{ domains: ['seeker'] }] };

    await expect(
      createItemInternal(exec, createParams({ item_domain: 'service_provider' })),
    ).rejects.toMatchObject({
      statusCode: 403,
      errorCode: 'DOMAIN_LOCKED',
      details: { locked_domain: 'seeker', requested_domain: 'service_provider' },
    });
  });

  it('allows a multi-domain legacy user in either of their recorded domains', async () => {
    // Migration 0015 backfills BOTH domains for a user who already held items
    // in two. The lock must not retroactively break them — it exists to stop
    // NEW ones. `includes`, not `[0] ===`.
    const { exec, queue, state } = makeExec();
    state.domainClaim = { rows: [] };
    state.heldColumn = { rows: [{ domains: ['seeker', 'provider'] }] };
    queue.push([{ n: 0 }]);
    queue.push([ROW]);

    await expect(
      createItemInternal(exec, createParams({ item_domain: 'provider' })),
    ).resolves.toMatchObject({ itemId: ROW.itemId });
  });

  it('lets a missing user row fall through to the items FK, not DOMAIN_LOCKED', async () => {
    const { exec, queue, state } = makeExec();
    state.domainClaim = { rows: [] }; // no row matched: user does not exist
    state.heldColumn = { rows: [] }; // the column read finds nothing either
    queue.push([{ n: 0 }]);
    queue.push([ROW]);

    // Reporting "you are registered as undefined" would be worse than letting
    // the foreign key say what is actually wrong.
    await expect(
      createItemInternal(exec, createParams()),
    ).resolves.toMatchObject({ itemId: ROW.itemId });
  });
});

describe('createItemInternal — profile cap', () => {
  it('takes a transaction advisory lock on the (user, network, domain, type) scope before counting', async () => {
    const { exec, queue, rec } = makeExec();
    queue.push([{ n: 1 }]);
    queue.push([ROW]);

    await createItemInternal(exec, createParams());

    // executes[0] is assertSingleDomain's domain claim, which runs first by
    // design (see the ordering note at its call site); the cap's advisory lock
    // is executes[1].
    expect(rec.order.slice(0, 3)).toEqual(['execute', 'execute', 'select']);
    expect(rec.executes[1]).toMatchObject({
      values: ['u1:blue_dot:student:profile_1.0'],
    });
  });

  it('409 PROFILE_LIMIT_REACHED at the global cap', async () => {
    apiConfig.max_profiles_per_user = 2;
    const { exec, queue } = makeExec();
    queue.push([{ n: 2 }]);

    await expect(createItemInternal(exec, createParams())).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'PROFILE_LIMIT_REACHED',
    });
  });

  it("prefers the domain's max_profiles_per_user over the global default", async () => {
    apiConfig.max_profiles_per_user = 50;
    getNetworkConfigById.mockResolvedValue({
      domains: [{ id: 'student', max_profiles_per_user: 1 }],
    });
    const { exec, queue } = makeExec();
    queue.push([{ n: 1 }]);

    await expect(createItemInternal(exec, createParams())).rejects.toThrow(
      /maximum of 1 student profile\(s\)/,
    );
  });

  it('treats a non-finite cap as no cap (no lock, no count)', async () => {
    apiConfig.max_profiles_per_user = Number.POSITIVE_INFINITY;
    const { exec, queue, rec } = makeExec();
    queue.push([ROW]);

    await createItemInternal(exec, createParams());

    // The one execute is assertSingleDomain's domain claim, which is not part
    // of the cap and is never skipped. No advisory lock, no count.
    expect(rec.executes).toHaveLength(1);
    expect(rec.order).toEqual(['execute', 'insert']);
  });

  it('skips the cap entirely for trusted callers (skip_profile_limit)', async () => {
    const { exec, queue, rec } = makeExec();
    queue.push([ROW]);

    await createItemInternal(exec, createParams({ skip_profile_limit: true }));

    // `skip_profile_limit` skips the cap only. The single-domain lock has no
    // opt-out — it underwrites per-domain default aggregators, so a trusted
    // caller must not be able to introduce a second domain either.
    expect(rec.executes).toHaveLength(1);
    expect(rec.order).toEqual(['execute', 'insert']);
  });

  it('counts with no cap when the network config cannot be read', async () => {
    // resolveProfileLimit swallows the config error and uses the global default.
    apiConfig.max_profiles_per_user = 1;
    getNetworkConfigById
      .mockResolvedValueOnce({ domains: [{ id: 'student' }] })
      .mockRejectedValueOnce(new Error('config down'));
    const { exec, queue } = makeExec();
    queue.push([{ n: 1 }]);

    await expect(createItemInternal(exec, createParams())).rejects.toMatchObject({
      errorCode: 'PROFILE_LIMIT_REACHED',
    });
  });
});

describe('createItemInternal — storage shape', () => {
  it('stores masked public state, encrypts the private blob and jitters private coords', async () => {
    splitItemStateByPrivacy.mockReturnValue({
      publicState: { name: 'Asha' },
      privateState: { phone: '9990001111' },
    });
    maskPrivateState.mockReturnValue({ phone: '***' });
    isLocationFieldPrivate.mockReturnValue(true);
    classify_item.mockReturnValue({ lifecycle_status: 'live' });
    const { exec, queue, rec } = makeExec();
    queue.push([{ n: 0 }]);
    queue.push([ROW]);

    const out = await createItemInternal(
      exec,
      createParams({
        item_state: { name: 'Asha', phone: '9990001111' },
        item_locations: [{ lat: 12.9, lng: 77.6, label: 'home' }],
        consent_accepted: true,
      }),
    );

    const values = rec.inserts[0].values;
    expect(values.item_state).toEqual({ name: 'Asha', phone: '***' });
    expect(values.item_private_state).toBe('enc:{"phone":"9990001111"}');
    expect(values.item_locations).toEqual([{ lat: 12.901, lng: 77.6, label: 'home' }]);
    expect(values.lifecycle_status).toBe('live');
    expect(out).toEqual(ROW);
  });

  it('stores an empty private blob (no encryption) when nothing is private', async () => {
    const { exec, queue, rec } = makeExec();
    queue.push([{ n: 0 }]);
    queue.push([ROW]);

    await createItemInternal(exec, createParams({ item_state: { name: 'Asha' } }));

    expect(rec.inserts[0].values.item_private_state).toBe('');
    expect(encryptPiiBlob).not.toHaveBeenCalled();
  });

  it('classifies against the SUBMITTED state, current_status draft and consent_accepted defaulting to false', async () => {
    const { exec, queue } = makeExec();
    queue.push([{ n: 0 }]);
    queue.push([ROW]);

    await createItemInternal(exec, createParams({ item_state: { name: 'Asha' } }));

    expect(classify_item).toHaveBeenCalledWith(
      expect.objectContaining({
        schema: { required: ['name'] },
        merged_state: { name: 'Asha' },
        current_status: 'draft',
        consent_accepted: false,
      }),
    );
  });

  it('defaults item_state to {} and item_locations to []', async () => {
    const { exec, queue, rec } = makeExec();
    queue.push([{ n: 0 }]);
    queue.push([ROW]);

    await createItemInternal(exec, createParams());

    expect(rec.inserts[0].values.item_locations).toEqual([]);
    expect(splitItemStateByPrivacy).toHaveBeenCalledWith({ required: ['name'] }, {});
  });

  it('409 ITEM_ALREADY_EXISTS when the insert conflicted (returning nothing)', async () => {
    const { exec, queue } = makeExec();
    queue.push([{ n: 0 }]);
    queue.push([]);

    await expect(createItemInternal(exec, createParams())).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'ITEM_ALREADY_EXISTS',
    });
  });
});

// ---------------------------------------------------------------------------
describe('guardianGateBlocksGoLive', () => {
  const item = {
    item_network: 'blue_dot',
    item_domain: 'student',
    item_id: 'i1',
    created_by: 'u1',
  };

  it('never blocks on a non-gated domain (no age query at all)', async () => {
    const { exec, rec } = makeExec();
    await expect(guardianGateBlocksGoLive(exec, item)).resolves.toBe(false);
    expect(rec.selectWheres).toHaveLength(0);
  });

  it('fails closed when the ward has no stored age', async () => {
    guardianConsentRequired.mockReturnValue(true);
    const { exec, queue } = makeExec();
    queue.push([{ age: null }]);

    await expect(guardianGateBlocksGoLive(exec, item)).resolves.toBe(true);
  });

  it('fails closed when the ward row is missing entirely', async () => {
    guardianConsentRequired.mockReturnValue(true);
    const { exec } = makeExec();

    await expect(guardianGateBlocksGoLive(exec, item)).resolves.toBe(true);
  });

  it('never blocks a proven adult', async () => {
    guardianConsentRequired.mockReturnValue(true);
    const { exec, queue, rec } = makeExec();
    queue.push([{ age: 25 }]);

    await expect(guardianGateBlocksGoLive(exec, item)).resolves.toBe(false);
    expect(rec.selectWheres).toHaveLength(1); // no consent lookup for an adult
  });

  it('blocks a minor with no source=guardian profile_creation row', async () => {
    guardianConsentRequired.mockReturnValue(true);
    const { exec, queue, rec } = makeExec();
    queue.push([{ age: 15 }]);
    queue.push([]);

    await expect(guardianGateBlocksGoLive(exec, item)).resolves.toBe(true);
    // The consent lookup is source-scoped: a self row must not satisfy the gate.
    expect(JSON.stringify(rec.selectWheres[1])).toContain('guardian');
  });

  it('allows a minor once a guardian row exists', async () => {
    guardianConsentRequired.mockReturnValue(true);
    const { exec, queue } = makeExec();
    queue.push([{ age: 15 }]);
    queue.push([{ id: 'c1' }]);

    await expect(guardianGateBlocksGoLive(exec, item)).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
const draftItem = {
  item_id: 'i1',
  item_network: 'blue_dot',
  item_domain: 'student',
  item_type: 'profile_1.0',
  item_schema_url: 'https://cfg.test/schema/profile_1.0',
  item_state: { name: 'Asha' },
  item_private_state: '',
  lifecycle_status: 'draft',
  created_by: 'u1',
};

describe('promoteItemOnProfileConsent', () => {
  it('promotes a complete draft to live', async () => {
    classify_item.mockReturnValue({ lifecycle_status: 'live' });
    const { exec, queue, rec } = makeExec();
    queue.push([draftItem]);

    await expect(promoteItemOnProfileConsent(exec, 'i1')).resolves.toBe(true);
    expect(rec.updates[0].set).toMatchObject({ lifecycle_status: 'live' });
    expect(classify_item).toHaveBeenCalledWith(
      expect.objectContaining({ current_status: 'draft', consent_accepted: true }),
    );
  });

  it('returns false when the item does not exist', async () => {
    const { exec, rec } = makeExec();
    await expect(promoteItemOnProfileConsent(exec, 'missing')).resolves.toBe(false);
    expect(rec.updates).toHaveLength(0);
  });

  it('leaves a paused item alone (paused is sticky)', async () => {
    const { exec, queue, rec } = makeExec();
    queue.push([{ ...draftItem, lifecycle_status: 'paused' }]);

    await expect(promoteItemOnProfileConsent(exec, 'i1')).resolves.toBe(false);
    expect(rec.updates).toHaveLength(0);
    expect(classify_item).not.toHaveBeenCalled();
  });

  it('returns false when the item is still incomplete', async () => {
    classify_item.mockReturnValue({ lifecycle_status: 'draft' });
    const { exec, queue, rec } = makeExec();
    queue.push([draftItem]);

    await expect(promoteItemOnProfileConsent(exec, 'i1')).resolves.toBe(false);
    expect(rec.updates).toHaveLength(0);
  });

  it('decrypts the private blob and classifies against the merged full state', async () => {
    classify_item.mockReturnValue({ lifecycle_status: 'live' });
    const { exec, queue } = makeExec();
    queue.push([{ ...draftItem, item_private_state: 'enc:{"phone":"999"}' }]);

    await promoteItemOnProfileConsent(exec, 'i1');

    expect(decryptPiiBlob).toHaveBeenCalledWith('enc:{"phone":"999"}', 'pii-key');
    expect(classify_item).toHaveBeenCalledWith(
      expect.objectContaining({ merged_state: { name: 'Asha', phone: '999' } }),
    );
  });

  it('folds the U18 guardian block into consent_accepted=false, keeping a gated minor draft', async () => {
    // Under the config-driven gates model the guardian check is folded into
    // consent_accepted (not a separate post-classify override). A gated minor
    // with no guardian row → consent_accepted:false → the consent_required gate
    // fails → the real classifier returns draft (mocked here) → promote is a no-op.
    classify_item.mockReturnValue({ lifecycle_status: 'draft' });
    guardianConsentRequired.mockReturnValue(true);
    const { exec, queue, rec } = makeExec();
    queue.push([draftItem]);
    queue.push([{ age: 15 }]);
    queue.push([]); // no guardian consent row

    await expect(promoteItemOnProfileConsent(exec, 'i1')).resolves.toBe(false);
    expect(rec.updates).toHaveLength(0);
    expect(classify_item).toHaveBeenCalledWith(
      expect.objectContaining({ consent_accepted: false }),
    );
  });
});

describe('upsertGuardianProfileConsentAndPromote', () => {
  it('upserts a source=guardian row then promotes the item', async () => {
    classify_item.mockReturnValue({ lifecycle_status: 'live' });
    const { exec, queue, rec } = makeExec();
    queue.push([draftItem]);

    const promoted = await upsertGuardianProfileConsentAndPromote(exec, {
      userId: 'u1',
      itemId: 'i1',
      network: 'blue_dot',
      documentVersion: 2,
    });

    expect(promoted).toBe(true);
    expect(rec.inserts[0].values).toEqual({ userId: 'u1', itemId: 'i1', source: 'guardian' });
    // Idempotent on a repeat guardian acceptance for the same item.
    expect(JSON.stringify(rec.conflicts[0])).toContain('cr.source');
    expect(rec.updates[0].set).toMatchObject({ lifecycle_status: 'live' });
  });

  it('returns false when the item cannot be promoted, without failing the upsert', async () => {
    const { exec, rec } = makeExec();

    await expect(
      upsertGuardianProfileConsentAndPromote(exec, {
        userId: 'u1',
        itemId: 'gone',
        network: 'blue_dot',
        documentVersion: 1,
      }),
    ).resolves.toBe(false);
    expect(rec.inserts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
const existingItem = {
  item_id: 'i1',
  item_network: 'blue_dot',
  item_domain: 'student',
  item_type: 'profile_1.0',
  item_schema_url: 'https://cfg.test/schema/profile_1.0',
  item_state: { name: 'Asha' },
  item_private_state: '',
  lifecycle_status: 'draft',
  created_by: 'u1',
  item_locations: [] as ItemLocation[],
};

const updatedRow = { item_id: 'i1', lifecycle_status: 'draft' };

describe('updateItemInternal — ownership scoping', () => {
  it('scopes a non-admin update on created_by as well as the item id', async () => {
    const { exec, queue, rec } = makeExec();
    queue.push([updatedRow]);

    await updateItemInternal(exec, 'i1', 'u1', false, {});

    expect(rec.updates[0].where).toEqual({
      op: 'and',
      conds: [
        { op: 'eq', col: 'items.item_id', val: 'i1' },
        { op: 'eq', col: 'items.created_by', val: 'u1' },
      ],
    });
  });

  it('scopes an admin update on the item id only', async () => {
    const { exec, queue, rec } = makeExec();
    queue.push([updatedRow]);

    await updateItemInternal(exec, 'i1', 'admin', true, {});

    expect(rec.updates[0].where).toEqual({ op: 'eq', col: 'items.item_id', val: 'i1' });
  });

  it('only bumps updated_at when neither state nor locations are supplied', async () => {
    const { exec, queue, rec } = makeExec();
    queue.push([updatedRow]);

    const res = await updateItemInternal(exec, 'i1', 'u1', false, {});

    expect(Object.keys(rec.updates[0].set)).toEqual(['updated_at']);
    expect(rec.selectWheres).toHaveLength(0); // no pre-read needed
    expect(res.row).toEqual(updatedRow);
  });

  it('404 ITEM_NOT_FOUND_OR_FORBIDDEN when the update returns no row', async () => {
    const { exec } = makeExec();

    await expect(updateItemInternal(exec, 'i1', 'u1', false, {})).rejects.toMatchObject({
      statusCode: 404,
      errorCode: 'ITEM_NOT_FOUND_OR_FORBIDDEN',
    });
  });

  it('404 ITEM_NOT_FOUND_OR_FORBIDDEN when the pre-read finds nothing', async () => {
    const { exec } = makeExec();

    await expect(
      updateItemInternal(exec, 'i1', 'u1', false, { item_state: { name: 'B' } }),
    ).rejects.toMatchObject({ statusCode: 404, errorCode: 'ITEM_NOT_FOUND_OR_FORBIDDEN' });
  });
});

describe('updateItemInternal — state edits', () => {
  it('409 ITEM_RETIRED — a retired item can never be re-edited (retire is terminal)', async () => {
    const { exec, queue } = makeExec();
    queue.push([{ ...existingItem, lifecycle_status: 'retired' }]);

    await expect(
      updateItemInternal(exec, 'i1', 'u1', false, { item_state: { name: 'B' } }),
    ).rejects.toMatchObject({ statusCode: 409, errorCode: 'ITEM_RETIRED' });
    expect(encryptPiiBlob).not.toHaveBeenCalled();
  });

  it('merges the partial update over the decrypted prior full state', async () => {
    const { exec, queue } = makeExec();
    queue.push([{ ...existingItem, item_private_state: 'enc:{"phone":"111"}' }]);
    queue.push([updatedRow]);

    await updateItemInternal(exec, 'i1', 'u1', false, { item_state: { name: 'Bee' } });

    expect(decryptPiiBlob).toHaveBeenCalledWith('enc:{"phone":"111"}', 'pii-key');
    expect(validateAgainstJsonSchema).toHaveBeenCalledWith(
      { required: ['name'] },
      { name: 'Bee', phone: '111' },
      'item_state',
      { allowAdditionalProperties: false, ignoredKeys: ['name'] },
    );
  });

  it('400 INVALID_ITEM_STATE when the merged state fails validation', async () => {
    validateAgainstJsonSchema.mockImplementation(() => {
      throw new Error('bad name');
    });
    const { exec, queue } = makeExec();
    queue.push([existingItem]);

    await expect(
      updateItemInternal(exec, 'i1', 'u1', false, { item_state: { name: 7 } }),
    ).rejects.toMatchObject({
      statusCode: 400,
      errorCode: 'INVALID_ITEM_STATE',
      message: 'bad name',
    });
  });

  it('409 REQUIRED_FIELD_LOCKED_WHILE_LIVE when a live item would lose a required field', async () => {
    const { exec, queue } = makeExec();
    queue.push([{ ...existingItem, lifecycle_status: 'live' }]);

    await expect(
      updateItemInternal(exec, 'i1', 'u1', false, { item_state: { name: '' } }),
    ).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'REQUIRED_FIELD_LOCKED_WHILE_LIVE',
    });
  });

  it('allows blanking a required field while still draft (latch is live-only)', async () => {
    const { exec, queue, rec } = makeExec();
    queue.push([existingItem]);
    queue.push([updatedRow]);

    await updateItemInternal(exec, 'i1', 'u1', false, { item_state: { name: '' } });

    expect(rec.updates).toHaveLength(1);
  });

  it('re-masks + re-encrypts the private blob on a state edit', async () => {
    splitItemStateByPrivacy.mockReturnValue({
      publicState: { name: 'Bee' },
      privateState: { phone: '222' },
    });
    maskPrivateState.mockReturnValue({ phone: '***' });
    const { exec, queue, rec } = makeExec();
    queue.push([existingItem]);
    queue.push([updatedRow]);

    await updateItemInternal(exec, 'i1', 'u1', false, { item_state: { name: 'Bee' } });

    expect(rec.updates[0].set.item_state).toEqual({ name: 'Bee', phone: '***' });
    expect(rec.updates[0].set.item_private_state).toBe('enc:{"phone":"222"}');
  });

  it('clears the private blob when no private fields remain', async () => {
    const { exec, queue, rec } = makeExec();
    queue.push([existingItem]);
    queue.push([updatedRow]);

    await updateItemInternal(exec, 'i1', 'u1', false, { item_state: { name: 'Bee' } });

    expect(rec.updates[0].set.item_private_state).toBe('');
  });

  it('takes the classifier lifecycle when the guardian gate does not apply', async () => {
    hasAcceptedProfileConsent.mockResolvedValue(true);
    classify_item.mockReturnValue({ lifecycle_status: 'live' });
    const { exec, queue, rec } = makeExec();
    queue.push([existingItem]);
    queue.push([updatedRow]);

    await updateItemInternal(exec, 'i1', 'u1', false, { item_state: { name: 'Bee' } });

    expect(rec.updates[0].set.lifecycle_status).toBe('live');
    expect(classify_item).toHaveBeenCalledWith(
      expect.objectContaining({ current_status: 'draft', consent_accepted: true }),
    );
  });

  it('keeps a gated minor draft even though a self-consent row exists (#311)', async () => {
    // A source-agnostic self-consent row must NOT satisfy the gate for a gated
    // minor: the guardian block folds into consent_accepted:false, so the gate
    // fails and the real classifier stays draft (mocked here).
    hasAcceptedProfileConsent.mockResolvedValue(true);
    classify_item.mockReturnValue({ lifecycle_status: 'draft' });
    guardianConsentRequired.mockReturnValue(true);
    const { exec, queue, rec } = makeExec();
    queue.push([existingItem]);
    queue.push([{ age: 15 }]);
    queue.push([]); // no guardian row
    queue.push([updatedRow]);

    await updateItemInternal(exec, 'i1', 'u1', false, { item_state: { name: 'Bee' } });

    expect(rec.updates[0].set.lifecycle_status).toBe('draft');
    expect(classify_item).toHaveBeenCalledWith(
      expect.objectContaining({ consent_accepted: false }),
    );
  });

  it('re-runs the gate on edit and keeps an already-live item live', async () => {
    // The config-driven model re-runs classify on every state edit (no
    // live-skip); the live-latch guards required-field removal. A live item
    // whose consent is satisfied (adult / non-gated → guardian never blocks)
    // stays live.
    hasAcceptedProfileConsent.mockResolvedValue(true);
    classify_item.mockReturnValue({ lifecycle_status: 'live' });
    guardianConsentRequired.mockReturnValue(false);
    const { exec, queue, rec } = makeExec();
    queue.push([{ ...existingItem, lifecycle_status: 'live' }]);
    queue.push([updatedRow]);

    await updateItemInternal(exec, 'i1', 'u1', false, { item_state: { name: 'Bee' } });

    expect(rec.updates[0].set.lifecycle_status).toBe('live');
    expect(classify_item).toHaveBeenCalledWith(
      expect.objectContaining({ current_status: 'live', consent_accepted: true }),
    );
  });
});

describe('updateItemInternal — location precedence', () => {
  it('explicit client coords win and are jittered for a private field', async () => {
    isLocationFieldPrivate.mockReturnValue(true);
    const { exec, queue, rec } = makeExec();
    queue.push([existingItem]);
    queue.push([updatedRow]);

    await updateItemInternal(exec, 'i1', 'u1', false, {
      item_locations: [{ lat: 12.9, lng: 77.6 }],
    });

    expect(rec.updates[0].set.item_locations).toEqual([{ lat: 12.901, lng: 77.6 }]);
  });

  it('never re-jitters coords the caller echoed back unchanged', async () => {
    isLocationFieldPrivate.mockReturnValue(true);
    const stored = [{ lat: 12.901, lng: 77.6 }];
    const { exec, queue, rec } = makeExec();
    queue.push([{ ...existingItem, item_locations: stored }]);
    queue.push([updatedRow]);

    await updateItemInternal(exec, 'i1', 'u1', false, {
      item_locations: [{ lat: 12.901, lng: 77.6 }],
    });

    expect(rec.updates[0].set.item_locations).toBe(stored);
    expect(jitterCoordinate).not.toHaveBeenCalled();
  });

  it('an empty coords array is NOT explicit — locations stay untouched', async () => {
    const { exec, queue, rec } = makeExec();
    queue.push([existingItem]);
    queue.push([updatedRow]);

    await updateItemInternal(exec, 'i1', 'u1', false, { item_locations: [] });

    expect(rec.updates[0].set).not.toHaveProperty('item_locations');
  });

  it('wipes coords when the primary address was cleared', async () => {
    primaryAddressChanged.mockReturnValue(true);
    isPrimaryAddressBlank.mockReturnValue(true);
    const { exec, queue, rec } = makeExec();
    queue.push([{ ...existingItem, item_locations: [{ lat: 1, lng: 2 }] }]);
    queue.push([updatedRow]);

    await updateItemInternal(exec, 'i1', 'u1', false, { item_state: { address: '' } });

    expect(rec.updates[0].set.item_locations).toEqual([]);
    expect(geocodeLocationsFromState).not.toHaveBeenCalled();
  });

  it('re-geocodes a changed non-blank address', async () => {
    primaryAddressChanged.mockReturnValue(true);
    geocodeLocationsFromState.mockResolvedValue([{ lat: 13, lng: 78, label: 'BLR' }]);
    const { exec, queue, rec } = makeExec();
    queue.push([existingItem]);
    queue.push([updatedRow]);

    await updateItemInternal(exec, 'i1', 'u1', false, { item_state: { address: 'MG Road' } });

    expect(rec.updates[0].set.item_locations).toEqual([{ lat: 13, lng: 78, label: 'BLR' }]);
  });

  it('preserves existing coords when geocoding fails to resolve anything', async () => {
    primaryAddressChanged.mockReturnValue(true);
    geocodeLocationsFromState.mockResolvedValue([]);
    const { exec, queue, rec } = makeExec();
    queue.push([{ ...existingItem, item_locations: [{ lat: 1, lng: 2 }] }]);
    queue.push([updatedRow]);

    await updateItemInternal(exec, 'i1', 'u1', false, { item_state: { address: 'MG Road' } });

    expect(rec.updates[0].set).not.toHaveProperty('item_locations');
  });

  it('does not geocode when only locations changed (no address edit to detect)', async () => {
    primaryAddressChanged.mockReturnValue(true); // ignored: item_state absent
    const { exec, queue, rec } = makeExec();
    queue.push([existingItem]);
    queue.push([updatedRow]);

    await updateItemInternal(exec, 'i1', 'u1', false, { item_locations: [] });

    expect(geocodeLocationsFromState).not.toHaveBeenCalled();
    expect(primaryAddressChanged).not.toHaveBeenCalled();
    expect(rec.updates[0].set).not.toHaveProperty('item_locations');
  });
});

describe('ItemServiceError', () => {
  it('carries the HTTP status and machine-readable error code', () => {
    const err = new ItemServiceError(409, 'ITEM_RETIRED', 'nope');
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(409);
    expect(err.errorCode).toBe('ITEM_RETIRED');
    expect(err.message).toBe('nope');
  });
});
