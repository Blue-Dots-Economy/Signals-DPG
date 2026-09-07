import Ajv2020 from 'ajv/dist/2020.js';
import { z } from 'zod';
import { applyUriPatterns } from './uri_fields';

const JsonSchemaDocumentSchema = z.record(z.string(), z.unknown());

// Go-live gate tokens (NOT field names). The single source of truth for the
// gate vocabulary — apps/api's classifier imports these rather than redefining
// them, so the config schema and the runtime evaluator can never drift.
// `schema_required` is the baseline gate; `consent_required` and
// `owner_required` are opt-in per domain (a guardian-gated domain always
// enforces `consent_required` — see the resolver).
//
// `owner_required` (#640 / SS-3): the profile owner must have an owning
// aggregator. Unlike the other two it is NOT a pure function of the item's own
// state — see `GO_LIVE_GATE_CHECKS.owner_required` in apps/api for why.
export const PROFILE_GO_LIVE_GATES = [
  'schema_required',
  'consent_required',
  'owner_required',
] as const;
export type GoLiveGate = (typeof PROFILE_GO_LIVE_GATES)[number];

// Canonical bucket + status enums. Duplicated here from
// apps/api/src/services/metrics/buckets.ts because @dpg/schemas is upstream
// of apps/api — the package can't import down the tree. Both must be updated
// in lockstep if a bucket or status is added.
const CANONICAL_BUCKETS = ['create', 'accept', 'reject', 'cancel'] as const;
const CANONICAL_STATUSES = ['new', 'active', 'at_risk', 'inactive'] as const;
const CanonicalBucketSchema = z.enum(CANONICAL_BUCKETS);
const CanonicalStatusSchema = z.enum(CANONICAL_STATUSES);

const ComparisonSchema = z.union([
  z.object({ lt: z.number() }).strict(),
  z.object({ lte: z.number() }).strict(),
  z.object({ gt: z.number() }).strict(),
  z.object({ gte: z.number() }).strict(),
  z.object({ eq: z.number() }).strict(),
  z.object({ between: z.tuple([z.number(), z.number()]) }).strict(),
]);

const bucketsField = { buckets: z.array(CanonicalBucketSchema).min(1) };
const BucketScopedComparisonSchema = z.union([
  z.object({ ...bucketsField, lt:      z.number() }).strict(),
  z.object({ ...bucketsField, lte:     z.number() }).strict(),
  z.object({ ...bucketsField, gt:      z.number() }).strict(),
  z.object({ ...bucketsField, gte:     z.number() }).strict(),
  z.object({ ...bucketsField, eq:      z.number() }).strict(),
  z.object({ ...bucketsField, between: z.tuple([z.number(), z.number()]) }).strict(),
]);

const ItemAgePredicateSchema = z.object({ item_age_days: ComparisonSchema }).strict();
const DaysSinceLastPredicateSchema = z.object({ days_since_last: BucketScopedComparisonSchema }).strict();
const CountPredicateSchema = z.object({ count: BucketScopedComparisonSchema }).strict();

// Recursive predicate: leaf predicates + all/any combinators
type PredicateInput =
  | z.input<typeof ItemAgePredicateSchema>
  | z.input<typeof DaysSinceLastPredicateSchema>
  | z.input<typeof CountPredicateSchema>
  | { all: PredicateInput[] }
  | { any: PredicateInput[] };

const PredicateSchema: z.ZodType<PredicateInput> = z.lazy(() =>
  z.union([
    ItemAgePredicateSchema,
    DaysSinceLastPredicateSchema,
    CountPredicateSchema,
    z.object({ all: z.array(PredicateSchema).min(1) }).strict(),
    z.object({ any: z.array(PredicateSchema).min(1) }).strict(),
  ]),
);

const StatusRuleSchema = z.object({
  status: CanonicalStatusSchema,
  // Optional UI copy rendered on the aggregator dashboard status cards.
  label: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  when: z.union([PredicateSchema, z.literal('default')]),
}).strict();

// A dashboard tile declares which precomputed rollup field to render and what
// to label it. `field` maps to a rollup key (e.g. total_items, total_users);
// the aggregator reads the precomputed value — it never computes. Tiles are
// grouped into profile-level and user-level sets.
const DashboardTileSchema = z.object({
  field: z.string().min(1),
  label: z.string().min(1),
}).strict();
const DashboardTilesSchema = z.object({
  profile: z.array(DashboardTileSchema).optional(),
  user: z.array(DashboardTileSchema).optional(),
}).strict();

// Per-domain card display config (consumed by the UI item card). Drives which
// fields show by default on a card and what becomes the heading / avatar; the
// rest of the schema's fields move behind the "view more" expander. Optional —
// domains without a `card` block fall back to a best-guess in the UI.
const CardConfigSchema = z.object({
  title_field: z.string().min(1).optional(),
  subtitle_field: z.string().min(1).optional(),
  avatar_from: z.string().min(1).optional(),
  default_fields: z.array(z.string().min(1)).optional().default([]),
  // Ordered, exhaustive list of fields shown behind "view more". When present,
  // only these appear as extra rows; any other schema field is omitted.
  extra_fields: z.array(z.string().min(1)).optional(),
}).strict();

/**
 * Canonical contact-field mapping for a domain (#237): maps the canonical
 * name/email/phone to the domain's real item_state field name, since these
 * are named differently per network/domain (e.g. `mobile_number`,
 * `hiringManagerPhoneNumber`). Consumed by participant/decrypt field
 * resolution. All optional — `name` falls back to display_name_field /
 * card.title_field when unset.
 */
const ContactFieldsSchema = z
  .object({
    // `.optional()` WITHOUT `.min(1)`: an empty-string value ("phone": "") on a
    // declared key must not fail the whole cross-network parse either — at
    // resolve time an empty mapping is falsy, so it degrades to the account
    // fallback exactly like an absent mapping (same rationale as `.strip()`).
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
  })
  // `.strip()` (not `.strict()`): an unknown/typo'd key here must not fail the
  // whole network-config parse — that runs for every domain, including unserved
  // siblings, and would take down boot (app.ts awaits config with no catch).
  // A dropped typo degrades gracefully to the account fallback at resolve time
  // (with a `contact_map_missing` warn), rather than a hard boot failure.
  .strip();

const NetworkDomainSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  // Optional per-domain display label (e.g. id `provider` shown as "Service
  // Provider"). Keeps the domain id stable — avoiding a data migration — while
  // the UI renders the friendly label. Zod strips unknown keys, so this MUST be
  // declared or the label never reaches the client (the UI resolver then falls
  // back to title-casing the id). Presentational only; never part of validation.
  label: z.string().min(1).optional(),
  // Optional per-domain override for the sidebar "My Profile(s)" group heading
  // (e.g. blue_dot provider → "My Jobs"). Network-authored content, not i18n
  // chrome; falls back to the generic label when unset.
  my_items_label: z.string().min(1).optional(),
  // Optional per-domain "why complete your profile" prompt shown on the profile
  // create/edit page (#376). Role-specific, network-authored content (a seeker's
  // "why" ≠ a provider's); the UI falls back to a generic i18n message when
  // unset. Presentational only — never part of item validation.
  profile_completion_prompt: z
    .object({ heading: z.string().min(1), body: z.string().min(1) })
    .optional(),
  minimum_cache_ttl_seconds: z.number().int().positive().optional().default(300),
  // U18 spec D8: when true, this domain routes minors' consent through a
  // guardian. Server-read only; never trusted from the client. Defaults off.
  guardian_consent_required: z.boolean().optional().default(false),
  // Which gates a profile must clear before it goes `live` (discoverable) in
  // this domain. Tokens — NOT field names — evaluated by `classify_item`
  // (see `PROFILE_GO_LIVE_GATES`). Omit to use the baseline default (`schema_required`;
  // a guardian-gated domain additionally always enforces `consent_required`).
  // An empty array is rejected — a profile with no gates would go live
  // instantly.
  go_live_required: z.array(z.enum(PROFILE_GO_LIVE_GATES)).min(1).optional(),
  // Optional per-domain cap on how many profiles a single user may own in this
  // domain. Overrides the global MAX_PROFILES_PER_USER default when set (e.g.
  // seeker=3, provider=5). Unset ⇒ the global default applies.
  max_profiles_per_user: z.number().int().positive().optional(),
  item_schemas: z
    .record(z.string(), JsonSchemaDocumentSchema)
    .optional()
    .default({}),
  default_item_schemas: z
    .record(z.string(), JsonSchemaDocumentSchema)
    .optional()
    .default({}),
  status_rules: z.array(StatusRuleSchema).min(1),
  dashboard_tiles: DashboardTilesSchema.optional(),
  card: CardConfigSchema.optional(),
  contact_fields: ContactFieldsSchema.optional(),
}).superRefine((domain, ctx) => {
  const last = domain.status_rules[domain.status_rules.length - 1];
  if (last.when !== 'default') {
    ctx.addIssue({
      code: 'custom',
      message: 'status_rules must end with a `{ when: "default" }` tail rule',
      path: ['status_rules', domain.status_rules.length - 1, 'when'],
    });
  }
  // The U18 guardian gate lives inside `consent_required`. A guardian-gated
  // domain that drops that gate from `go_live_required` would silently disable
  // the age control — reject it rather than let config turn off U18 protection.
  if (
    domain.guardian_consent_required &&
    domain.go_live_required &&
    !domain.go_live_required.includes('consent_required')
  ) {
    ctx.addIssue({
      code: 'custom',
      message:
        'a guardian_consent_required domain must keep "consent_required" in go_live_required',
      path: ['go_live_required'],
    });
  }
}).transform((domain) => ({
  ...domain,
  item_schemas: {
    ...domain.default_item_schemas,
    ...domain.item_schemas,
  },
}));

const NetworkInstanceSchema = z.object({
  domain_id: z.string().min(1),
  instance_name: z.string().optional(),
  instance_url: z.url(),
  schema_url: z.url().nullable().optional(),
  custom_item_schema_urls: z.record(z.string(), z.url()).optional().default({}),
}).transform((instance) => ({
  ...instance,
  custom_item_schema_urls: {
    ...(instance.schema_url ? { profile: instance.schema_url } : {}),
    ...instance.custom_item_schema_urls,
  },
}));

const MetricCategoriesSchema = z.object({
  create: z.array(z.string().min(1)).optional().default([]),
  accept: z.array(z.string().min(1)).optional().default([]),
  reject: z.array(z.string().min(1)).optional().default([]),
  cancel: z.array(z.string().min(1)).optional().default([]),
}).strict();

export const NetworkActionInteractionSchema = z
  .object({
    from_network: z.string().min(1).optional(),
    from_domain: z.string().min(1),
    from_items: z.string().min(1).array().optional().default([]),
    to_network: z.string().min(1).optional(),
    to_domain: z.string().min(1),
    to_items: z.string().min(1).array().optional().default([]),
    requirement_schema: JsonSchemaDocumentSchema,
    event_schema: JsonSchemaDocumentSchema.optional(),
    metric_categories: MetricCategoriesSchema.nullable().optional(),
    reveals_pii_on_status: z.array(z.string().min(1)).optional().default([]),
  })
  .superRefine((interaction, ctx) => {
    if (interaction.reveals_pii_on_status.length === 0) return;

    if (!interaction.event_schema) {
      ctx.addIssue({
        code: 'custom',
        message:
          'reveals_pii_on_status requires event_schema with a status.enum to validate against',
        path: ['reveals_pii_on_status'],
      });
      return;
    }

    const statusEnum = extractStatusEnum(interaction.event_schema);
    if (!statusEnum) {
      ctx.addIssue({
        code: 'custom',
        message:
          'reveals_pii_on_status requires event_schema.properties.status.enum to be defined',
        path: ['reveals_pii_on_status'],
      });
      return;
    }

    for (const status of interaction.reveals_pii_on_status) {
      if (!statusEnum.includes(status)) {
        ctx.addIssue({
          code: 'custom',
          message: `reveals_pii_on_status value "${status}" is not in event_schema.properties.status.enum`,
          path: ['reveals_pii_on_status'],
        });
      }
    }
  });

function extractStatusEnum(
  eventSchema: Record<string, unknown>
): string[] | null {
  const properties = eventSchema.properties;
  if (!properties || typeof properties !== 'object') return null;
  const status = (properties as Record<string, unknown>).status;
  if (!status || typeof status !== 'object') return null;
  const enumValues = (status as Record<string, unknown>).enum;
  if (!Array.isArray(enumValues)) return null;
  return enumValues.filter((v): v is string => typeof v === 'string');
}

const NetworkActionSchema = z.object({
  description: z.string().optional(),
  interactions: NetworkActionInteractionSchema.array().default([]),
});

const ActionBucketLabelsSchema = z.object({
  create: z.string().min(1).optional(),
  accept: z.string().min(1).optional(),
  reject: z.string().min(1).optional(),
  cancel: z.string().min(1).optional(),
}).strict();

const DashboardBucketsSchema = z.object({
  by_status: z.object({
    new: z.string().min(1).optional(),
    active: z.string().min(1).optional(),
    at_risk: z.string().min(1).optional(),
    inactive: z.string().min(1).optional(),
  }).strict().optional(),
  // Directional action labels (replace the former blended by_action_status).
  by_initiated_action_status: ActionBucketLabelsSchema.optional(),
  by_received_action_status: ActionBucketLabelsSchema.optional(),
}).strict();

export const NetworkConfigSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().optional(),
  description: z.string().optional(),
  schema_standard: z.string().optional(),
  source_url: z.url().optional(),
  // Network-wide toggle for the pause (voluntarily-hide) feature. When false,
  // owners cannot pause their profiles and the UI hides the control. Resume
  // (unpause) is always allowed so a profile paused before the feature was
  // turned off can still be recovered. Defaults on. (#346)
  pause_enabled: z.boolean().optional().default(true),
  // Max concurrent OPEN actions between any two items — bidirectional, across
  // action types (#370/#422). Omitted → 1 (one open apply/connect per pair).
  max_actions_per_pair: z.number().int().positive().optional().default(1),
  domains: NetworkDomainSchema.array().default([]),
  instances: NetworkInstanceSchema.array().default([]),
  cross_network_origins: z
    .object({
      id: z.string().min(1),
      display_name: z.string().optional(),
      schema_url: z.url(),
    })
    .array()
    .default([]),
  actions: z.record(z.string(), NetworkActionSchema).default({}),
  dashboard_buckets: DashboardBucketsSchema.optional(),
}).superRefine((cfg, ctx) => {
  for (const [domainIdx, domain] of cfg.domains.entries()) {
    for (const [schemaName, schemaDoc] of Object.entries(domain.item_schemas ?? {})) {
      const doc = schemaDoc as Record<string, unknown>;
      const field = doc.display_name_field;
      if (field === undefined) continue;
      if (typeof field !== 'string') {
        ctx.addIssue({
          code: 'custom',
          message: `display_name_field must be a string`,
          path: ['domains', domainIdx, 'item_schemas', schemaName, 'display_name_field'],
        });
        continue;
      }
      const props = (doc.properties as Record<string, unknown> | undefined) ?? {};
      const target = props[field];
      if (!target || typeof target !== 'object') {
        ctx.addIssue({
          code: 'custom',
          message: `display_name_field "${field}" does not exist in properties`,
          path: ['domains', domainIdx, 'item_schemas', schemaName, 'display_name_field'],
        });
        continue;
      }
      const t = target as Record<string, unknown>;
      if (t.private === true) {
        ctx.addIssue({
          code: 'custom',
          message: `display_name_field "${field}" points at a private property; pick a non-private field`,
          path: ['domains', domainIdx, 'item_schemas', schemaName, 'display_name_field'],
        });
      } else if (t.type !== 'string') {
        ctx.addIssue({
          code: 'custom',
          message: `display_name_field "${field}" must point at a property of type "string"`,
          path: ['domains', domainIdx, 'item_schemas', schemaName, 'display_name_field'],
        });
      }
    }
  }
});

export type NetworkConfigDocument = z.infer<typeof NetworkConfigSchema>;
export type NetworkActionInteraction = z.infer<
  typeof NetworkActionInteractionSchema
>;

/** A directional edge (network/domain → network/domain) of an interaction. */
export interface MetricCategoryEdge {
  from_network: string;
  from_domain: string;
  to_network: string;
  to_domain: string;
}

/**
 * One asymmetry: a tracked interaction whose mirror-direction interaction
 * exists in the same action but is NOT tracked. The recompute pipeline
 * silently drops actions performed in the untracked direction (their
 * counts never reach item_metrics), so this is almost always a config bug.
 */
export interface MetricCategoryAsymmetry {
  action_type: string;
  tracked: MetricCategoryEdge;
  untracked: MetricCategoryEdge;
}

/**
 * An interaction is "tracked" iff its metric_categories is present AND at
 * least one canonical bucket has entries. Mirrors the runtime contract in
 * apps/api/.../metric_categories.ts (`normalize` returns null when empty),
 * so this lint matches exactly which interactions the recompute aggregates.
 */
function isMetricTracked(
  metric_categories: NetworkActionInteraction['metric_categories'],
): boolean {
  if (!metric_categories) return false;
  return CANONICAL_BUCKETS.some(
    (bucket) => (metric_categories[bucket]?.length ?? 0) > 0,
  );
}

const edgeOf = (
  networkId: string,
  interaction: NetworkActionInteraction,
): MetricCategoryEdge => ({
  from_network: interaction.from_network ?? networkId,
  from_domain: interaction.from_domain,
  to_network: interaction.to_network ?? networkId,
  to_domain: interaction.to_domain,
});

const isReverseEdge = (a: MetricCategoryEdge, b: MetricCategoryEdge): boolean =>
  a.from_network === b.to_network &&
  a.from_domain === b.to_domain &&
  a.to_network === b.from_network &&
  a.to_domain === b.from_domain;

/**
 * Detects metric_categories asymmetries: within a single action, a tracked
 * interaction whose reverse-direction interaction exists but is untracked.
 *
 * Returns one entry per offending (tracked, untracked) pair. An empty array
 * means every tracked interaction either has no reverse edge (one-directional
 * by design) or a reverse edge that is also tracked.
 */
export function findMetricCategoryAsymmetries(
  config: NetworkConfigDocument,
): MetricCategoryAsymmetry[] {
  const out: MetricCategoryAsymmetry[] = [];
  for (const [action_type, action] of Object.entries(config.actions)) {
    for (const tracked of action.interactions) {
      if (!isMetricTracked(tracked.metric_categories)) continue;
      const trackedEdge = edgeOf(config.id, tracked);

      for (const reverse of action.interactions) {
        if (reverse === tracked) continue;
        const reverseEdge = edgeOf(config.id, reverse);
        if (!isReverseEdge(trackedEdge, reverseEdge)) continue;
        if (isMetricTracked(reverse.metric_categories)) continue;
        out.push({
          action_type,
          tracked: trackedEdge,
          untracked: reverseEdge,
        });
      }
    }
  }
  return out;
}

export function parseNetworkConfigDocument(
  input: unknown
): NetworkConfigDocument {
  return NetworkConfigSchema.parse(input);
}

export function getActionInteraction(
  networkConfig: NetworkConfigDocument,
  input: {
    actionType: string;
    fromNetwork: string;
    fromDomain: string;
    fromItemType?: string;
    toNetwork: string;
    toDomain: string;
    toItemType?: string;
  }
) {
  const action = networkConfig.actions[input.actionType];

  if (!action) {
    throw new Error(
      `Action "${input.actionType}" is not defined for network "${networkConfig.id}".`
    );
  }

  const interaction = action.interactions.find((entry) => {
    const fromNetwork = entry.from_network ?? networkConfig.id;
    const toNetwork = entry.to_network ?? networkConfig.id;

    return (
      fromNetwork === input.fromNetwork &&
      entry.from_domain === input.fromDomain &&
      matchesAllowedItemType(entry.from_items, input.fromItemType) &&
      toNetwork === input.toNetwork &&
      entry.to_domain === input.toDomain &&
      matchesAllowedItemType(entry.to_items, input.toItemType)
    );
  });

  if (!interaction) {
    throw new Error(
      `Action "${input.actionType}" is not allowed from "${input.fromNetwork}/${input.fromDomain}${formatItemType(input.fromItemType)}" to "${input.toNetwork}/${input.toDomain}${formatItemType(input.toItemType)}".`
    );
  }

  return interaction;
}

export function getInteractionPiiRevealStatuses(
  networkConfig: NetworkConfigDocument,
  input: {
    actionType: string;
    fromNetwork: string;
    fromDomain: string;
    fromItemType?: string;
    toNetwork: string;
    toDomain: string;
    toItemType?: string;
  }
): readonly string[] {
  const interaction = getActionInteraction(networkConfig, input);
  return interaction.reveals_pii_on_status;
}

function matchesAllowedItemType(
  allowedItemTypes: string[],
  itemType: string | undefined
) {
  return (
    allowedItemTypes.length === 0 ||
    Boolean(itemType && allowedItemTypes.includes(itemType))
  );
}

function formatItemType(itemType: string | undefined) {
  return itemType ? `/${itemType}` : '';
}

export function getDomainItemSchema(
  networkConfig: NetworkConfigDocument,
  domain: string,
  itemType: string
) {
  const domainConfig = networkConfig.domains.find(
    (entry) => entry.id === domain
  );

  if (!domainConfig) {
    throw new Error(
      `Domain "${domain}" is not defined for network "${networkConfig.id}".`
    );
  }

  const itemSchema = domainConfig.item_schemas[itemType];

  if (!itemSchema) {
    throw new Error(
      `Item type "${itemType}" is not defined for domain "${domain}" in network "${networkConfig.id}".`
    );
  }

  return itemSchema;
}

export function getDomainItemTypes(
  networkConfig: NetworkConfigDocument,
  domain: string
): string[] {
  const domainConfig = networkConfig.domains.find(
    (entry) => entry.id === domain
  );

  if (!domainConfig) {
    throw new Error(
      `Domain "${domain}" is not defined for network "${networkConfig.id}".`
    );
  }

  return Object.keys(domainConfig.item_schemas);
}

export function getDomainMinimumCacheTtlSeconds(
  networkConfig: NetworkConfigDocument,
  domain: string
): number {
  const domainConfig = networkConfig.domains.find(
    (entry) => entry.id === domain
  );

  if (!domainConfig) {
    throw new Error(
      `Domain "${domain}" is not defined for network "${networkConfig.id}".`
    );
  }

  return domainConfig.minimum_cache_ttl_seconds;
}

export function getInstanceCustomItemSchemaUrl(
  networkConfig: NetworkConfigDocument,
  input: {
    domain: string;
    instanceUrl: string;
    itemType: string;
  }
): string | null {
  const instanceConfig = networkConfig.instances.find(
    (entry) =>
      entry.domain_id === input.domain &&
      entry.instance_url === input.instanceUrl
  );

  if (!instanceConfig) {
    return null;
  }

  return (
    (instanceConfig.custom_item_schema_urls as Record<string, string>)[
      input.itemType
    ] ?? null
  );
}

export function validateAgainstJsonSchema(
  schema: Record<string, unknown>,
  payload: unknown,
  label: string,
  options: {
    allowAdditionalProperties?: boolean;
    ignoredKeys?: readonly string[];
  } = {}
) {
  const ignoredKeys = options.ignoredKeys ?? [];
  // `x-uri` fields get the shared URL pattern injected before compilation. The
  // API's ajv registers no `ajv-formats`, so `format` is ignored on every
  // write — `pattern` is what actually bites here, and it is the SAME pattern
  // the profile form applies client-side (packages/schemas/src/uri_fields.ts).
  const schemaWithUriPatterns = applyUriPatterns(schema);
  const schemaForValidation = options.allowAdditionalProperties
    ? allowAdditionalProperties(schemaWithUriPatterns)
    : schemaWithUriPatterns;
  const finalSchema =
    ignoredKeys.length > 0
      ? omitRequiredSchemaKeys(schemaForValidation, ignoredKeys)
      : schemaForValidation;
  const finalPayload =
    ignoredKeys.length > 0 ? omitObjectKeys(payload, ignoredKeys) : payload;

  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
  });

  const validate = ajv.compile(finalSchema);
  const valid = validate(finalPayload);

  if (valid) {
    return;
  }

  const message =
    validate.errors?.map((error) => error.message).filter(Boolean).join(', ') ||
    'unknown validation error';

  throw new Error(`Invalid ${label}: ${message}`);
}

function omitObjectKeys(input: unknown, ignoredKeys: readonly string[]) {
  if (!isPlainObject(input)) {
    return input;
  }

  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !ignoredKeys.includes(key))
  );
}

function omitRequiredSchemaKeys(
  schema: Record<string, unknown>,
  ignoredKeys: readonly string[]
): Record<string, unknown> {
  return rewriteJsonSchema(schema, (value) => {
    const required = value.required;

    if (!Array.isArray(required)) {
      return value;
    }

    return {
      ...value,
      required: required.filter(
        (entry) => typeof entry !== 'string' || !ignoredKeys.includes(entry)
      ),
    };
  });
}

function allowAdditionalProperties(
  schema: Record<string, unknown>
): Record<string, unknown> {
  return rewriteJsonSchema(schema, (value) => {
    const next = { ...value };

    if (next.additionalProperties === false) {
      next.additionalProperties = true;
    }

    if (next.unevaluatedProperties === false) {
      next.unevaluatedProperties = true;
    }

    return next;
  });
}

function rewriteJsonSchema(
  schema: Record<string, unknown>,
  rewriteObject: (value: Record<string, unknown>) => Record<string, unknown>
): Record<string, unknown> {
  return rewriteObject(
    Object.fromEntries(
      Object.entries(schema).map(([key, value]) => [
        key,
        rewriteJsonValue(value, rewriteObject),
      ])
    )
  );
}

function rewriteJsonValue(
  value: unknown,
  rewriteObject: (value: Record<string, unknown>) => Record<string, unknown>
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteJsonValue(entry, rewriteObject));
  }

  if (isPlainObject(value)) {
    return rewriteJsonSchema(value, rewriteObject);
  }

  return value;
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
