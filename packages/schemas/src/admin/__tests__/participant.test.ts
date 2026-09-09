import { describe, expect, it } from 'vitest';
import {
  GetParticipantRequest,
  GetParticipantResponse,
  ParticipantItemSnapshot,
  UpsertParticipantRequest,
  UpsertParticipantResponse,
} from '../participant';

const ITEM_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ISO = '2026-08-05T10:15:30.000Z';
const base = { name: 'Asha Rao', channel: 'self' as const };

describe('UpsertParticipantRequest — identity refine', () => {
  it('accepts an email-only body', () => {
    expect(UpsertParticipantRequest.safeParse({ ...base, email: 'asha@example.com' }).success).toBe(
      true,
    );
  });

  it('accepts a phone-only body', () => {
    expect(
      UpsertParticipantRequest.safeParse({ ...base, phone_number: '+919876543210' }).success,
    ).toBe(true);
  });

  it('rejects a body with neither email nor phone_number, reporting on `email`', () => {
    const result = UpsertParticipantRequest.safeParse(base);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['email']);
      expect(result.error.issues[0].message).toBe('either email or phone_number is required');
    }
  });

  it('rejects a malformed email', () => {
    expect(UpsertParticipantRequest.safeParse({ ...base, email: 'asha@' }).success).toBe(false);
  });

  it('rejects a missing name', () => {
    expect(UpsertParticipantRequest.safeParse({ email: 'a@b.com', channel: 'self' }).success).toBe(
      false,
    );
  });

  it('rejects an empty name', () => {
    expect(
      UpsertParticipantRequest.safeParse({ ...base, name: '', email: 'a@b.com' }).success,
    ).toBe(false);
  });
});

describe('UpsertParticipantRequest — phone_number must be E.164', () => {
  it.each(['+911234567890', '+1234567890', '+123456789012345'])('accepts %s', (phone_number) => {
    expect(UpsertParticipantRequest.safeParse({ ...base, phone_number }).success).toBe(true);
  });

  it.each([
    ['no leading +', '919876543210'],
    ['too short', '+12345'],
    ['too long', '+1234567890123456'],
    ['spaces', '+91 98765 43210'],
    ['letters', '+91abcdefghij'],
  ])('rejects a phone_number with %s', (_label, phone_number) => {
    const result = UpsertParticipantRequest.safeParse({ ...base, phone_number });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('must be E.164 (e.g. +911234567890)');
    }
  });
});

describe('UpsertParticipantRequest — age preprocessing (#309/#331)', () => {
  const withEmail = { ...base, email: 'a@b.com' };

  it('accepts a numeric age', () => {
    const result = UpsertParticipantRequest.safeParse({ ...withEmail, age: 17 });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.age).toBe(17);
    }
  });

  it('coerces a numeric string to a number', () => {
    const result = UpsertParticipantRequest.safeParse({ ...withEmail, age: '17' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.age).toBe(17);
    }
  });

  it.each([
    ['null', null],
    ['empty string', ''],
    ['whitespace-only string', '   '],
    ['a boolean', true],
    ['an object', {}],
  ])('treats %s as "not provided" rather than 0', (_label, age) => {
    const result = UpsertParticipantRequest.safeParse({ ...withEmail, age });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.age).toBeUndefined();
    }
  });

  it('rejects a non-numeric non-empty string (NaN after coercion)', () => {
    const result = UpsertParticipantRequest.safeParse({ ...withEmail, age: 'abc' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['age']);
    }
  });

  it('accepts the 0 and 120 boundaries', () => {
    expect(UpsertParticipantRequest.safeParse({ ...withEmail, age: 0 }).success).toBe(true);
    expect(UpsertParticipantRequest.safeParse({ ...withEmail, age: 120 }).success).toBe(true);
  });

  it('rejects an age above 120 or below 0', () => {
    expect(UpsertParticipantRequest.safeParse({ ...withEmail, age: 121 }).success).toBe(false);
    expect(UpsertParticipantRequest.safeParse({ ...withEmail, age: -1 }).success).toBe(false);
  });

  it('rejects a fractional age', () => {
    expect(UpsertParticipantRequest.safeParse({ ...withEmail, age: 17.5 }).success).toBe(false);
  });
});

describe('UpsertParticipantRequest — consent, channel and attribution', () => {
  const withEmail = { ...base, email: 'a@b.com' };

  it.each(['bulk', 'link', 'voice', 'self'])('accepts channel %s', (channel) => {
    expect(UpsertParticipantRequest.safeParse({ ...withEmail, channel }).success).toBe(true);
  });

  it('rejects an unknown channel', () => {
    expect(UpsertParticipantRequest.safeParse({ ...withEmail, channel: 'sms' }).success).toBe(false);
  });

  it('rejects a missing channel', () => {
    expect(UpsertParticipantRequest.safeParse({ email: 'a@b.com', name: 'Asha' }).success).toBe(
      false,
    );
  });

  it('strips the removed terms/privacy flags instead of rejecting them (#692)', () => {
    // Removal must stay non-breaking: the object is not `.strict()`, so a
    // legacy caller still sending the flags gets a 200 exactly as before —
    // they are simply dropped rather than surfacing as a 400.
    const result = UpsertParticipantRequest.safeParse({
      ...withEmail,
      terms_accepted: true,
      privacy_accepted: false,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('terms_accepted');
      expect(result.data).not.toHaveProperty('privacy_accepted');
    }
  });

  it('accepts a compliance ledger array', () => {
    const result = UpsertParticipantRequest.safeParse({
      ...withEmail,
      compliance: [
        { key: 'user_terms', value: true },
        { key: 'profile_creation', value: false },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.compliance).toHaveLength(2);
    }
  });

  it('accepts an unrecognised compliance key (filtering is server-side)', () => {
    expect(
      UpsertParticipantRequest.safeParse({
        ...withEmail,
        compliance: [{ key: 'future_action_consent', value: true }],
      }).success,
    ).toBe(true);
  });

  it('rejects a compliance entry with an empty key', () => {
    expect(
      UpsertParticipantRequest.safeParse({ ...withEmail, compliance: [{ key: '', value: true }] })
        .success,
    ).toBe(false);
  });

  it('rejects a compliance entry with a non-boolean value', () => {
    expect(
      UpsertParticipantRequest.safeParse({
        ...withEmail,
        compliance: [{ key: 'user_terms', value: 'yes' }],
      }).success,
    ).toBe(false);
  });

  it('rejects an empty source_id', () => {
    expect(UpsertParticipantRequest.safeParse({ ...withEmail, source_id: '' }).success).toBe(false);
  });
});

describe('UpsertParticipantRequest — item targeting', () => {
  const withEmail = { ...base, email: 'a@b.com' };

  it('accepts an item_state payload and an item_id together', () => {
    const result = UpsertParticipantRequest.safeParse({
      ...withEmail,
      item_state: { skills: ['welding'], nested: { a: 1 } },
      item_id: ITEM_ID,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.item_state).toEqual({ skills: ['welding'], nested: { a: 1 } });
      expect(result.data.item_id).toBe(ITEM_ID);
    }
  });

  it('accepts an empty item_state object (account_only mode)', () => {
    expect(UpsertParticipantRequest.safeParse({ ...withEmail, item_state: {} }).success).toBe(true);
  });

  it('rejects a non-object item_state', () => {
    expect(UpsertParticipantRequest.safeParse({ ...withEmail, item_state: 'x' }).success).toBe(
      false,
    );
  });

  it('rejects a non-uuid item_id', () => {
    const result = UpsertParticipantRequest.safeParse({ ...withEmail, item_id: 'item-1' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['item_id']);
    }
  });

  it('leaves network/domain/item_type undefined when omitted (defaults are applied downstream)', () => {
    const result = UpsertParticipantRequest.safeParse(withEmail);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.network).toBeUndefined();
      expect(result.data.domain).toBeUndefined();
      expect(result.data.item_type).toBeUndefined();
    }
  });

  it.each(['network', 'domain', 'item_type'])('rejects an empty %s override', (field) => {
    expect(UpsertParticipantRequest.safeParse({ ...withEmail, [field]: '' }).success).toBe(false);
  });

  it('accepts explicit network/domain/item_type overrides', () => {
    const result = UpsertParticipantRequest.safeParse({
      ...withEmail,
      network: 'yellow_dot',
      domain: 'student',
      item_type: 'profile_1.0',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.item_type).toBe('profile_1.0');
    }
  });
});

describe('GetParticipantRequest — lookup identity', () => {
  it('accepts an email lookup', () => {
    expect(GetParticipantRequest.safeParse({ email: 'a@b.com' }).success).toBe(true);
  });

  it('accepts a phone lookup WITHOUT the leading + (canonicalized server-side)', () => {
    const result = GetParticipantRequest.safeParse({ phone_number: '919876543210' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phone_number).toBe('919876543210');
    }
  });

  it('accepts a phone lookup WITH the leading +', () => {
    expect(GetParticipantRequest.safeParse({ phone_number: '+919876543210' }).success).toBe(true);
  });

  it('rejects a too-short phone lookup', () => {
    const result = GetParticipantRequest.safeParse({ phone_number: '12345' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'must be digits, optionally E.164 (e.g. 919876543210 or +919876543210)',
      );
    }
  });

  it('rejects a phone lookup with separators', () => {
    expect(GetParticipantRequest.safeParse({ phone_number: '91-98765-43210' }).success).toBe(false);
  });

  it('rejects an empty query', () => {
    const result = GetParticipantRequest.safeParse({});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('either email or phone_number is required');
    }
  });

  it('rejects a malformed email lookup', () => {
    expect(GetParticipantRequest.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });
});

describe('ParticipantItemSnapshot', () => {
  const snapshot = {
    item_id: ITEM_ID,
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_state: { name: 'Asha' },
    item_locations: [{ lat: 18.52, lng: 73.85, label: 'Pune' }],
    created_at: ISO,
    updated_at: ISO,
  };

  it('accepts a minimal snapshot without the optional status fields', () => {
    const result = ParticipantItemSnapshot.safeParse(snapshot);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lifecycle_status).toBeUndefined();
      expect(result.data.profile_consent_accepted).toBeUndefined();
    }
  });

  it('accepts lifecycle_status and profile_consent_accepted when present', () => {
    const result = ParticipantItemSnapshot.safeParse({
      ...snapshot,
      lifecycle_status: 'live',
      profile_consent_accepted: true,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lifecycle_status).toBe('live');
      expect(result.data.profile_consent_accepted).toBe(true);
    }
  });

  it('accepts any string lifecycle_status (not enum-constrained here)', () => {
    expect(
      ParticipantItemSnapshot.safeParse({ ...snapshot, lifecycle_status: 'anything' }).success,
    ).toBe(true);
  });

  it('accepts an empty item_locations array', () => {
    expect(ParticipantItemSnapshot.safeParse({ ...snapshot, item_locations: [] }).success).toBe(
      true,
    );
  });

  it('rejects an out-of-range latitude in item_locations', () => {
    const result = ParticipantItemSnapshot.safeParse({
      ...snapshot,
      item_locations: [{ lat: 91, lng: 73.85 }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['item_locations', 0, 'lat']);
    }
  });

  it('rejects a location missing lng', () => {
    expect(
      ParticipantItemSnapshot.safeParse({ ...snapshot, item_locations: [{ lat: 18.5 }] }).success,
    ).toBe(false);
  });

  it('rejects a date-only created_at (ISO datetime required)', () => {
    const result = ParticipantItemSnapshot.safeParse({ ...snapshot, created_at: '2026-08-05' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['created_at']);
    }
  });

  it('rejects a non-uuid item_id', () => {
    expect(ParticipantItemSnapshot.safeParse({ ...snapshot, item_id: 'p1' }).success).toBe(false);
  });

  it('rejects a missing item_state', () => {
    const withoutState: Record<string, unknown> = { ...snapshot };
    delete withoutState.item_state;

    expect(ParticipantItemSnapshot.safeParse(withoutState).success).toBe(false);
  });
});

describe('UpsertParticipantResponse', () => {
  const responseBase = {
    user_id: 'usr_1',
    user_existed: true,
    owned_elsewhere: false,
    onboarded_at: ISO,
    items: [],
  };

  it('accepts a response with no items and no consent count', () => {
    const result = UpsertParticipantResponse.safeParse(responseBase);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.consent_recorded).toBeUndefined();
    }
  });

  it('accepts a null onboarded_at (never onboarded)', () => {
    expect(
      UpsertParticipantResponse.safeParse({ ...responseBase, onboarded_at: null }).success,
    ).toBe(true);
  });

  it('rejects an omitted onboarded_at (nullable, not optional)', () => {
    const withoutOnboardedAt: Record<string, unknown> = { ...responseBase };
    delete withoutOnboardedAt.onboarded_at;

    expect(UpsertParticipantResponse.safeParse(withoutOnboardedAt).success).toBe(false);
  });

  it('accepts an integer consent_recorded', () => {
    const result = UpsertParticipantResponse.safeParse({ ...responseBase, consent_recorded: 3 });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.consent_recorded).toBe(3);
    }
  });

  it('rejects a fractional consent_recorded', () => {
    expect(
      UpsertParticipantResponse.safeParse({ ...responseBase, consent_recorded: 1.5 }).success,
    ).toBe(false);
  });

  it('rejects a missing owned_elsewhere flag', () => {
    const withoutFlag: Record<string, unknown> = { ...responseBase };
    delete withoutFlag.owned_elsewhere;

    expect(UpsertParticipantResponse.safeParse(withoutFlag).success).toBe(false);
  });
});

describe('GetParticipantResponse', () => {
  const emptyCompliance = [
    { key: 'user_terms', value: false },
    { key: 'user_privacy', value: false },
    { key: 'has_age', value: false },
  ];

  it('accepts a null user_id with an all-false compliance array', () => {
    const result = GetParticipantResponse.safeParse({
      user_id: null,
      compliance: emptyCompliance,
      items: [],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.user_id).toBeNull();
      expect(result.data.compliance).toHaveLength(3);
    }
  });

  it('uses the same {key,value} shape the POST body accepts (#692)', () => {
    const result = GetParticipantResponse.safeParse({
      user_id: 'usr_1',
      compliance: [
        { key: 'user_terms', value: true },
        { key: 'user_privacy', value: false },
        { key: 'has_age', value: true },
      ],
      items: [],
    });

    expect(result.success).toBe(true);
  });

  it('rejects an unknown compliance key', () => {
    // The reported set is closed: `profile_creation` is item-level and is
    // reported per item, not here.
    const result = GetParticipantResponse.safeParse({
      user_id: 'usr_1',
      compliance: [{ key: 'profile_creation', value: true }],
      items: [],
    });

    expect(result.success).toBe(false);
  });

  it('rejects the old user_consent object shape', () => {
    const result = GetParticipantResponse.safeParse({
      user_id: 'usr_1',
      user_consent: { terms_accepted: true, privacy_accepted: true, has_age: true },
      items: [],
    });

    expect(result.success).toBe(false);
  });

  it('rejects a missing compliance array entirely', () => {
    expect(GetParticipantResponse.safeParse({ user_id: 'usr_1', items: [] }).success).toBe(false);
  });
});
