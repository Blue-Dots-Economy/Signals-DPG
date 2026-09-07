import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildReport,
  parseHumanOnly,
  parseCapabilityGated,
  parseSuiteTable,
  renderMarkdown,
  SUITES,
  normalizeErrorSignature,
  classifySuiteVsProduct,
  groupFailures,
  dedupeWithCounts,
} from '../../../.claude/skills/signals-e2e/lib/report.mjs';

const results = {
  suites: [{
    title: 'journey-a', specs: [
      { title: 'creates a profile', ok: true, tests: [{ results: [{ status: 'passed' }] }] },
      { title: 'rejects a bad payload', ok: false, tests: [{ results: [{ status: 'failed', error: { message: 'expected 409 got 503' } }] }] },
      { title: 'decrypts a participant', ok: true, tests: [{ results: [{ status: 'skipped' }], annotations: [{ type: 'skip', description: '[capability] requires service-caller credentials' }] }] },
    ],
  }],
};

test('passes, failures and skips land in their own sections', () => {
  const r = buildReport({ results, humanOnly: ['brand skin correctness'], scoped: null, residue: 0 });
  assert.equal(r.working.length, 2);
  assert.equal(r.notWorking.length, 1);
  assert.match(r.notWorking[0].detail, /expected 409 got 503/);
  // Field-test fix E — mechanical skip provenance lives in `skipSummary`,
  // NOT in `needsHuman` any more (that field is section 4's body, the
  // standing limits, only).
  assert.ok(r.skipSummary.some((h) => /service-caller credentials/.test(h)));
  assert.ok(!r.needsHuman.some((h) => /service-caller credentials/.test(h)));
  assert.ok(r.needsHuman.includes('brand skin correctness'));
});

test('a scoped run names every suite it did not run — in notRunSuites, not needsHuman', () => {
  const r = buildReport({ results, humanOnly: [], scoped: { alias: 'u18', suites: [5] }, residue: 0 });
  assert.ok(r.notRunSuites.some((h) => /not run in this invocation/.test(h)));
  assert.ok(!r.needsHuman.some((h) => /not run in this invocation/.test(h)));
});

test('cleanup residue is a failure, not a footnote', () => {
  const r = buildReport({ results, humanOnly: [], scoped: null, residue: 3 });
  assert.ok(r.notWorking.some((f) => /residue/i.test(f.detail)));
});

test('exit code is non-zero only when section 2 is non-empty', () => {
  const clean = { suites: [{ title: 's', specs: [{ title: 't', ok: true, tests: [{ results: [{ status: 'passed' }] }] }] }] };
  assert.equal(buildReport({ results: clean, humanOnly: [], scoped: null, residue: 0 }).exitCode, 0);
  assert.equal(buildReport({ results, humanOnly: [], scoped: null, residue: 0 }).exitCode, 1);
});

test('parseSuiteTable reads coverage.md into the same shape as SUITES', () => {
  const text = readFileSync(
    new URL('../../../.claude/skills/signals-e2e/coverage.md', import.meta.url),
    'utf8',
  );
  assert.deepEqual(parseSuiteTable(text), SUITES);
});

test('a scoped run can be told to use a caller-supplied suite catalogue', () => {
  const r = buildReport({
    results,
    humanOnly: [],
    scoped: { alias: 'x', suites: [1] },
    residue: 0,
    suites: [{ id: 1, name: 'Only one' }, { id: 2, name: 'Another' }],
  });
  assert.ok(r.notRunSuites.includes('Suite 2 (Another) — not run in this invocation'));
  assert.ok(!r.notRunSuites.some((h) => h.includes('Suite 1')));
});

test('parseSuiteTable rejects a markdown file with no suite table', () => {
  assert.throws(() => parseSuiteTable('# nothing here\n'), /parsed to zero rows/);
});

test('the signoff opens with an at-a-glance table and a per-spec-file table', () => {
  const results = {
    stats: { expected: 2, skipped: 1, unexpected: 1, flaky: 0 },
    suites: [{
      title: 'journey-x.spec.ts',
      specs: [
        { title: 'a passes', ok: true, tests: [{ results: [{ status: 'passed' }] }] },
        { title: 'b passes', ok: true, tests: [{ results: [{ status: 'passed' }] }] },
        { title: 'c fails', ok: false, tests: [{ results: [{ status: 'failed', error: { message: 'boom' } }] }] },
        {
          title: 'd skips', ok: true,
          tests: [{
            annotations: [{ type: 'skip', description: '[capability] requires direct DB access' }],
            results: [{ status: 'skipped' }],
          }],
        },
      ],
    }],
  };
  const md = renderMarkdown(buildReport({ results, humanOnly: ['judge the palette'], scoped: null, residue: 0 }));

  // Counts must reflect reality, not just render.
  assert.match(md, /\| ✅ Passed \| 2 \|/);
  assert.match(md, /\| ❌ Failed \| 1 \(1 root cause\) \|/);
  assert.match(md, /\| ⏭️ Skipped \(capability-gated\) \| 1 \|/);
  assert.match(md, /\*\*Verdict\*\* \| \*\*❌ FAIL\*\*/);

  // A failing spec file must read as failing, not as passing-with-a-note.
  assert.match(md, /\| journey-x\.spec\.ts \| 2 \| 1 \| 1 \| ❌ failing \|/);

  // The tables precede the detail sections, so a skimmer sees the verdict first.
  assert.ok(md.indexOf('## At a glance') < md.indexOf('## 1. Working'));
});

test('a clean run reads as PASS in the glance table', () => {
  const results = {
    stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 },
    suites: [{ title: 's.spec.ts', specs: [{ title: 'ok', ok: true, tests: [{ results: [{ status: 'passed' }] }] }] }],
  };
  const md = renderMarkdown(buildReport({ results, humanOnly: [], scoped: null, residue: 0 }));
  assert.match(md, /\*\*Verdict\*\* \| \*\*✅ PASS\*\*/);
  assert.match(md, /\| s\.spec\.ts \| 1 \| 0 \| 0 \| ✅ passing \|/);
});

// ---------------------------------------------------------------------------
// R1 — root-cause grouping. Ten independent-looking failures sharing ONE
// cause (three parallel workers minting the SAME phone number) must collapse
// into one group with a count, not read as ten separate product defects.
// ---------------------------------------------------------------------------

test('normalizeErrorSignature masks run-specific identifiers so the same cause collapses', () => {
  const a = normalizeErrorSignature('insert failed: 23505 phone_number "+919123450001" already exists');
  const b = normalizeErrorSignature('insert failed: 23505 phone_number "+919123450002" already exists');
  assert.equal(a, b);

  const c = normalizeErrorSignature('expected 409 got 503');
  assert.notEqual(a, c);
});

test('classifySuiteVsProduct only tags suite-defect on real evidence, never guesses product-defect', () => {
  const dup = classifySuiteVsProduct(['23505 phone_number "+919123450001" already exists']);
  assert.equal(dup.verdict, 'suite-defect');

  const noTests = classifySuiteVsProduct(['Error: No tests found']);
  assert.equal(noTests.verdict, 'suite-defect');

  const locatorTimeout = classifySuiteVsProduct(['Timeout 15000ms exceeded waiting for locator(\'button\')']);
  assert.equal(locatorTimeout.verdict, 'suite-defect');

  // A missing browser binary. The text names its own remedy, so it clears this
  // function's evidence bar — and without the rule a first run on a host with no
  // browsers reports every UI spec (22 of them, measured) as `unattributed`,
  // handing a human 22 setup errors to triage as possible product defects.
  const noBrowser = classifySuiteVsProduct([
    "browserType.launch: Executable doesn't exist at /x/chromium_headless_shell-1228/chrome-headless-shell" +
      ' — Please run the following command to download new browsers: npx playwright install',
  ]);
  assert.equal(noBrowser.verdict, 'suite-defect');
  assert.match(noBrowser.reason, /playwright install/);

  // Support is env-gated the same way match-score is: the UI hides the whole
  // menu entry when /support/config reports `enabled: false`, so a CORRECT
  // locator times out. Must be capability-gap, not suite-defect — a real run
  // mislabelled it as the test's own selector being wrong.
  const supportOff = classifySuiteVsProduct([
    "locator.click: Timeout 15000ms exceeded. Call log: - waiting for getByRole('button', { name: 'Contact support' })",
  ]);
  assert.equal(supportOff.verdict, 'capability-gap');

  // ...and the narrower rule must not swallow every other locator timeout.
  const otherLocator = classifySuiteVsProduct([
    "locator.click: Timeout 15000ms exceeded. Call log: - waiting for getByRole('button', { name: 'Resume profile' })",
  ]);
  assert.equal(otherLocator.verdict, 'suite-defect');

  // A plain assertion on a product invariant — no suite-noise shape at all.
  // This function must NEVER return "product-defect": a wrong "suite bug"
  // label is worse than none, so the honest answer here is "unattributed".
  const plain = classifySuiteVsProduct(["expect(item.lifecycle_status).toBe('live') — received 'draft'"]);
  assert.equal(plain.verdict, 'unattributed');
});

// G5 rule 1 — real fixture text, mirroring the (fixed) live network-themes.ts
// / index.css `--brand-cta` drift word-for-word (Playwright's actual `toBe`
// failure shape, captured live against a throwaway spec before writing this).
test('classifySuiteVsProduct tags a CSS/design-token constant mismatch as drift, not suite-defect', () => {
  const themeDrift = classifySuiteVsProduct([
    'Error: --brand-cta for blue_dot\n\n' +
      'expect(received).toBe(expected) // Object.is equality\n\n' +
      'Expected: "oklch(0.55 0.20 250)"\n' +
      'Received: "oklch(0.55 0.22 285)"',
  ]);
  assert.equal(themeDrift.verdict, 'drift');
  assert.match(themeDrift.reason, /CSS\/design-token/);

  // Both sides must look like CSS values — an ordinary string mismatch must
  // NOT be swept into "drift" just because it happens to use Expected/Received.
  const ordinaryStringMismatch = classifySuiteVsProduct([
    'Expected: "live"\nReceived: "draft"',
  ]);
  assert.equal(ordinaryStringMismatch.verdict, 'unattributed');
});

// G5 rule 2 — real fixture text, captured live from
// journey-match-score.ui.spec.ts's `waitForResponse` timeout against a target
// with no MATCH_SCORE_PROVIDER configured (before this spec was gated on the
// `matchScore` capability).
test('classifySuiteVsProduct tags a waitForResponse timeout on a known optional endpoint as capability-gap', () => {
  const matchScoreTimeout = classifySuiteVsProduct([
    'TimeoutError: page.waitForResponse: Timeout 15000ms exceeded while waiting for event "response"\n\n' +
      "  40 |       page.waitForResponse((r) => r.url().includes('/api/v1/match-score/calculate')),\n" +
      "      |            ^\n" +
      "  41 |       page.getByRole('button', { name: /See Match Score/i }).first().click(),",
  ]);
  assert.equal(matchScoreTimeout.verdict, 'capability-gap');
  assert.match(matchScoreTimeout.reason, /match-score\/calculate/);

  // A waitForResponse timeout on a DIFFERENT (not known-optional) endpoint
  // must NOT be swept into "capability-gap" — stay on the existing, more
  // conservative selector/locator-timeout suite-defect tag instead.
  const otherTimeout = classifySuiteVsProduct([
    'TimeoutError: page.waitForResponse: Timeout 15000ms exceeded while waiting for event "response"\n\n' +
      "page.waitForResponse((r) => r.url().includes('/api/v1/item/create')),",
  ]);
  assert.notEqual(otherTimeout.verdict, 'capability-gap');
});

test('groupFailures collapses failures sharing a normalized signature and counts them', () => {
  const notWorking = [
    { suite: 'journey-d', title: 'action event A', detail: 'd1', trace: null, rawError: '23505 phone_number "+919000001" already exists' },
    { suite: 'journey-e', title: 'bulk B', detail: 'd2', trace: null, rawError: '23505 phone_number "+919000002" already exists' },
    { suite: 'journey-r', title: 'limits C', detail: 'd3', trace: null, rawError: '23505 phone_number "+919000003" already exists' },
    { suite: 'journey-x', title: 'unrelated D', detail: 'd4', trace: null, rawError: 'expected 201 got 500' },
  ];
  const groups = groupFailures(notWorking);
  assert.equal(groups.length, 2);
  const collision = groups.find((g) => g.count === 3);
  assert.ok(collision);
  assert.equal(collision!.verdict, 'suite-defect');
  assert.deepEqual(collision!.members.map((m) => m.title), ['action event A', 'bulk B', 'limits C']);
  const other = groups.find((g) => g.count === 1);
  assert.ok(other);
  assert.equal(other!.verdict, 'unattributed');
});

test('a report with one root cause behind N failures groups them in the rendered signoff and the glance table', () => {
  const grouped = {
    stats: { expected: 0, skipped: 0, unexpected: 10, flaky: 0 },
    suites: [
      { title: 'journey-d.spec.ts', file: 'api/journey-d.spec.ts', specs: [
        { title: 'action event', file: 'api/journey-d.spec.ts', ok: false, tests: [{ status: 'unexpected', results: [{ status: 'failed', error: { message: '23505 phone_number "+919000001" already exists' } }] }] },
      ] },
      { title: 'journey-e.spec.ts', file: 'api/journey-e.spec.ts', specs: [
        { title: 'bulk accept', file: 'api/journey-e.spec.ts', ok: false, tests: [{ status: 'unexpected', results: [{ status: 'failed', error: { message: '23505 phone_number "+919000002" already exists' } }] }] },
      ] },
      { title: 'journey-r.spec.ts', file: 'api/journey-r.spec.ts', specs: [
        { title: 'action limits', file: 'api/journey-r.spec.ts', ok: false, tests: [{ status: 'unexpected', results: [{ status: 'failed', error: { message: '23505 phone_number "+919000003" already exists' } }] }] },
      ] },
    ],
  };
  const report = buildReport({ results: grouped, humanOnly: [], scoped: null, residue: 0 });
  assert.equal(report.notWorking.length, 3, 'flat count is still every failing spec');
  assert.equal(report.notWorkingGroups.length, 1, 'all three collapse into one root cause');
  assert.equal(report.notWorkingGroups[0].verdict, 'suite-defect');

  const md = renderMarkdown(report);
  assert.match(md, /\| ❌ Failed \| 3 \(1 root cause\) \|/);
  assert.match(md, /3 failures, one root cause/);
  // The grouped block lists every distinct member, not three copies of the same detail.
  assert.match(md, /action event/);
  assert.match(md, /bulk accept/);
  assert.match(md, /action limits/);
});

// ---------------------------------------------------------------------------
// R2 — section 4 dedupe with counts, first-seen order preserved.
// ---------------------------------------------------------------------------

test('dedupeWithCounts collapses repeats with (×N), leaves unique entries alone, preserves order', () => {
  const out = dedupeWithCounts(['a', 'b', 'a', 'a', 'c', 'b']);
  assert.deepEqual(out, ['a (×3)', 'b (×2)', 'c']);
});

test('section 4 dedupes 20 identical skip reasons down to one line with a count', () => {
  const specs = [];
  for (let i = 0; i < 20; i += 1) {
    specs.push({
      title: `service-gated case ${i}`,
      file: 'api/journey-i.spec.ts',
      ok: true,
      tests: [{
        annotations: [{ type: 'skip', description: '[capability] requires service-caller credentials (config.auth.serviceApiKey + actingOrgId)' }],
        results: [{ status: 'skipped' }],
      }],
    });
  }
  for (let i = 0; i < 3; i += 1) {
    specs.push({
      title: `not-gated case ${i}`,
      file: 'api/journey-j.spec.ts',
      ok: true,
      tests: [{
        annotations: [{ type: 'skip', description: '[capability] target is not gated (see Journey A)' }],
        results: [{ status: 'skipped' }],
      }],
    });
  }
  const results20 = { suites: [{ title: 'journey-i', specs }] };
  const report = buildReport({ results: results20, humanOnly: [], scoped: null, residue: 0 });
  // Field-test fix E — this is `skipSummary` now, not `needsHuman` (section 4's
  // body carries only the approach's standing limits, never mechanical
  // skip provenance).
  const serviceLine = report.skipSummary.find((h) => h.includes('service-caller credentials'));
  assert.ok(serviceLine, 'the reason must still be present');
  assert.match(serviceLine!, /\(×20\)$/);
  const gatedLine = report.skipSummary.find((h) => h.includes('is not gated'));
  assert.ok(gatedLine);
  assert.match(gatedLine!, /\(×3\)$/);
  // Exactly one line per distinct reason, not 23.
  assert.equal(report.skipSummary.filter((h) => h.includes('service-caller credentials')).length, 1);
  // None of this mechanical provenance leaks into section 4's body.
  assert.equal(report.needsHuman.length, 0);
});

// ---------------------------------------------------------------------------
// R3 — preflight runs in both tiers; merged results must not double-count it.
// ---------------------------------------------------------------------------

test('a spec that appears twice (same file, same title — preflight run in both tiers) is deduped to one', () => {
  const duplicatedPreflight = {
    suites: [
      { title: 'preflight', file: 'preflight/target-ready.spec.ts', specs: [
        { title: 'target answers', file: 'preflight/target-ready.spec.ts', ok: true, tests: [{ status: 'expected', results: [{ status: 'passed' }] }] },
      ] },
      // The SAME file/title again — this is what merging results-api.json and
      // results-ui.json produces, since both depend on the preflight project.
      { title: 'preflight', file: 'preflight/target-ready.spec.ts', specs: [
        { title: 'target answers', file: 'preflight/target-ready.spec.ts', ok: true, tests: [{ status: 'expected', results: [{ status: 'passed' }] }] },
      ] },
    ],
  };
  const report = buildReport({ results: duplicatedPreflight, humanOnly: [], scoped: null, residue: 0 });
  assert.equal(report.working.length, 1, 'the duplicate must not double-count');

  const md = renderMarkdown(report);
  const occurrences = md.split('target answers').length - 1;
  assert.equal(occurrences, 1, 'section 1 must list it once, not twice');
});

// ---------------------------------------------------------------------------
// R4 — flaky is its own category, never a pass, carries the FIRST attempt's
// error (not the retry's).
// ---------------------------------------------------------------------------

test('a spec that failed once then passed on retry is flaky, not working — and keeps the first error', () => {
  const flakyResults = {
    suites: [{
      title: 'journey-a', file: 'api/journey-a.spec.ts', specs: [
        {
          title: 'new adult signs up', file: 'api/journey-a.spec.ts', ok: true,
          tests: [{
            status: 'flaky',
            results: [
              { status: 'failed', errors: [{ message: 'signup verify failed: 500' }] },
              { status: 'passed' },
            ],
          }],
        },
      ],
    }],
  };
  const report = buildReport({ results: flakyResults, humanOnly: [], scoped: null, residue: 0 });

  assert.equal(report.flaky.length, 1);
  assert.equal(report.notWorking.length, 0, 'flaky is not a hard failure');
  assert.equal(report.working.length, 0, 'flaky must never be counted as a pass');
  assert.match(report.flaky[0].detail, /signup verify failed: 500/);

  const md = renderMarkdown(report);
  // Not silently folded into section 1.
  const section1 = md.slice(md.indexOf('## 1. Working'), md.indexOf('## 2. Not working'));
  assert.ok(!section1.includes('new adult signs up'), 'a flaky spec must not appear in section 1');
  assert.match(md, /## 2b\. Flaky/);
  assert.match(md, /signup verify failed: 500/);
  assert.match(md, /\| 🎲 Flaky.*\| 1 \|/);
  assert.match(md, /\*\*Verdict\*\* \| \*\*⚠️ FLAKY\*\*/);
});

test('flaky alone (no hard failures) still fails the exit code — a retry loop is not a pass', () => {
  const flakyResults = {
    suites: [{
      title: 'journey-a', file: 'api/journey-a.spec.ts', specs: [
        {
          title: 'flakes then passes', file: 'api/journey-a.spec.ts', ok: true,
          tests: [{ status: 'flaky', results: [{ status: 'failed', errors: [{ message: 'boom' }] }, { status: 'passed' }] }],
        },
      ],
    }],
  };
  const report = buildReport({ results: flakyResults, humanOnly: [], scoped: null, residue: 0 });
  assert.equal(report.exitCode, 1);
});

// ---------------------------------------------------------------------------
// R5 — git provenance header, warns loudly on divergence.
// ---------------------------------------------------------------------------

test('diverged specs/app checkouts render a prominent warning with both SHAs', () => {
  const gitInfo = {
    specs: { dir: '/work/Signals-DPG.worktrees/signals-e2e', sha: 'abc123abc123', branch: 'feat/signals-e2e-skill' },
    app: { dir: '/work/Signals-DPG', sha: 'def456def456', branch: 'fix/637-legal-page-layout' },
    diverged: true,
    computable: true,
    specsAhead: 12,
    appAhead: 45,
  };
  const clean = { suites: [{ title: 's', specs: [{ title: 't', file: 's.spec.ts', ok: true, tests: [{ status: 'expected', results: [{ status: 'passed' }] }] }] }] };
  const md = renderMarkdown(buildReport({ results: clean, humanOnly: [], scoped: null, residue: 0, gitInfo }));

  assert.match(md, /DIVERGED CHECKOUTS/);
  assert.match(md, /abc123abc123/);
  assert.match(md, /def456def456/);
  assert.match(md, /feat\/signals-e2e-skill/);
  assert.match(md, /fix\/637-legal-page-layout/);
  assert.match(md, /12 commit\(s\) ahead/);
  assert.match(md, /45 commit\(s\) behind/);
});

test('matching specs/app checkouts render no divergence warning', () => {
  const gitInfo = {
    specs: { dir: '/work/e2e', sha: 'aaa111aaa111', branch: 'feat/signals-e2e-skill' },
    app: { dir: '/work/e2e', sha: 'aaa111aaa111', branch: 'feat/signals-e2e-skill' },
    diverged: false,
    computable: true,
    specsAhead: 0,
    appAhead: 0,
  };
  const clean = { suites: [{ title: 's', specs: [{ title: 't', file: 's.spec.ts', ok: true, tests: [{ status: 'expected', results: [{ status: 'passed' }] }] }] }] };
  const md = renderMarkdown(buildReport({ results: clean, humanOnly: [], scoped: null, residue: 0, gitInfo }));
  assert.ok(!md.includes('DIVERGED CHECKOUTS'));
});

// ---------------------------------------------------------------------------
// Field-test fix E — section 4 stopped summing two incommensurable things
// (mechanical skip provenance vs. the approach's standing limits). Mechanical
// provenance now renders under the at-a-glance counter; section 4 (renamed)
// carries only the standing limits; a scoped run's untouched suites are
// mechanical too and render alongside the counter, not in section 4.
// ---------------------------------------------------------------------------

test('skip provenance renders under the at-a-glance counter, and section 4 carries only the standing limits', () => {
  const skippy = {
    suites: [{
      title: 'journey-i', specs: [
        {
          title: 'integrator case', ok: true,
          tests: [{ results: [{ status: 'skipped' }], annotations: [{ type: 'skip', description: '[capability] requires service-caller credentials (config.auth.serviceApiKey + actingOrgId)' }] }],
        },
      ],
    }],
  };
  const md = renderMarkdown(
    buildReport({
      results: skippy,
      humanOnly: ['brand skin correctness (logo, palette) — a screenshot is captured, not judged'],
      capabilityGated: ['geocoding accuracy without GOOGLE_GEOCODING_API_KEY or PHOTON_URL'],
      scoped: null,
      residue: 0,
    }),
  );

  const glance = md.slice(md.indexOf('## At a glance'), md.indexOf('## What ran, by spec file'));
  const section4 = md.slice(md.indexOf('## 4. What a pass here still does not prove'), md.indexOf('## 5. Coverage drift'));

  // Renamed heading — the old "Needs a human" name kept attracting mechanical
  // provenance, which is exactly the bug this fix closes.
  assert.match(md, /## 4\. What a pass here still does not prove/);
  assert.ok(!md.includes('## 4. Not tested'));

  // Mechanical skip provenance (from a real skip THIS run had) is under the
  // counter, not in section 4.
  assert.match(glance, /service-caller credentials/);
  assert.ok(!section4.includes('service-caller credentials'));

  // The capability-gated line (no live skip check exists for it) renders
  // next to the counter too, not in section 4.
  assert.match(glance, /geocoding accuracy/);
  assert.ok(!section4.includes('geocoding accuracy'));

  // Section 4's body is ONLY the standing limit that was passed in.
  assert.match(section4, /brand skin correctness/);
});

test('a scoped run still names its untouched suites, under the counter and not in section 4', () => {
  const clean = { suites: [{ title: 's', specs: [{ title: 't', file: 's.spec.ts', ok: true, tests: [{ status: 'expected', results: [{ status: 'passed' }] }] }] }] };
  const md = renderMarkdown(
    buildReport({
      results: clean,
      humanOnly: ['brand skin correctness'],
      scoped: { alias: 'u18', suites: [5] },
      residue: 0,
    }),
  );
  const glance = md.slice(md.indexOf('## At a glance'), md.indexOf('## What ran, by spec file'));
  const section4 = md.slice(md.indexOf('## 4. What a pass here still does not prove'), md.indexOf('## 5. Coverage drift'));
  assert.match(glance, /not run in this invocation/);
  assert.ok(!section4.includes('not run in this invocation'));
});

test('parseHumanOnly fails loudly on a missing section, a malformed line, and an empty block', () => {
  assert.throws(() => parseHumanOnly('# nothing here\n'), /missing its .## human-only. section/);
  assert.throws(
    () => parseHumanOnly('## human-only\n\nnot a bullet\n'),
    /unrecognised line/,
  );
  assert.throws(() => parseHumanOnly('## human-only\n\n- \n'), /unrecognised line/);
  assert.throws(() => parseHumanOnly('## human-only\n'), /parsed to zero entries/);
});

test('parseHumanOnly tolerates blank lines and HTML comments, single- and multi-line', () => {
  const md =
    '## human-only\n\n<!-- a note -->\n- one thing\n\n<!--\n  multi\n  line\n-->\n- another thing\n';
  assert.deepEqual(parseHumanOnly(md), ['one thing', 'another thing']);
});

test('parseCapabilityGated parses its own section and fails loudly the same way as parseHumanOnly', () => {
  const md = '## capability-gated\n\n- geocoding accuracy without a key\n';
  assert.deepEqual(parseCapabilityGated(md), ['geocoding accuracy without a key']);
  assert.throws(() => parseCapabilityGated('# nothing here\n'), /missing its .## capability-gated. section/);
});

test("coverage.md's own capability-gated block still names the geocoding line, and human-only no longer does", () => {
  const text = readFileSync(
    new URL('../../../.claude/skills/signals-e2e/coverage.md', import.meta.url),
    'utf8',
  );
  const humanOnly = parseHumanOnly(text);
  const capabilityGated = parseCapabilityGated(text);
  assert.ok(!humanOnly.some((h) => /geocoding/i.test(h)), 'geocoding moved out of human-only');
  assert.ok(capabilityGated.some((h) => /geocoding/i.test(h)), 'geocoding lives in capability-gated instead');
});

// ---------------------------------------------------------------------------
// Coordinator follow-up — confirm the "drift" verdict fires on a failure
// shaped exactly like two hand-maintained/imported constants disagreeing,
// via a SYNTHETIC error, not by deliberately breaking a real spec. The
// existing G5-rule-1 test above ("tags a CSS/design-token constant mismatch
// as drift") already exercises this with fixture text mirroring the real
// network-themes.ts / index.css failure shape; this test additionally
// frames the synthetic failure explicitly as "comparing two imported
// constants" (the shape journey-theming.ui.spec.ts's own assertion has —
// `expectedTokens[name]` imported from network-themes.ts vs. the resolved
// CSS custom property) so the rule's applicability to that exact spec shape
// is asserted directly, not just inferred.
// ---------------------------------------------------------------------------

test('classifySuiteVsProduct tags a synthetic "two imported constants disagree" failure as drift', () => {
  const importedConstantsDisagree = classifySuiteVsProduct([
    'Error: --brand-cta for blue_dot\n\n' +
      "expect(resolved['--brand-cta'], '--brand-cta for blue_dot').toBe(expectedTokens['--brand-cta'])\n\n" +
      'Expected: "oklch(0.55 0.22 285)"\n' +
      'Received: "oklch(0.55 0.20 250)"',
  ]);
  assert.equal(importedConstantsDisagree.verdict, 'drift');
  assert.match(importedConstantsDisagree.reason, /hand-maintained constants/);
});
