import { describe, it, expect } from 'vitest';
import { parseNetworkConfigDocument, PROFILE_GO_LIVE_GATES } from '../network_workflow';

const statusRules = [{ status: 'new', when: 'default' }];

/** Build a one-domain network config, overriding fields on that domain. */
const configWithDomain = (domain: Record<string, unknown>) => ({
  id: 'test_net',
  domains: [
    {
      id: 'seeker',
      item_schemas: { profile_1_0: { type: 'object' } },
      status_rules: statusRules,
      ...domain,
    },
  ],
  instances: [],
  cross_network_origins: [],
  actions: {},
});

describe('network_workflow go_live_required', () => {
  it('exposes the gate vocabulary', () => {
    expect(PROFILE_GO_LIVE_GATES).toEqual([
      'schema_required',
      'consent_required',
      'owner_required',
    ]);
  });

  it('omitted go_live_required parses (undefined — resolver applies the default)', () => {
    const parsed = parseNetworkConfigDocument(configWithDomain({}));
    expect(parsed.domains[0].go_live_required).toBeUndefined();
  });

  it('accepts a valid gate list', () => {
    const parsed = parseNetworkConfigDocument(
      configWithDomain({ go_live_required: ['schema_required', 'consent_required'] }),
    );
    expect(parsed.domains[0].go_live_required).toEqual(['schema_required', 'consent_required']);
  });

  it('accepts schema_required alone', () => {
    const parsed = parseNetworkConfigDocument(
      configWithDomain({ go_live_required: ['schema_required'] }),
    );
    expect(parsed.domains[0].go_live_required).toEqual(['schema_required']);
  });

  it('rejects an empty array (a profile with no gates would go live instantly)', () => {
    expect(() =>
      parseNetworkConfigDocument(configWithDomain({ go_live_required: [] })),
    ).toThrow();
  });

  it('rejects an unknown gate token', () => {
    expect(() =>
      parseNetworkConfigDocument(configWithDomain({ go_live_required: ['schema_required', 'nope'] })),
    ).toThrow();
  });

  it('rejects a guardian-gated domain that drops consent_required', () => {
    expect(() =>
      parseNetworkConfigDocument(
        configWithDomain({
          guardian_consent_required: true,
          go_live_required: ['schema_required'],
        }),
      ),
    ).toThrow(/consent_required/);
  });

  it('allows a guardian-gated domain that keeps consent_required', () => {
    const parsed = parseNetworkConfigDocument(
      configWithDomain({
        guardian_consent_required: true,
        go_live_required: ['schema_required', 'consent_required'],
      }),
    );
    expect(parsed.domains[0].go_live_required).toContain('consent_required');
  });
});
