import { describe, it, expect, vi, beforeEach } from 'vitest';

// node:crypto's randomBytes is mocked so the modulo-bias guard below can feed
// exact byte sequences. ESM namespaces are not configurable, so vi.spyOn cannot
// reach it — the module has to be mocked, hoisted above the import under test.
//
// The mock DELEGATES to the real randomBytes by default (captured in the factory),
// so every test except the one that opts in still exercises the actual CSPRNG,
// and the delegation is signature-agnostic — a future switch to the
// randomBytes(n, cb) callback form would still work.
const crypto_stub = vi.hoisted(() => ({
  real: null as null | typeof import('node:crypto').randomBytes,
  fn: vi.fn(),
}));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  crypto_stub.real = actual.randomBytes;
  return { ...actual, randomBytes: (...args: unknown[]) => crypto_stub.fn(...args) };
});

import { buildSupportDetailsTable, generateSupportReference } from '../build_support_email';

beforeEach(() => {
  crypto_stub.fn.mockReset();
  crypto_stub.fn.mockImplementation(crypto_stub.real as never);
});

const base = {
  reference: 'SUP-20260709-AB12CD',
  name: 'Asha K',
  email: 'asha@example.com' as string | null,
  phone: '+919000000000' as string | null,
  submittedAt: '2026-07-09T10:00:00.000Z',
};

describe('buildSupportDetailsTable', () => {
  it('includes the reference, contact fields, submitted-at and consent row', () => {
    const html = buildSupportDetailsTable(base);
    expect(html).toContain('Contact details');
    expect(html).toContain('SUP-20260709-AB12CD');
    expect(html).toContain('Asha K');
    expect(html).toContain('asha@example.com');
    expect(html).toContain('+919000000000');
    expect(html).toContain('2026-07-09T10:00:00.000Z');
    expect(html).toContain('Consent to share contact');
    expect(html).toContain('Yes');
  });

  it('renders — for missing email/phone', () => {
    const html = buildSupportDetailsTable({ ...base, email: null, phone: null });
    expect(html).toContain('—');
  });

  it('HTML-escapes user-supplied name', () => {
    const html = buildSupportDetailsTable({ ...base, name: 'A<b>C' });
    expect(html).not.toContain('<b>C');
    expect(html).toContain('A&lt;b&gt;C');
  });

  it('HTML-escapes contact fields', () => {
    const html = buildSupportDetailsTable({
      ...base,
      email: '<script>alert(1)</script>@example.com',
    });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('generateSupportReference', () => {
  it('produces SUP-YYYYMMDD-XXXXXX using the UTC date', () => {
    const ref = generateSupportReference(new Date('2026-07-09T23:59:59.000Z'));
    expect(ref).toMatch(/^SUP-20260709-[2-9A-HJ-NP-Z]{6}$/);
  });

  it('is (practically) unique across calls', () => {
    const now = new Date('2026-07-09T00:00:00.000Z');
    const refs = new Set(Array.from({ length: 50 }, () => generateSupportReference(now)));
    expect(refs.size).toBeGreaterThan(1);
  });

  // Regression guard for the modulo bias fixed under #550. The alphabet is 31
  // characters, so bytes 248..255 are exactly the ones a plain `% 31` would
  // fold back onto indices 0..7 ('2'..'9'). They must be discarded, not used.
  //
  // The reject draw is chosen so the two implementations DISAGREE. 248 = 8 x 31,
  // so a draw of [248..253] folds to indices 0..5 under the old `% 31` — the
  // same '234567' the fixed version produces from the next draw, which would
  // make this assertion pass against the very bug it guards. [255..250] folds
  // to '987654' instead, so a revert fails here.
  it('discards the biased byte tail rather than folding it onto 2-9', () => {
    const draws = [
      Buffer.from([255, 254, 253, 252, 251, 250]), // all >= 248: all rejected
      Buffer.from([0, 1, 2, 3, 4, 5]), // accepted -> '2','3','4','5','6','7'
    ];
    let call = 0;
    crypto_stub.fn.mockImplementation((n: number) =>
      (draws[call++] ?? Buffer.alloc(n)).subarray(0, n),
    );

    // Fixed: '234567'. Pre-fix (single draw, plain modulo): '987654'.
    expect(generateSupportReference(new Date('2026-07-09T00:00:00.000Z'))).toBe(
      'SUP-20260709-234567',
    );
  });
});
