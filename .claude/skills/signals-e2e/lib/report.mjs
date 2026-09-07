// The five-section signoff (plus a 2b: Flaky, added by the field-test fix
// below). A Playwright list reporter answers "did the suite pass"; the
// question a signoff has to answer is "can this ship, and what did nobody
// check" — which needs the skips and the untestable surface promoted to
// first-class output rather than scrolled past.
//
// Sections, in this fixed order:
//   1. Working        — passes, grouped by suite. Deduped on (spec file,
//                        title) BEFORE categorisation — preflight runs as a
//                        dependency of both the api and ui Playwright
//                        projects, so every one of its specs would otherwise
//                        appear twice once results are merged.
//   2. Not working     — failures, GROUPED BY ROOT CAUSE (a shared, masked
//                        error signature), each group carrying a count and a
//                        conservative suite-defect/capability-gap/drift/
//                        unattributed tag — never a guessed product-defect
//                        tag. Ten specs failing on one
//                        collision read as one group of ten, not ten unrelated
//                        defects. Cleanup residue lands here too, as a
//                        synthetic entry, because a run that leaves rows
//                        behind makes the next run lie.
//   2b. Flaky          — specs that failed on their FIRST attempt and passed
//                        on Playwright's retry. Never counted as a pass, and
//                        never folded into section 1 — the retry did not
//                        resolve anything, it only hid the failure that
//                        identifies the bug. Carries the first attempt's
//                        error, not the retry's.
//   3. Known/expected  — specs annotated `@known`, so documented look-like-bugs
//                        (the map count below the list total, `x-uri` through a
//                        `$ref`) never pollute section 2.
//   4. What a pass here still does not prove — ONLY coverage.md's
//                        `human-only` block: the standing limits of the
//                        black-box approach itself (brand skin, real OIDC,
//                        wallet imports, ...) — true no matter how this
//                        target is configured. Renamed from "Needs a human"
//                        (field-test fix E) because that name kept
//                        attracting MECHANICAL skip provenance, which is a
//                        different kind of fact and reads as prose-noise
//                        here. Never hand-deduped for counts — coverage.md's
//                        list is already unique by construction.
//   5. Coverage drift   — whatever `npm run coverage` found unmapped, passed in
//                        by the caller (that check lives in scripts/, this file
//                        only renders what it's told).
//
// The MECHANICAL provenance that used to live in section 4 — every capability
// skip's reason (deduped with `(×N)` counts), coverage.md's small
// `capability-gated` block (a gate with no live skip to derive from yet), and
// — on a scoped run — one line per suite this run did not touch — is instead
// rendered right under the "⏭️ Skipped (capability-gated)" row in the
// at-a-glance table (`skipSummary` / `capabilityGated` / `notRunSuites` on
// `ReportSections`). It is the SAME information as that counter, just spelled
// out — re-deriving it as a second, separately-maintained prose list would
// only let it drift from the counter it explains, so it stays mechanically
// derived from the same skip data, never hand-written.
//
// Exit code is non-zero if section 2 (Not working) OR 2b (Flaky) is
// non-empty. A bare `test.skip` (no capability reason, no annotation) is NOT
// quietly dropped — `capabilities.ts` guarantees a reason for every
// capability skip, so a skip with none is itself a defect and is surfaced in
// section 2, not folded into the skip provenance where it would look like an
// intentional, documented gap.
//
// `buildReport` returns plain data (`ReportSections`); `renderMarkdown` is the
// only thing that knows about headings and bullet formatting, so a future
// caller (a Slack summary, a GitHub check) can consume the data without
// parsing markdown back out of it.

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// The suite catalogue (spec §4). This mirrors `coverage.md`'s table by hand —
// `buildReport`'s input contract is fixed at `{results, humanOnly, scoped,
// residue}` (Task 10 depends on that exact shape), so the catalogue can't be
// threaded through as parsed markdown. If a suite is renumbered, update both.
// ---------------------------------------------------------------------------
export const SUITES = [
  { id: 0, name: 'Preflight & stack-up' },
  { id: 1, name: 'Config, schema, served domains' },
  { id: 2, name: 'Auth & account' },
  { id: 3, name: 'User consent + legal' },
  { id: 4, name: 'Profile creation (schema-driven)' },
  { id: 5, name: 'U18 / guardian' },
  { id: 6, name: 'Browse / list' },
  { id: 7, name: 'Map' },
  { id: 8, name: 'Actions' },
  { id: 9, name: 'Match score' },
  { id: 10, name: 'Lifecycle' },
  { id: 11, name: 'Public / shareable profile' },
  { id: 12, name: 'Contact support' },
  { id: 13, name: 'Integrator surface' },
  { id: 14, name: 'Inter-instance / peer' },
  { id: 15, name: 'Cross-cutting UI' },
  { id: 16, name: 'Tourist (orange_dot)' },
];

const ANSI = /\[[0-9;]*m/g;
const stripAnsi = (s) => String(s ?? '').replace(ANSI, '');

/**
 * Parse one `## <heading>` bullet block out of `coverage.md` — shared by
 * `parseHumanOnly` (the standing-limits list, section 4's body) and
 * `parseCapabilityGated` (the small "not wired to a live skip yet" list,
 * rendered next to the at-a-glance skip counter instead — field-test fix E
 * split these two, which used to be one flattened list).
 *
 * Format: the heading, then `- entry` bullets until the next `##` heading or
 * end of file. Blank lines and HTML comments (`<!-- ... -->`, single- or
 * multi-line) are tolerated and skipped. Anything else in the block — a
 * stray paragraph, a malformed bullet, an empty bullet — is a loud error,
 * not a silently-dropped line: both lists exist specifically to tell a
 * reader what still needs their attention, so a parser that quietly
 * produces fewer entries than were written is worse than one that refuses
 * to run.
 *
 * An empty block (heading present, zero entries) is also a hard error: it
 * would tell a reader "nothing needs your attention", which is the exact
 * lie these sections exist to prevent.
 */
function parseBulletBlock(markdown, headingRegex, sectionLabel) {
  const lines = markdown.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => headingRegex.test(l.trim()));
  if (startIdx === -1) {
    throw new Error(
      `coverage.md is missing its '## ${sectionLabel}' section. This block is load-bearing ` +
        '(it feeds the signoff report) — a missing section is a hard error, not an empty list.',
    );
  }

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (/^##\s+\S/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }

  const entries = [];
  let inComment = false;
  for (const raw of lines.slice(startIdx + 1, endIdx)) {
    const line = raw.trim();
    if (line === '') continue;

    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (line.startsWith('<!--')) {
      if (!line.includes('-->')) inComment = true;
      continue;
    }

    const m = /^[-*]\s+(.+)$/.exec(line);
    if (!m) {
      throw new Error(
        `coverage.md's '${sectionLabel}' block has an unrecognised line (expected "- entry", ` +
          `a blank line, or an HTML comment): "${raw}"`,
      );
    }
    const entry = m[1].trim();
    if (!entry) {
      throw new Error(`coverage.md's '${sectionLabel}' block has an empty bullet entry.`);
    }
    entries.push(entry);
  }

  if (entries.length === 0) {
    throw new Error(
      `coverage.md's '${sectionLabel}' block parsed to zero entries. An empty list here would tell ` +
        'a reader nothing needs their attention, which is exactly the lie this section exists to prevent.',
    );
  }
  return entries;
}

/**
 * Parse `coverage.md`'s `## human-only` block — the standing limits of the
 * black-box approach itself (section 4's body: "what a pass here still does
 * not prove"). Deliberately excludes anything a config gate could close —
 * see `parseCapabilityGated` for that half.
 */
export function parseHumanOnly(markdown) {
  return parseBulletBlock(markdown, /^##\s+human-only\s*$/i, 'human-only');
}

/**
 * Parse `coverage.md`'s `## capability-gated` block — surface that is "not
 * configured here" but has no live `requireCapabilities()` call to derive a
 * skip reason from yet, so it would otherwise never appear anywhere in the
 * report. Everything that DOES have a live capability check is derived
 * straight from this run's own skips (`skipSummary` in `buildReport`) and
 * never belongs here — this block is only for the gap in between.
 */
export function parseCapabilityGated(markdown) {
  return parseBulletBlock(markdown, /^##\s+capability-gated\s*$/i, 'capability-gated');
}

/**
 * Parse `coverage.md`'s suite table (the `| # | Suite | ... | ... |` rows
 * under `## Suites`) into the same `{id, name}` shape as the `SUITES`
 * constant above. This is the cheap de-duplication a Task 8 reviewer proposed
 * for the fact that `SUITES` restates that table by hand: `buildReport`'s
 * input contract stays `{results, humanOnly, scoped, residue}` (frozen), so
 * this is threaded through as an *optional* `input.suites`, defaulting to the
 * exported constant — a renumbered suite only has to change in one place
 * (`coverage.md`) instead of two, without touching the function signature
 * every existing caller already relies on.
 *
 * Matches on a leading `| <digits> |` so it can't accidentally pick up the
 * `## human-only` bullet list or any other prose elsewhere in the file — the
 * only other content shaped like that is the suite table itself.
 */
export function parseSuiteTable(markdown) {
  const suites = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|/.exec(line);
    if (!m) continue;
    // Strip markdown inline-code backticks (e.g. "Tourist (`orange_dot`)")
    // so a parsed name matches the plain-string SUITES constant exactly.
    suites.push({ id: Number(m[1]), name: m[2].trim().replace(/`/g, '') });
  }
  if (suites.length === 0) {
    throw new Error(
      "coverage.md's suite table parsed to zero rows — expected '| # | Suite | ... |' rows under '## Suites'.",
    );
  }
  return suites;
}

/** True if any annotation marks this as a documented, non-bug behaviour. */
function hasKnownAnnotation(annotations) {
  return annotations.some(
    (a) => a && (a.type === 'known' || (typeof a.description === 'string' && /@known\b/.test(a.description))),
  );
}

/** The capability (or other) reason attached to a skip, if any. */
function skipReason(annotations) {
  const capability = annotations.find(
    (a) => a && typeof a.description === 'string' && a.description.startsWith('[capability]'),
  );
  if (capability) return capability.description.replace(/^\[capability\]\s*/, '').trim();

  const anyReasoned = annotations.find((a) => a && a.type === 'skip' && typeof a.description === 'string' && a.description.trim());
  return anyReasoned ? anyReasoned.description.trim() : null;
}

/** The last (authoritative) result per `test` entry — a retry that later passed is not a failure. */
function finalResults(spec) {
  return (spec.tests ?? []).map((t) => {
    const results = t.results ?? [];
    return { test: t, result: results[results.length - 1] ?? null };
  });
}

function findAttachmentPath(results, name) {
  for (const r of results) {
    const hit = (r.attachments ?? []).find((a) => a && a.name === name && a.path);
    if (hit) return hit.path;
  }
  return null;
}

function tracePathFor(results) {
  return findAttachmentPath(results, 'trace') ?? findAttachmentPath(results, 'screenshot');
}

function errorMessagesFor(results) {
  const msgs = [];
  for (const r of results) {
    // The JSON reporter carries both the newer `errors[]` array and the
    // older singular `error` field for the SAME failure — prefer the array
    // and only fall back to the singular field when it is absent, or every
    // failure would be reported twice.
    const fromArray = (r.errors ?? []).map((e) => e?.message).filter(Boolean);
    if (fromArray.length) msgs.push(...fromArray.map(stripAnsi));
    else if (r.error?.message) msgs.push(stripAnsi(r.error.message));
  }
  return msgs.length ? msgs : ['(no error message captured)'];
}

/** Walk the (possibly nested) Playwright JSON suite tree, yielding each leaf spec with its suite path. */
function* walkSpecs(suites, path = []) {
  for (const suite of suites ?? []) {
    const nextPath = [...path, suite.title];
    if (suite.suites?.length) yield* walkSpecs(suite.suites, nextPath);
    for (const spec of suite.specs ?? []) yield { spec, path: nextPath };
  }
}

/**
 * The outcome of ONE `JSONReportTest` entry. Real Playwright JSON always
 * carries `test.status` (`'skipped' | 'expected' | 'unexpected' | 'flaky'`) —
 * that field, not the last result alone, is what actually distinguishes "hard
 * failure" from "flaky" (retried, and the retry passed). Hand-built fixtures
 * (this file's own unit tests) may omit `status` entirely; for those, derive
 * the same shape from `results` alone so the fixtures don't all have to be
 * rewritten just to add a field they were never asserting on.
 */
function testOutcome(t) {
  if (t && typeof t.status === 'string') return t.status;
  const results = t?.results ?? [];
  if (results.length === 0) return 'unexpected';
  const last = results[results.length - 1];
  const anyEarlierFailed = results.slice(0, -1).some((r) => r.status === 'failed' || r.status === 'timedOut');
  if (last.status === 'passed') return anyEarlierFailed ? 'flaky' : 'expected';
  if (last.status === 'skipped') return 'skipped';
  return 'unexpected';
}

// Worst-first, so a spec with more than one `test` entry (repeat-each, more
// than one project) reports its single worst outcome rather than silently
// picking whichever happens to be last in the array.
const OUTCOME_PRIORITY = { unexpected: 0, flaky: 1, skipped: 2, expected: 3 };

/**
 * Root-cause grouping (R1). The raw message with every run-specific
 * identifier masked out — so "23505 phone_number already exists" from three
 * different workers, each with a DIFFERENT generated phone number, collapses
 * to the same signature, while two genuinely different errors never do.
 * Order matters: UUIDs and emails are masked before the generic long-digit-run
 * pass, or the digits inside them would already be gone and the more specific
 * placeholder would never apply.
 */
export function normalizeErrorSignature(message) {
  return String(message ?? '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '<email>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.,]+Z?/g, '<timestamp>')
    .replace(/\+?\d[\d ()-]{8,}\d/g, '<phone>')
    .replace(/\b\d{5,}\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A CSS/design-token-shaped value: oklch()/rgb()/rgba()/hsl()/hsla(), a hex
 * colour, or a plain CSS length (px/rem/em/%). Used only by the `drift` rule
 * below — a value shaped like this on BOTH sides of a failed equality is what
 * distinguishes "two hand-maintained constants disagree" from an ordinary
 * assertion that happens to fail on a string.
 */
const CSS_VALUE_SHAPE = /^(oklch\(|rgba?\(|hsla?\(|#[0-9a-f]{3,8}\b|-?\d+(\.\d+)?(px|rem|em|%))/i;

/**
 * Suite-defect / capability-gap / drift vs product-defect, CONSERVATIVELY.
 * Only error shapes carrying their own evidence get a non-`unattributed` tag;
 * everything else is `unattributed`. This function never returns
 * `product-defect` — that call needs a human reading the actual assertion. A
 * wrong "suite bug" (or "not configured here", or "just drift") label teaches
 * a reader to dismiss a real defect, which is worse than no label at all, so
 * the bar here is "the text itself proves it", not "it looks
 * infrastructure-shaped".
 */
export function classifySuiteVsProduct(rawMessages) {
  const joined = rawMessages.join('\n');
  if (/\b23505\b/.test(joined) && /(phone_number|email|already exists|duplicate key)/i.test(joined)) {
    return {
      verdict: 'suite-defect',
      reason:
        'duplicate-key violation (23505) on a fixture-generated identifier — a collision in generated ' +
        'test data, not a product defect.',
    };
  }
  if (/No tests found|did not match any files/i.test(joined)) {
    return {
      verdict: 'suite-defect',
      reason: 'Playwright matched zero tests for this invocation — a suite/config wiring issue, not a product failure.',
    };
  }
  // Missing browser binary. Meets this function's own bar — the text carries its
  // own evidence and even names the remedy ("Please run ... npx playwright
  // install"). Evidenced live: a first run on a host without browsers produced
  // 22 identical failures that all landed as `unattributed`, i.e. 22 setup
  // errors presented to a human as possible product defects. run.sh now
  // preflights this, so reaching here means the browsers went missing mid-run;
  // either way it is never a product failure.
  if (/Executable doesn't exist/i.test(joined) && /playwright install/i.test(joined)) {
    return {
      verdict: 'suite-defect',
      reason:
        'the Playwright browser binary is missing on this host (the error names the fix: ' +
        '`npx playwright install`) — an environment/setup gap, not a product defect.',
    };
  }
  // G5 rule 2 — a `waitForResponse` timeout on a KNOWN optional/env-gated
  // endpoint (evidenced live: journey-match-score.ui.spec.ts's
  // `/api/v1/match-score/calculate` wait, timing out because
  // `MATCH_SCORE_PROVIDER` is unset on the target — the UI never fires the
  // request, so there is no response to wait for). Checked BEFORE the
  // generic locator-timeout rule below, whose broader `waiting for` clause
  // would otherwise catch this first and mislabel a config gap as a plain
  // selector defect. Deliberately narrow (one evidenced endpoint, not a
  // guess at "any waitForResponse timeout is probably unconfigured infra") —
  // extend this list only when a NEW endpoint is confirmed to fail the same
  // way, never speculatively.
  if (/waitForResponse/i.test(joined) && /Timeout \d+ms exceeded/i.test(joined) && /match-score/i.test(joined)) {
    return {
      verdict: 'capability-gap',
      reason:
        'a waitForResponse timeout on /match-score/calculate — this endpoint is optional infra ' +
        '(getMatchScoreClient() returns undefined with MATCH_SCORE_PROVIDER unset), so the UI never fires ' +
        'the request and there is no response to wait for. Gate the spec on the matchScore capability ' +
        'instead of asserting blind; not a suite or product defect.',
    };
  }
  // G5 rule 2, second confirmed endpoint — same shape as the match-score rule
  // above, and checked BEFORE the generic locator rule for the same reason.
  // `GET /api/v1/support/config` reports `enabled: false` unless BOTH
  // SUPPORT_EMAIL and NOTIFICATION_FROM_EMAIL are set (support_config.ts mirrors
  // the submit route's 503 condition), and the UI gates the whole menu entry on
  // it (`{supportConfig.enabled && ...}` in user-menu.tsx) — so the button never
  // renders and a CORRECT locator times out. Evidenced: on a real run the recipe
  // set neither var and this failure was reported as a selector defect.
  // bring-stack-up.sh now sets both, so reaching here means support is off on
  // the target being tested rather than the spec being wrong.
  if (
    /Timeout \d+ms exceeded/i.test(joined) &&
    /(waiting for|locator|selector)/i.test(joined) &&
    /Contact support/i.test(joined)
  ) {
    return {
      verdict: 'capability-gap',
      reason:
        'a locator timeout on the "Contact support" entry — the UI hides it entirely when ' +
        '/api/v1/support/config reports `enabled: false`, which happens unless BOTH SUPPORT_EMAIL and ' +
        'NOTIFICATION_FROM_EMAIL are set on the target. The selector is correct; support is switched ' +
        'off. Not a suite or product defect.',
    };
  }
  if (/Timeout \d+ms exceeded/i.test(joined) && /(waiting for|locator|selector)/i.test(joined)) {
    return {
      verdict: 'suite-defect',
      reason: "a selector/locator timeout — points at the test's own wait/selector, not a confirmed product defect.",
    };
  }
  if (/residue in \d+ table|cleanup\.sh exited non-zero/i.test(joined)) {
    return {
      verdict: 'suite-defect',
      reason: 'cleanup/residue failure — leftover test data from this run, not a product defect.',
    };
  }
  // G5 rule 1 — an equality assertion where BOTH "Expected"/"Received" look
  // like a CSS/design-token value (evidenced live: network-themes.ts's
  // `--brand-cta` constant vs. the value index.css actually serves, both
  // `oklch(...)` strings). Two hand-maintained constants disagreeing is
  // config/product DRIFT — a real thing to fix, but not a bug in the suite
  // itself, and not confidently a "product defect" either without a human
  // deciding which side is stale.
  const constMismatch = /Expected:\s*"([^"]*)"[\s\S]{0,400}?Received:\s*"([^"]*)"/.exec(joined);
  if (constMismatch && CSS_VALUE_SHAPE.test(constMismatch[1].trim()) && CSS_VALUE_SHAPE.test(constMismatch[2].trim())) {
    return {
      verdict: 'drift',
      reason:
        'both sides of this failed equality are CSS/design-token-shaped values (e.g. oklch/hex/rgb/a length) — ' +
        'a mismatch between two hand-maintained constants (e.g. an imported theme value vs. a rendered CSS ' +
        'value), not a suite defect. A human still has to say which side is stale.',
    };
  }
  return {
    verdict: 'unattributed',
    reason: 'no known suite-noise signature matched this error — it needs a human to read the actual assertion before attributing it either way.',
  };
}

/** Group `notWorking` entries by normalized signature (R1). Order = first-seen. */
export function groupFailures(notWorking) {
  const groups = new Map();
  const order = [];
  for (const f of notWorking) {
    const sig = normalizeErrorSignature(f.rawError ?? f.detail);
    if (!groups.has(sig)) {
      groups.set(sig, []);
      order.push(sig);
    }
    groups.get(sig).push(f);
  }
  return order.map((sig) => {
    const members = groups.get(sig);
    const { verdict, reason } = classifySuiteVsProduct(members.map((m) => m.rawError ?? m.detail));
    return { signature: sig, count: members.length, members, verdict, reason };
  });
}

/**
 * Dedupe a list of strings, collapsing exact repeats into one entry suffixed
 * `(×N)`, preserving FIRST-SEEN order (R2). A unique entry is returned
 * unchanged — no `(×1)` noise.
 */
export function dedupeWithCounts(entries) {
  const counts = new Map();
  const order = [];
  for (const e of entries) {
    if (!counts.has(e)) {
      counts.set(e, 0);
      order.push(e);
    }
    counts.set(e, counts.get(e) + 1);
  }
  return order.map((e) => (counts.get(e) > 1 ? `${e} (×${counts.get(e)})` : e));
}

/**
 * Build the five report sections from a Playwright JSON reporter payload plus
 * the run's other signoff inputs. Pure function — no I/O — so it is exactly
 * what `report.test.ts` drives directly.
 *
 * @param {object} input
 * @param {{suites: any[], errors?: any[], stats?: object}} input.results  Parsed Playwright JSON reporter output.
 * @param {string[]} input.humanOnly        `coverage.md`'s parsed `human-only` list — section 4's
 *   body ONLY (standing limits of the approach itself). Never mixed with mechanical skip
 *   provenance any more (field-test fix E) — see `skipSummary`/`capabilityGated` below.
 * @param {string[]} [input.capabilityGated] `coverage.md`'s parsed `capability-gated` list — a
 *   config gate with no live `requireCapabilities()` call to derive a skip reason from yet.
 *   Rendered next to `skipSummary`, not folded into `needsHuman`.
 * @param {{alias: string, suites: number[]} | null} input.scoped  Set on a scoped run.
 * @param {number} input.residue            `cleanup.sh`'s residue table count (0 = clean).
 * @param {number} [input.cleanupCode]      `cleanup.sh`'s own exit code (0 = ok). A non-zero code
 *   that ISN'T reflected in `residue` (a hard failure like an unreadable snapshot count, which
 *   `run.sh`'s grep-for-"RESIDUE" derivation of `residue` can't see) still has to fail the run.
 * @param {string[]} [input.coverageDrift]  Pre-formatted lines from `npm run coverage --json`.
 * @param {{id: number, name: string}[]} [input.suites]  The suite catalogue,
 *   defaulting to `SUITES`. Pass `parseSuiteTable(coverageMdText)` to source it
 *   from `coverage.md` instead of the hand-maintained constant.
 * @param {object} [input.gitInfo]  Both checkouts' git provenance (R5) — see
 *   `report.d.mts`'s `GitInfo`. Rendered verbatim; `buildReport` never
 *   inspects it beyond passing it through.
 */
export function buildReport(input) {
  const {
    results,
    humanOnly = [],
    capabilityGated = [],
    scoped = null,
    residue = 0,
    cleanupCode = 0,
    coverageDrift = [],
    suites = SUITES,
    gitInfo = null,
  } = input;

  const working = [];
  const notWorking = [];
  const known = [];
  const flaky = [];
  const skipReasons = [];

  // R3 — preflight runs as a dependency of BOTH the api and ui Playwright
  // projects, so every one of its specs is present, identically, in both
  // `results-api.json` and `results-ui.json` before they get merged into one
  // file here. `spec.file` + `spec.title` identifies "the same test, run
  // twice" without any risk of collapsing two DIFFERENT tests that merely
  // share a title in different files. First occurrence wins; later ones are
  // dropped BEFORE categorisation, so every count downstream (the at-a-glance
  // table, the per-spec-file table, root-cause grouping) is already correct
  // rather than needing its own separate dedupe.
  const seenSpecKeys = new Set();

  // A top-level Playwright error (a throwing fixture, a bad config, "No
  // tests found" for a --grep matching nothing) or a stats block reporting
  // zero tests executed are BOTH signs this results.json cannot be trusted
  // as "nothing failed" — walkSpecs below would see zero specs either way
  // and let a run in which NOTHING ran report clean. `stats` is only
  // checked when present: real Playwright JSON always includes it, but a
  // hand-built fixture (unit tests below) that omits it entirely is not
  // claiming anything about executed-test counts, so it is not penalised
  // for the omission.
  const topLevelErrors = (results.errors ?? [])
    .map((e) => (typeof e === 'string' ? e : e?.message))
    .filter(Boolean);
  const stats = results.stats;
  // `unexpected` (failed) and `flaky` (failed at least once, passed on
  // retry) both mean something ran — omitting them made an all-failed run
  // gain a second, misleading "zero tests executed" entry alongside its real
  // failures, and made a run whose only spec passed on retry exit non-zero
  // (zeroExecuted true) while section 1 correctly showed it as working.
  const zeroExecuted =
    !!stats &&
    Number(stats.expected ?? 0) +
      Number(stats.skipped ?? 0) +
      Number(stats.unexpected ?? 0) +
      Number(stats.flaky ?? 0) ===
      0;
  if (topLevelErrors.length > 0 || zeroExecuted) {
    const reasons = [...topLevelErrors];
    if (zeroExecuted) {
      reasons.push(
        `stats report zero tests executed (expected=${stats.expected ?? 0}, skipped=${stats.skipped ?? 0}, ` +
          `unexpected=${stats.unexpected ?? 0}, flaky=${stats.flaky ?? 0})`,
      );
    }
    notWorking.push({
      suite: 'playwright',
      title: 'suite reported no executable tests',
      detail:
        'This results.json carries a top-level error and/or zero executed tests — a run in which ' +
        `nothing actually ran is a failure, not a silent pass:\n  ${reasons.join('\n  ')}`,
      trace: null,
    });
  }

  for (const { spec, path } of walkSpecs(results.suites)) {
    const suiteLabel = path[0] ?? '(root)';

    const specKey = `${spec.file ?? suiteLabel}::${spec.title}`;
    if (seenSpecKeys.has(specKey)) continue;
    seenSpecKeys.add(specKey);

    const testsArr = spec.tests ?? [];
    if (testsArr.length === 0) continue; // nothing ran for this spec at all

    // Worst-first across every `test` entry this spec has (normally exactly
    // one) — see OUTCOME_PRIORITY's comment.
    const withOutcome = testsArr.map((t) => ({ t, outcome: testOutcome(t) }));
    withOutcome.sort((a, b) => OUTCOME_PRIORITY[a.outcome] - OUTCOME_PRIORITY[b.outcome]);
    const outcome = withOutcome[0].outcome;

    const attempts = finalResults(spec).filter((a) => a.result);
    const results_ = attempts.map((a) => a.result);
    const annotations = [
      ...(spec.annotations ?? []),
      ...attempts.flatMap((a) => a.test.annotations ?? []),
    ];

    if (outcome === 'unexpected') {
      const detail =
        `${suiteLabel} › ${spec.title}\n  ${errorMessagesFor(results_).join('\n  ')}` +
        (tracePathFor(results_) ? `\n  trace: ${tracePathFor(results_)}` : '\n  trace: (none captured)');
      const entry = {
        suite: suiteLabel,
        title: spec.title,
        detail,
        trace: tracePathFor(results_),
        rawError: errorMessagesFor(results_).join('\n'),
      };
      if (hasKnownAnnotation(annotations)) known.push(entry);
      else notWorking.push(entry);
      continue;
    }

    if (outcome === 'flaky') {
      // R4 — carry the FIRST attempt's error, never the retry's. The retry
      // passing is exactly what made this worth investigating: it is the
      // ORIGINAL failure that identifies the bug, not the fact that trying
      // again happened to succeed. "One restart is a fix; a retry loop is a
      // lie" — this is the report's own enforcement of that rule.
      const flakyEntry = withOutcome.find((w) => w.outcome === 'flaky') ?? withOutcome[0];
      const firstResult = (flakyEntry.t.results ?? [])[0] ?? null;
      const firstAttemptResults = firstResult ? [firstResult] : [];
      const firstMsgs = errorMessagesFor(firstAttemptResults);
      const detail =
        `${suiteLabel} › ${spec.title}\n  FIRST ATTEMPT (the retry later passed — this is what actually happened):\n  ${firstMsgs.join('\n  ')}` +
        (tracePathFor(firstAttemptResults)
          ? `\n  trace: ${tracePathFor(firstAttemptResults)}`
          : '\n  trace: (none captured on the first attempt)');
      flaky.push({
        suite: suiteLabel,
        title: spec.title,
        detail,
        trace: tracePathFor(firstAttemptResults),
        rawError: firstMsgs.join('\n'),
      });
      continue;
    }

    if (outcome === 'skipped') {
      const reason = skipReason(annotations);
      if (reason) {
        skipReasons.push(reason);
        // Not a failure — the environment chose not to run it, on purpose,
        // for a stated reason. It still "worked" in the sense of not being
        // broken; the reason itself is what makes section 4 honest.
        working.push({ suite: suiteLabel, title: spec.title, skipped: true });
      } else {
        // A bare `test.skip` with no reason at all. `capabilities.ts`
        // guarantees a reason for every capability skip, so the absence of
        // one means someone wrote a naked skip — that is a defect in the
        // suite, not a documented gap, and belongs in section 2.
        notWorking.push({
          suite: suiteLabel,
          title: spec.title,
          detail: `${suiteLabel} › ${spec.title}\n  skipped with no reason (a bare test.skip is a defect — every capability skip must carry a reason)`,
          trace: null,
          rawError: 'skipped with no reason',
        });
      }
      continue;
    }

    // outcome === 'expected'
    working.push({ suite: suiteLabel, title: spec.title, skipped: false });
  }

  if (residue > 0) {
    const detail =
      `cleanup.sh reported residue in ${residue} table(s) after teardown. A run that leaves rows ` +
      'behind makes the next run lie (newPhone() derives its sequence from the run id, so leftover ' +
      "rows collide with the next run's identities) — that is worth failing over, not a footnote.";
    notWorking.push({ suite: 'cleanup', title: 'post-run residue check', detail, trace: null, rawError: detail });
  }

  // cleanup.sh can exit non-zero for a reason the residue count above never
  // sees: `run.sh` derives `residue` by grepping cleanup's stdout for the
  // "RESIDUE " line prefix, but a hard failure (an unreadable snapshot count,
  // a lock timeout, an unreachable target) prints a DIFFERENT prefix
  // ("FAIL — ...") and still exits non-zero. Only surfaced when `residue`
  // itself is 0 — a non-zero residue already produced its own entry above,
  // and a non-zero cleanup exit alongside real residue is the same failure,
  // not two.
  if (cleanupCode !== 0 && residue === 0) {
    const detail =
      `cleanup.sh exited ${cleanupCode} while reporting zero residue rows — a hard failure (an ` +
      'unreadable snapshot count, an unreachable target, a lock timeout) rather than leftover rows, ' +
      "which the residue count can't see on its own. See the run's cleanup-final.log for the actual " +
      'message; a non-zero cleanup exit is never a clean run.';
    notWorking.push({ suite: 'cleanup', title: 'cleanup.sh exited non-zero', detail, trace: null, rawError: detail });
  }

  // R2 — mechanical skip provenance, dedupe with counts. `skipReasons` can
  // carry the exact same capability reason once per spec (e.g. "requires
  // service-caller credentials" for every spec in a service-gated suite) —
  // dedupe with counts, first-seen order preserved, so a reader sees ONE
  // line per distinct reason instead of scrolling past 20 identical ones.
  //
  // Field-test fix E split what used to be one flattened "needsHuman" list
  // into two categorically different things (a prior field test's own
  // complaint: mechanical skip provenance and the approach's standing limits
  // were summing two incommensurable things under one count):
  //  - `skipSummary` — MECHANICAL, derived straight from this run's own
  //    capability skips. This is the SAME information as the "⏭️ Skipped
  //    (capability-gated)" counter above it, just spelled out — so it is
  //    rendered right next to that counter, not in section 4.
  //  - `needsHuman` — now ONLY `coverage.md`'s `human-only` block: the
  //    approach's STANDING limits (section 4's body, renamed "What a pass
  //    here still does not prove"). Nothing mechanical is mixed in any more.
  // `capabilityGated` and `notRunSuites` are the two edge cases that are
  // mechanical in NATURE but can't be derived from `skipReasons` itself (no
  // live skip exists for them) — see their own fields below.
  const skipSummary = dedupeWithCounts(skipReasons);
  const needsHuman = dedupeWithCounts(humanOnly);

  // A scoped run's untouched suites are mechanical provenance too (closer to
  // `skipSummary` than to the standing-limits list) — a suite this
  // invocation never touched is "not exercised THIS run", not "can never be
  // exercised by this approach", so it does not belong in `needsHuman`
  // alongside things like "real Keycloak/OIDC login" that are true no matter
  // what ran. Kept as its own field (not merged into `skipSummary`) because
  // it is not a skip reason at all — it is the complement of `scoped.suites`
  // against the whole catalogue, and always renders as its own labeled list
  // rather than one dedupe-with-counts line.
  const notRunSuites = [];
  if (scoped) {
    const ran = new Set(scoped.suites ?? []);
    for (const suite of suites) {
      if (!ran.has(suite.id)) {
        notRunSuites.push(`Suite ${suite.id} (${suite.name}) — not run in this invocation`);
      }
    }
  }

  // R1 — root-cause grouping for section 2's rendering. `notWorking` itself
  // stays FLAT (one entry per failing spec) so exit-code and count semantics
  // are unchanged; `notWorkingGroups` is purely a rendering aid layered on
  // top.
  const notWorkingGroups = groupFailures(notWorking);

  // R4 — a flaky spec is never counted as a pass, and its existence is
  // itself worth failing the run over: the whole point of first-attempt
  // reporting is that the retry did not actually resolve anything, it only
  // hid it. A signoff that reads clean because every real failure happened
  // to pass on its one retry is exactly the "retry loop is a lie" case the
  // skill's own ground rules warn about.
  const exitCode = notWorking.length > 0 || flaky.length > 0 ? 1 : 0;

  return {
    working,
    notWorking,
    notWorkingGroups,
    known,
    flaky,
    needsHuman,
    skipSummary,
    capabilityGated: dedupeWithCounts(capabilityGated),
    notRunSuites,
    coverageDrift,
    scoped,
    gitInfo,
    exitCode,
  };
}

function groupBySuite(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.suite)) groups.set(e.suite, []);
    groups.get(e.suite).push(e);
  }
  return groups;
}

/** Render the five sections as markdown, in fixed order. */
export function renderMarkdown(report) {
  const lines = [];
  lines.push('# Signals DPG — end-to-end signoff');
  lines.push('');
  lines.push(
    report.scoped
      ? `> Scoped run — alias \`${report.scoped.alias}\`, suites [${(report.scoped.suites ?? []).join(', ')}]. ` +
          'Section 4 names every suite this invocation did not touch, so this can never be misread as a full signoff.'
      : '> Full run — every suite in the catalogue.',
  );
  lines.push('');

  // ── Git provenance (R5) ───────────────────────────────────────────────────
  // Which commit the SPECS came from and which commit the APP under test came
  // from are two different checkouts whenever SIGNALS_REPO points somewhere
  // other than this worktree — nothing else in this report can tell a reader
  // that happened. A diverged pair makes any UI/behavioural failure below
  // genuinely uninterpretable (stale spec vs real regression) until the two
  // checkouts match, so this is rendered right under the title, before
  // anything else, and loudly when it disagrees.
  if (report.gitInfo) {
    const g = report.gitInfo;
    lines.push(`**Specs checkout:** \`${g.specs.dir}\` @ \`${g.specs.sha}\` (\`${g.specs.branch}\`)`);
    lines.push(`**App checkout:** \`${g.app.dir}\` @ \`${g.app.sha}\` (\`${g.app.branch}\`)`);
    if (g.diverged) {
      const spread = g.computable
        ? `specs are ${g.specsAhead} commit(s) ahead and ${g.appAhead} commit(s) behind the app's HEAD ` +
          `(${g.specsAhead + g.appAhead} commits apart total)`
        : 'commit divergence could not be computed (likely unrelated histories/repositories) — the SHAs above differ regardless';
      lines.push('');
      lines.push(
        `> ⚠️ **DIVERGED CHECKOUTS** — the specs and the app under test are NOT the same commit; ${spread}. ` +
          'Any UI or behavioural failure below may reflect stale specs rather than a real product regression ' +
          '(or vice versa) — that cannot be told apart until the two checkouts match. Treat this signoff as ' +
          'provisional until SIGNALS_REPO points at the same commit the specs were written against.',
      );
    } else {
      lines.push('');
      lines.push('> Specs and app are on the same commit.');
    }
    lines.push('');
  }

  // ── At-a-glance tables ────────────────────────────────────────────────────
  // The five sections below carry the detail, but a reader opening this file
  // wants two answers first: did it pass, and which parts of the product were
  // actually exercised. Prose lists answer neither at a glance — a spec that
  // never ran looks identical to one that passed if you are skimming. These
  // two tables are the summary; everything after them is the evidence.
  const passCount = report.working.filter((w) => !w.skipped).length;
  const failCount = report.notWorking.length;
  const flakyCount = (report.flaky ?? []).length;
  const skipCount = report.working.filter((w) => w.skipped).length;
  const groupCount = (report.notWorkingGroups ?? []).length;
  // R1 — the failed-count cell names how many ROOT CAUSES the failures
  // collapse to, not just how many specs failed, so "10" never reads as "10
  // independent defects" when it was really one root cause hitting 10 specs.
  const failedCell = failCount === 0 ? '0' : `${failCount} (${groupCount} root cause${groupCount === 1 ? '' : 's'})`;
  // R4 — flaky is never folded into the PASS verdict: a spec that failed on
  // its first attempt and only passed on retry is exactly the signal a
  // signoff exists to surface, not noise a retry is allowed to erase.
  const verdict = failCount > 0 ? '❌ FAIL' : flakyCount > 0 ? '⚠️ FLAKY' : '✅ PASS';

  lines.push('## At a glance');
  lines.push('');
  lines.push('| | Count |');
  lines.push('|---|---:|');
  lines.push(`| ✅ Passed | ${passCount} |`);
  lines.push(`| ❌ Failed | ${failedCell} |`);
  lines.push(`| 🎲 Flaky (passed on retry — see below, first-attempt error shown) | ${flakyCount} |`);
  lines.push(`| ⏭️ Skipped (capability-gated) | ${skipCount} |`);
  lines.push(`| ⚑ Known / expected | ${report.known.length} |`);
  lines.push(`| 👤 What a pass here still does not prove (§4) | ${report.needsHuman.length} |`);
  lines.push(`| **Verdict** | **${verdict}** |`);
  lines.push('');

  // ── Skip provenance (field-test fix E) ────────────────────────────────────
  // MECHANICAL — the "why" behind the skip counter directly above, derived
  // from this run's own skips (never a hand-maintained second list). This
  // used to be flattened into section 4 alongside the approach's STANDING
  // limits, which summed two incommensurable things under one count and
  // buried the more valuable of the two. Rendered here instead, right next
  // to the counter it explains; section 4 below now carries only the
  // standing limits.
  if ((report.skipSummary ?? []).length > 0) {
    lines.push(`_${skipCount} skipped — ${report.skipSummary.join('; ')}._`);
    lines.push('');
  }
  if ((report.capabilityGated ?? []).length > 0) {
    lines.push(
      '_Also capability-gated, but not wired to any spec\'s skip check yet (so it cannot appear in the ' +
        `count above): ${report.capabilityGated.join('; ')}._`,
    );
    lines.push('');
  }
  if ((report.notRunSuites ?? []).length > 0) {
    lines.push('**Not run this invocation** (scoped run — so a scoped pass can never read as a full signoff):');
    for (const s of report.notRunSuites) lines.push(`- ${s}`);
    lines.push('');
  }

  // Per-suite coverage. `report.suites` is the catalogue parsed from
  // coverage.md; a suite with no specs in this run is "not run", which is a
  // materially different thing from "passed" and must not read the same.
  const bySuite = new Map();
  for (const w of report.working) {
    const k = w.suite ?? '(unknown)';
    if (!bySuite.has(k)) bySuite.set(k, { pass: 0, fail: 0, skip: 0 });
    bySuite.get(k)[w.skipped ? 'skip' : 'pass'] += 1;
  }
  for (const f of report.notWorking) {
    const k = f.suite ?? '(unknown)';
    if (!bySuite.has(k)) bySuite.set(k, { pass: 0, fail: 0, skip: 0 });
    bySuite.get(k).fail += 1;
  }
  if (bySuite.size > 0) {
    lines.push('## What ran, by spec file');
    lines.push('');
    lines.push('| Spec file | ✅ | ❌ | ⏭️ | State |');
    lines.push('|---|---:|---:|---:|---|');
    for (const [suite, c] of [...bySuite.entries()].sort()) {
      const state =
        c.fail > 0 ? '❌ failing' : c.pass > 0 ? '✅ passing' : '⏭️ skipped only';
      lines.push(`| ${suite} | ${c.pass} | ${c.fail} | ${c.skip} | ${state} |`);
    }
    lines.push('');
  }

  lines.push('## 1. Working');
  const passing = groupBySuite(report.working.filter((w) => !w.skipped));
  if (passing.size === 0) {
    lines.push('_Nothing passed._');
  } else {
    for (const [suite, items] of passing) {
      lines.push(`**${suite}**`);
      for (const item of items) lines.push(`- ${item.title}`);
    }
  }
  lines.push('');

  lines.push('## 2. Not working');
  if (report.notWorking.length === 0) {
    lines.push('_None._');
  } else {
    // R1 — one entry per ROOT CAUSE, not per spec: a group of size 1 renders
    // like the old single-failure entry (plus its attribution tag); a group
    // of size N>1 renders once, with a count and the shared normalized
    // error, and every distinct member listed underneath rather than its
    // full detail repeated N times.
    // G5 — two more conservative, evidenced verdicts alongside the original
    // suite-defect/unattributed pair (never a guessed product-defect): a
    // `capability-gap` reads as "not configured here", a `drift` reads as
    // "two hand-maintained constants disagree" — both distinct from a bug in
    // the suite ITSELF, and both distinct from "needs a human, no opinion".
    const VERDICT_TAGS = {
      'suite-defect': '🔧 suite-defect',
      'capability-gap': '🔌 capability-gap',
      drift: '🌊 drift',
      unattributed: '❓ unattributed',
    };
    for (const g of report.notWorkingGroups ?? []) {
      const tag = VERDICT_TAGS[g.verdict] ?? VERDICT_TAGS.unattributed;
      if (g.count === 1) {
        const f = g.members[0];
        lines.push(`### ${f.suite} — ${f.title}  [${tag}]`);
        lines.push(f.detail);
        lines.push(`_attribution: ${g.reason}_`);
        lines.push('');
      } else {
        lines.push(`### ${g.count} failures, one root cause — [${tag}]`);
        lines.push(`**Shared error (normalized):** \`${g.signature}\``);
        lines.push(`_attribution: ${g.reason}_`);
        lines.push('');
        lines.push('Members:');
        for (const m of g.members) {
          lines.push(`- ${m.suite} — ${m.title}${m.trace ? ` (trace: ${m.trace})` : ''}`);
        }
        lines.push('');
      }
    }
  }
  lines.push('');

  lines.push('## 2b. Flaky — passed on retry');
  lines.push(
    '_Never counted as a pass. Each entry below carries the FIRST attempt\'s error — the one that actually ' +
      "happened — not the retry's, because the retry is what hid it. See ground rule: \"One restart is a fix; " +
      'a retry loop is a lie."_',
  );
  lines.push('');
  if (!report.flaky || report.flaky.length === 0) {
    lines.push('_None this run._');
  } else {
    for (const fl of report.flaky) {
      lines.push(`### ${fl.suite} — ${fl.title}`);
      lines.push(fl.detail);
      lines.push('');
    }
  }
  lines.push('');

  lines.push('## 3. Known / expected');
  if (report.known.length === 0) {
    lines.push('_None flagged this run._');
  } else {
    for (const k of report.known) lines.push(`- **${k.suite} — ${k.title}**: ${k.detail}`);
  }
  lines.push('');

  lines.push('## 4. What a pass here still does not prove');
  lines.push(
    '_Standing limits of this black-box approach — true no matter how this target is configured. ' +
      "Mechanical skip provenance (which capability gates were closed, which suites this run didn't " +
      'touch) lives under the at-a-glance table above, not here — this list is only the answer to ' +
      '"what would a green run STILL not tell me"._',
  );
  lines.push('');
  if (report.needsHuman.length === 0) {
    lines.push('_Nothing — unusual; check that coverage.md loaded correctly._');
  } else {
    for (const h of report.needsHuman) lines.push(`- ${h}`);
  }
  lines.push('');

  lines.push('## 5. Coverage drift');
  if (report.coverageDrift.length === 0) {
    lines.push('_Nothing unmapped._');
  } else {
    for (const d of report.coverageDrift) lines.push(`- ${d}`);
  }
  lines.push('');

  lines.push(`Exit code: ${report.exitCode}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI: `node report.mjs --results <path> [--coverage <coverage.md path>]
//        [--residue <n>] [--cleanup-code <n>] [--scoped-alias <a> --scoped-suites 1,2,3]
//        [--coverage-drift <path to a JSON array of strings>]
//        [--git-info <path to a JSON GitInfo object, see report.d.mts>]`
// Prints the markdown report to stdout and exits with the report's code —
// the shape `run.sh` (Task 10) needs to fail the whole invocation on section 2.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    out[key] = next;
    i += 1;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const resultsPath = args.results ?? 'test-results/results.json';
  const coveragePath = args.coverage ?? new URL('../coverage.md', import.meta.url).pathname;
  const residue = Number(args.residue ?? 0);
  const cleanupCode = Number(args['cleanup-code'] ?? 0);

  const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
  const coverageText = readFileSync(coveragePath, 'utf8');
  const humanOnly = parseHumanOnly(coverageText);
  const capabilityGated = parseCapabilityGated(coverageText);
  const suites = parseSuiteTable(coverageText);
  // `scoped-suites` may be an empty string — a cross-cutting alias (e.g. the
  // mail sweep) that doesn't correspond to a single numbered suite still has a
  // name to report under, it just runs against zero catalogue ids. Filtering
  // blanks before mapping to Number means that case is `[]`, not `[0]` (an
  // empty string split on ',' is `['']`, and `Number('')` is `0`).
  const scoped =
    args['scoped-alias'] !== undefined
      ? {
          alias: args['scoped-alias'],
          suites: (args['scoped-suites'] ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .map(Number),
        }
      : null;
  const coverageDrift = args['coverage-drift'] ? JSON.parse(readFileSync(args['coverage-drift'], 'utf8')) : [];
  const gitInfo = args['git-info'] ? JSON.parse(readFileSync(args['git-info'], 'utf8')) : null;

  const report = buildReport({ results, humanOnly, capabilityGated, scoped, residue, cleanupCode, coverageDrift, suites, gitInfo });
  console.log(renderMarkdown(report));
  process.exit(report.exitCode);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
