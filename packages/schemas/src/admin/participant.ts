import z from 'zod';
import { ItemLocationsArray } from '../api/item_schemas';

/**
 * Body for POST /api/v1/admin/participant.
 *
 * Tier-aware upsert. Called by aggregator-dpg / voice-dpg / any
 * integrating service to ensure a participant exists on Signals and
 * to add/update their items.
 *
 * Identity rules:
 *  - At least one of `email` or `phone_number` is required (refine).
 *  - Phone numbers are E.164.
 *
 * Consent rules:
 *  - `terms_accepted` / `privacy_accepted` are deprecated (#309): optional,
 *    accepted for backward compatibility, but ignored. Consent is recorded
 *    via the `compliance` array instead.
 *
 * Attribution:
 *  - `channel` tags the broad onboarding surface.
 *  - `source_id` is opaque to Signals.
 *
 * `item_state` is the payload written into the items table. `item_id`
 * (optional) targets a specific existing item to update — only
 * meaningful when acting_org is network_service AND the user already
 * exists; ignored otherwise.
 */

const PhoneE164 = z
  .string()
  .regex(/^\+\d{10,15}$/, 'must be E.164 (e.g. +911234567890)');

// Read-side lookup accepts the number with or without the leading "+"
// (callers often send "919876543210"). The handler canonicalizes to E.164
// (prepends "+") before matching the stored, "+"-prefixed phone_number.
const PhoneLookup = z
  .string()
  .regex(/^\+?\d{10,15}$/, 'must be digits, optionally E.164 (e.g. 919876543210 or +919876543210)');

export const UpsertParticipantRequest = z
  .object({
    email: z.email().optional(),
    phone_number: PhoneE164.optional(),
    name: z.string().min(1),
    // Age in years, stored as the `user.age` snapshot (#331). Integrating DPGs
    // derive it from the birth year and send the number (or numeric string).
    // null / '' / a non-string are treated as "not provided" (not coerced to 0),
    // so they don't spuriously trip the U18 age gate (#309). A non-empty
    // non-numeric string (e.g. "abc") still flows to coerce → NaN → .int() 400.
    age: z.preprocess(
      (v) =>
        typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')
          ? v
          : undefined,
      z.coerce.number().int().min(0).max(120).optional(),
    ),
    // Deprecated (#309): accepted for backward compatibility with existing
    // callers (aggregator-dpg / bulk) but IGNORED. Consent is recorded via
    // `compliance`. Remove in a later cleanup ticket.
    terms_accepted: z.boolean().optional(),
    privacy_accepted: z.boolean().optional(),
    // Consent captured by an external channel (voice/aggregator/bulk). Each
    // entry names a consent the user accepted/declined on the channel; only
    // `value: true` is recorded (append-only ledger). Recognised keys:
    // `user_terms`, `user_privacy`, `profile_creation`. Unknown keys (e.g. a
    // future action/connect key) are ignored. Versions are derived server-side.
    compliance: z
      .array(z.object({ key: z.string().min(1), value: z.boolean() }))
      .optional(),
    channel: z.enum(['bulk', 'link', 'voice', 'self']),
    source_id: z.string().min(1).optional(),
    item_state: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'payload written to the items table. If absent OR an empty object {} ' +
        'with NO item_id, the route enters account_only mode (only the user is ' +
        'created/looked up, no item is written). If absent/empty WITH an item_id, ' +
        'that profile is targeted for a consent/DOB update without changing its fields.',
      ),
    item_id: z
      .uuid()
      .optional()
      .describe(
        'UUID. Meaningful when the user already exists AND the caller owns them — ' +
        'network_service, or the aggregator that onboarded the user (#309 activation). ' +
        'Targets that specific item for a PATCH-style update. Ignored otherwise.',
      ),
    network: z
      .string()
      .min(1)
      .optional()
      .describe(
        "network id (default: 'blue_dot'). Set when this Signals instance serves a different network.",
      ),
    domain: z
      .string()
      .min(1)
      .optional()
      .describe(
        "domain within the network (default: 'seeker'). REQUIRED when acting on behalf of a non-aggregator org (voice / network_service): it selects which default aggregator owns the participant, so the 'seeker' fallback would mis-assign a provider signup. Omitting it there returns 400 DOMAIN_REQUIRED. Aggregator callers own their own onboards and may omit it.",
      ),
    item_type: z
      .string()
      .min(1)
      .optional()
      .describe(
        "schema-typed item_type for the item (default: 'profile_1.0').",
      ),
  })
  .refine((b) => Boolean(b.email) || Boolean(b.phone_number), {
    message: 'either email or phone_number is required',
    path: ['email'],
  });

export const ParticipantItemSnapshot = z.object({
  item_id: z.uuid(),
  item_network: z.string(),
  item_domain: z.string(),
  item_type: z.string(),
  // Present on the upsert response so callers can tell live vs draft. Optional
  // because it's shared with the upsert response; both the upsert and GET
  // readers populate it.
  lifecycle_status: z.string().optional(),
  // Whether this specific profile has profile_creation consent recorded.
  // Optional because the upsert response doesn't populate it (only GET does).
  profile_consent_accepted: z.boolean().optional(),
  item_state: z.record(z.string(), z.unknown()),
  item_locations: ItemLocationsArray,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export const UpsertParticipantResponse = z.object({
  user_id: z.string(),
  user_existed: z.boolean(),
  owned_elsewhere: z.boolean(),
  onboarded_at: z.iso.datetime().nullable(),
  items: z.array(ParticipantItemSnapshot),
  // Number of consent_record rows written this call (#309). Optional so the
  // rejected / owned-elsewhere branches can omit it.
  consent_recorded: z.number().int().optional(),
  // Who owns this participant (#640, SS-3). Exposed because the owner is no
  // longer implicitly the acting org: a `voice` or `network_service` caller now
  // resolves the instance's default aggregator instead, and gets null when no
  // single default is nominated. Without these fields an integrating DPG could
  // not tell whether the participant it just onboarded is owned by itself, by a
  // default aggregator, or by nobody — and could not detect the change at all.
  // Optional so the rejected / owned-elsewhere branches can omit them.
  onboarded_by_org_id: z.string().nullable().optional(),
  onboarded_by_default: z.boolean().optional(),
});

export const GetParticipantRequest = z
  .object({
    email: z.email().optional(),
    phone_number: PhoneLookup.optional(),
  })
  .refine((q) => Boolean(q.email) || Boolean(q.phone_number), {
    message: 'either email or phone_number is required',
    path: ['email'],
  });

export const GetParticipantResponse = z.object({
  user_id: z.string().nullable(),
  user_consent: z.object({
    terms_accepted: z.boolean(),
    privacy_accepted: z.boolean(),
    has_age: z.boolean(),
  }),
  items: z.array(ParticipantItemSnapshot),
});

export type UpsertParticipantRequest = z.infer<typeof UpsertParticipantRequest>;
export type UpsertParticipantResponse = z.infer<typeof UpsertParticipantResponse>;
export type ParticipantItemSnapshot = z.infer<typeof ParticipantItemSnapshot>;
export type GetParticipantRequest = z.infer<typeof GetParticipantRequest>;
export type GetParticipantResponse = z.infer<typeof GetParticipantResponse>;
