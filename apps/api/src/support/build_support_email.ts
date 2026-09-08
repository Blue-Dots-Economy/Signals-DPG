import { randomBytes } from 'node:crypto';

import { escapeHtml } from '@/notifications/email/substitute';

import { formatBytes } from './attachments';

export type SupportType = 'complaint' | 'support_request';

export const TYPE_LABELS: Record<SupportType, string> = {
  complaint: 'Complaint',
  support_request: 'Support Request',
};

// Crockford-style base32 alphabet (no 0/1/O/I ambiguity) for readable refs.
const REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const REFERENCE_LENGTH = 6;
// The alphabet is 31 characters, not 32 (2-9 plus A-Z less I, L and O), and 256
// is not a multiple of 31. A plain `byte % 31` therefore wraps bytes 248..255
// back onto indices 0..7, making '2'..'9' about 12.5% more likely to appear than
// any other character. Rejecting that tail and redrawing restores a uniform
// distribution. Acceptance is 248/256, so the redraw is rare.
// (CodeQL js/biased-cryptographic-random, #550)
const REFERENCE_BYTE_LIMIT = 256 - (256 % REFERENCE_ALPHABET.length);

/**
 * Generate a support reference of the form `SUP-YYYYMMDD-XXXXXX`, where the
 * date is UTC and the suffix is 6 crypto-random base32 characters. Pure apart
 * from the crypto RNG, so it is directly unit-testable (shape / date).
 */
export function generateSupportReference(now: Date): string {
  const yyyy = now.getUTCFullYear().toString().padStart(4, '0');
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = now.getUTCDate().toString().padStart(2, '0');

  let suffix = '';
  while (suffix.length < REFERENCE_LENGTH) {
    for (const byte of randomBytes(REFERENCE_LENGTH - suffix.length)) {
      if (byte >= REFERENCE_BYTE_LIMIT) continue;
      suffix += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
    }
  }

  return `SUP-${yyyy}${mm}${dd}-${suffix}`;
}

/**
 * Builds the escaped contact-details table for the support email — the
 * `{{detailsTable}}` html token (#529). Pure; all user-controlled strings are
 * HTML-escaped here, which is what licenses inserting the result raw.
 */
export function buildSupportDetailsTable(input: {
  reference: string;
  name: string;
  email: string | null;
  phone: string | null;
  submittedAt: string;
  /** Accepted attachments, for the "Attachments" row (#551). */
  attachments?: Array<{ filename: string; bytes: number }>;
}): string {
  const rows: Array<[string, string]> = [
    ['Reference', input.reference],
    ['Name', input.name],
    ['Phone', input.phone ?? '—'],
    ['Email', input.email ?? '—'],
    ['Submitted at', input.submittedAt],
    ['Consent to share contact', 'Yes'],
  ];
  // Listed in the body as well as carried as MIME parts, so a client that
  // collapses or hides attachments still tells the agent what was sent — and an
  // attachment lost in transit is visible as a discrepancy rather than silence.
  if (input.attachments?.length) {
    rows.push([
      `Attachments (${input.attachments.length})`,
      input.attachments.map((a) => `${a.filename} (${formatBytes(a.bytes)})`).join(', '),
    ]);
  }
  const detailRows = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:2px 8px;color:#666">${escapeHtml(label)}</td>` +
        `<td style="padding:2px 8px">${escapeHtml(value)}</td></tr>`,
    )
    .join('');
  return `<p style="margin:0 0 4px;font-weight:600">Contact details</p><table style="border-collapse:collapse;font-size:13px">${detailRows}</table>`;
}
