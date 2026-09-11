/**
 * Action-consent copy helpers.
 *
 * Action consent statements (in each network's `consent.json`) name the OTHER
 * party a user shares their contact details with — e.g. "…with this provider…".
 * That party isn't known when the config is loaded (a "connect" action can run
 * seeker→provider OR provider→seeker), so the statement ships a
 * `__COUNTERPARTY__` placeholder that the UI substitutes at render time from the
 * concrete action direction. This differs from `__SUPPORT_EMAIL__`, which is a
 * fixed value resolved once at config-load time server-side.
 *
 * - Request (initiate) popup → counterparty is the target being connected to.
 * - Accept popup → counterparty is the requester who initiated.
 */

export const CONSENT_COUNTERPARTY_PLACEHOLDER = '__COUNTERPARTY__';

/**
 * Human noun for a counterparty, derived from its domain id (per product
 * decision: use the domain id directly). Underscores become spaces and the
 * word stays lowercase so it reads naturally mid-sentence ("…with this
 * provider…"). Falls back to a neutral word when no domain is known.
 */
export function formatCounterpartyNoun(
  domainId: string | null | undefined,
): string {
  if (!domainId) return 'party';
  return domainId.replaceAll('_', ' ');
}

/**
 * Substitute `__COUNTERPARTY__` in an action-consent statement with `noun`. A
 * statement without the placeholder (e.g. an older, not-yet-migrated config) is
 * returned unchanged.
 */
export function renderConsentStatementWithNoun(
  statement: string,
  noun: string,
): string {
  if (!statement) return statement;
  return statement.split(CONSENT_COUNTERPARTY_PLACEHOLDER).join(noun);
}

/**
 * Substitute `__COUNTERPARTY__` with the noun for a single counterparty domain.
 * Used by the request (initiate) popup and single-action accept, where the
 * counterparty is one known domain.
 */
export function renderConsentStatement(
  statement: string,
  counterpartyDomainId: string | null | undefined,
): string {
  return renderConsentStatementWithNoun(
    statement,
    formatCounterpartyNoun(counterpartyDomainId),
  );
}

/**
 * Counterparty noun for a *batch* of accept actions. Bulk accept renders one
 * consent statement for the whole selection, which can span more than one source
 * (requester) domain (e.g. a provider accepting a mix of seeker and provider
 * requests). Rather than name a single (possibly wrong) party, join the distinct
 * domain nouns with " / " — e.g. "seeker / provider" — so every counterparty is
 * named. A single-domain batch yields one noun; an empty batch yields the
 * neutral fallback.
 */
export function formatBatchCounterpartyNoun(
  domainIds: ReadonlyArray<string | null | undefined>,
): string {
  const nouns = [
    ...new Set(domainIds.filter((d): d is string => Boolean(d))),
  ].map(formatCounterpartyNoun);
  return nouns.length > 0 ? nouns.join(' / ') : formatCounterpartyNoun(null);
}
