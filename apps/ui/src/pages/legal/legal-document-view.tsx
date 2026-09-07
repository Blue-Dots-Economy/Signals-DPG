/**
 * Read-only public legal page: both documents (Privacy Policy and Terms of
 * Service), in order, in one continuous scroll — with a contents rail beside
 * the reading column. No checkbox, no scroll gating, no consent capture —
 * that is the separate, landed `ConsentGateBody` surface.
 *
 * One route, `/legal`, holds both documents. `/privacy` and `/terms` used to
 * be two routes rendering this same component and differing only in where they
 * landed the reader; they are now redirects to `/legal#privacy` and
 * `/legal#terms`, so an already-shared link still arrives at the right section
 * (see `app.tsx`). Where the reader lands is therefore decided by the URL
 * fragment alone — nothing about this page varies by route any more.
 *
 * Nothing in the rail navigates to another route: every entry is a same-page
 * anchor, because both documents live on the page.
 *
 * Signals has one audience (plus the `u18` variant, which this read-only
 * page does not surface), so unlike the sibling aggregator repo the rail
 * lists just the two documents and their sections — no audience grouping.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { LanguageSwitcher } from '@/components/layout/language-switcher';
import { ThemeModeToggle } from '@/components/layout/theme-mode-toggle';
import { PortalHeader } from '@/components/layout/portal-header';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useConsentConfig } from '@/hooks/use-consent-config';
import { Markdown } from '@/components/consent/markdown';
import { cn } from '@/lib/utils';
import { extractSections, type LegalSection } from '@/pages/legal/legal-sections';

export type LegalDoc = 'privacy' | 'terms';

const DOC_ORDER: LegalDoc[] = ['privacy', 'terms'];

interface ContentVersion {
  version: number;
  title: string;
  content: string;
  effective_from: string;
}

/** One rendered section: its rail metadata plus the markdown body that follows it. */
interface RenderableSection extends LegalSection {
  body: string;
}

/** One document, fully resolved for rendering: its version, preamble, and sections. */
interface RenderableDoc {
  doc: LegalDoc;
  version: ContentVersion;
  preamble: string;
  sections: RenderableSection[];
}

/**
 * Structural id for a document's own heading — the document key itself
 * (`privacy` / `terms`), never anything derived from document content. It is
 * deliberately the bare key: these are the ids `/legal#privacy` and
 * `/legal#terms` address, so they are real fragments a browser can resolve on
 * its own rather than something this component has to translate.
 *
 * `dedupeSectionIdsAcrossDocs` reserves both names so a section heading that
 * happens to slugify to "privacy" cannot take one out from under a link that
 * has already been shared.
 */
function docHeadingId(doc: LegalDoc): string {
  return doc;
}

/**
 * Normalizes heading text for a title comparison — case- and
 * whitespace-insensitive, so "Privacy Policy", "privacy policy", and
 * "Privacy   Policy" all match the same title.
 */
function normalizeHeadingText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * True when `heading` is the document's own title, repeated as a heading.
 *
 * Every real consent document's Markdown opens with a level-2 heading that
 * repeats the document's `title` field verbatim (`## Privacy Policy`,
 * `## Terms of Service`, …) — verified across all six network schemas.
 * Rendering that heading as an ordinary section would duplicate the page's
 * own document heading and give the rail a first entry that just repeats its
 * own group header. This checks the title specifically, not "is it the first
 * heading" — a document that legitimately opens with `## Overview` keeps
 * that section.
 */
function isDocumentTitleHeading(heading: string, title: string): boolean {
  return normalizeHeadingText(heading) === normalizeHeadingText(title);
}

/**
 * Splits a document's markdown into its heading-delimited sections, pairing
 * each with the id `extractSections` would assign it. Rendering the headings
 * ourselves (rather than leaving them to `Markdown`/`ReactMarkdown`) is what
 * lets each one carry an `id` an anchor can land on.
 *
 * The document's own leading title heading (see `isDocumentTitleHeading`) is
 * dropped from the section list; any prose directly under it is folded into
 * the preamble so it isn't lost.
 *
 * Note: markdown with no `##`/`###` headings at all (or only its own title
 * heading) yields an empty `sections` list and the whole body as `preamble`
 * — never a crash. Headings nested deeper than `###` are not treated as
 * section boundaries either; they stay put as ordinary content inside
 * whichever section (or the preamble) they fall under, and `Markdown` still
 * renders them.
 *
 * @param markdown - The document body.
 * @param title - The document's title, so its own repeated heading can be
 *   told apart from a real first section.
 * @returns Any content before the first real section, plus the sections in order.
 */
function splitIntoSections(
  markdown: string,
  title: string,
): { preamble: string; sections: RenderableSection[] } {
  const ids = extractSections(markdown);
  const lines = markdown.split('\n');
  let inFence = false;
  const preambleLines: string[] = [];
  const bodies: string[][] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      (current ?? preambleLines).push(line);
      continue;
    }
    if (!inFence && /^#{2,3}\s/.test(line.trim())) {
      current = [];
      bodies.push(current);
      continue;
    }
    (current ?? preambleLines).push(line);
  }

  let sections: RenderableSection[] = ids.map((section, i) => ({
    ...section,
    body: (bodies[i] ?? []).join('\n').trim(),
  }));
  let preamble = preambleLines.join('\n').trim();

  const [leading] = sections;
  if (leading && isDocumentTitleHeading(leading.heading, title)) {
    preamble = [preamble, leading.body].filter(Boolean).join('\n\n');
    sections = sections.slice(1);
  }

  return { preamble, sections };
}

/**
 * Guarantees every section id on the page is unique once both documents are
 * rendered together, and that neither can take a document's own id.
 *
 * `extractSections` only dedupes *within* a single document's markdown, so
 * two documents that happen to share a heading (e.g. both open a "Grievances"
 * subsection) would otherwise produce two elements with the same `id` —
 * invalid HTML, and an anchor that could land on the wrong document's
 * heading. This never fires for the common case (no shared headings, which
 * is true of every real consent document today) — ids are only rewritten on
 * an actual collision, and only for the later document in `DOC_ORDER`, so
 * existing deep links are unaffected unless a genuine collision exists.
 *
 * The `seen` set starts seeded with the document ids themselves, so a section
 * called "Privacy" becomes `privacy-2` rather than stealing the `#privacy`
 * fragment that `/privacy` redirects to.
 *
 * @param docs - Documents in rendering order.
 * @returns The same documents, with any colliding section ids renumbered.
 */
function dedupeSectionIdsAcrossDocs(
  docs: { preamble: string; sections: RenderableSection[] }[],
): { preamble: string; sections: RenderableSection[] }[] {
  const seen = new Set<string>(DOC_ORDER.map(docHeadingId));
  return docs.map((doc) => ({
    ...doc,
    sections: doc.sections.map((section) => {
      if (!seen.has(section.id)) {
        seen.add(section.id);
        return section;
      }
      let suffix = 2;
      let candidate = `${section.id}-${suffix}`;
      while (seen.has(candidate)) {
        suffix += 1;
        candidate = `${section.id}-${suffix}`;
      }
      seen.add(candidate);
      return { ...section, id: candidate };
    }),
  }));
}

function getCurrentVersion(
  doc: { current_version: number; versions: ContentVersion[] } | undefined,
): ContentVersion | undefined {
  return doc?.versions.find((v) => v.version === doc.current_version);
}

/**
 * Whether the browser has asked for reduced motion — checked at click/scroll
 * time (not cached) so a user who changes the OS setting mid-session is
 * respected immediately.
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  );
}

/**
 * The rail entry to highlight when no heading has actually scrolled past the
 * reading line yet — either a document with no sections at all, or (see
 * `computeActiveId` below) the very top of the page before any heading has
 * passed. Shared by the arrival landing and the scroll-spy so both fall back
 * to the same entry: the document's own first section, or its own heading if
 * it has none.
 *
 * Takes the document and derives its key, rather than accepting both: passing
 * `availableDocs[0]` alongside `DOC_ORDER[0]` let the two disagree, so a
 * network publishing only `terms` pilled a non-existent `#privacy`.
 */
function pillFallbackId(renderableDoc: RenderableDoc | undefined): string | undefined {
  if (!renderableDoc) return undefined;
  return renderableDoc.sections[0]?.id ?? docHeadingId(renderableDoc.doc);
}

/**
 * How close to the top of the viewport a heading must have scrolled to count
 * as "passed" — the `scroll-mt-20` (80px) offset headings carry so an anchor
 * lands them clear of the sticky app bar, plus a little slack, so the
 * highlighted entry is the one actually sitting at the top of the *readable*
 * area rather than one still hidden behind the bar.
 */
const READING_LINE_PX = 96;

/**
 * How long to wait, after the most recent scroll event, before treating a
 * click-triggered scroll as settled and handing the highlight back to the
 * spy. Deliberately a fixed debounce rather than a "smooth scroll finished"
 * callback (no such event is universally available) — each scroll event
 * in flight pushes the release out again, so a long smooth scroll is
 * protected for its whole duration, while a reduced-motion jump (at most one
 * scroll event) releases almost immediately.
 */
const SCROLL_SETTLE_MS = 150;

/**
 * Renders `/legal`: loading state, unavailable fallback, the app bar (back
 * link + language/theme controls), the two-document contents rail, and the
 * reading column holding both documents in order.
 *
 * Takes no props: which section the reader lands on comes from the URL
 * fragment, and both documents render either way.
 */
export function LegalDocumentView(): React.JSX.Element {
  const { t } = useTranslation();
  const { config, isLoading } = useConsentConfig();
  const location = useLocation();
  const [activeId, setActiveId] = useState<string>(docHeadingId(DOC_ORDER[0]));

  const availableDocs: RenderableDoc[] = useMemo(() => {
    const resolved = DOC_ORDER.map((d) => {
      const version = getCurrentVersion(config?.documents[d]);
      if (!version) return null;
      return { doc: d, version, ...splitIntoSections(version.content, version.title) };
    }).filter((d): d is NonNullable<typeof d> => d !== null);

    const deduped = dedupeSectionIdsAcrossDocs(resolved);
    return resolved.map((d, i) => ({ ...d, sections: deduped[i]!.sections }));
  }, [config]);

  const contentReady = availableDocs.some((d) => d.sections.length > 0 || Boolean(d.preamble));

  const spyTargetIds = useMemo(
    () => availableDocs.flatMap((d) => [docHeadingId(d.doc), ...d.sections.map((s) => s.id)]),
    [availableDocs],
  );

  // Scroll-spy: the rail's highlight follows whichever heading has most
  // recently scrolled past the reading line. Position-based (each heading's
  // own `getBoundingClientRect().top`), not an IntersectionObserver
  // percentage band — a band has to assume something about how tall a
  // section is, and a section shorter than the band lets the *next* heading
  // enter the band before the current one has genuinely been read, so the
  // pill jumps to it early. Comparing raw top-edge position makes no such
  // assumption: the active entry is just the last heading (in document
  // order) at or above `READING_LINE_PX`, which holds regardless of section
  // length.

  // Kept alongside `activeId` so `computeActiveId`'s no-candidate branch (an
  // empty page, defensively) has a same-render value to fall back to without
  // needing `activeId` itself in its dependency list.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const computeActiveId = useCallback((): string => {
    const elements = spyTargetIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return activeIdRef.current;

    // The last element (in document order) that has scrolled up past the
    // reading line — a document's own heading counts here too, so this
    // still finds something the moment a document's intro prose reaches the
    // top, before any of its `##`/`###` headings have.
    let lastPassed: HTMLElement | null = null;
    for (const el of elements) {
      if (el.getBoundingClientRect().top <= READING_LINE_PX) {
        lastPassed = el;
      } else {
        break;
      }
    }

    // Nothing has passed yet — genuinely at the very top of the page. Same
    // "first document's first section" fallback as the "own heading, no
    // section yet" branch below, just spelled out for the empty case.
    if (!lastPassed) return pillFallbackId(availableDocs[0]) ?? activeIdRef.current;

    const currentDoc = availableDocs.find((d) => docHeadingId(d.doc) === lastPassed!.id);
    if (!currentDoc) {
      // `lastPassed` is a section id, not a document heading — it is
      // already the entry to highlight.
      return lastPassed.id;
    }
    // `lastPassed` is a document's own heading with none of its sections
    // reached yet (its intro prose is still what's on screen) — highlight
    // its first section instead of leaving the pill on a bare doc heading,
    // which would be the same "nothing really highlighted" gap this whole
    // fallback exists to close.
    return pillFallbackId(currentDoc) ?? lastPassed.id;
  }, [spyTargetIds, availableDocs]);

  // A just-clicked rail entry, or a programmatic (arrival/deep-link) scroll,
  // is pinned for the duration of its scroll — otherwise the effect below
  // would recompute from transient mid-scroll geometry and the pill would
  // flicker across whichever entries the scroll passes through before
  // resting on the intended one.
  const pinnedIdRef = useRef<string | null>(null);
  const pinReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const armPinRelease = useCallback(() => {
    if (pinReleaseTimerRef.current) clearTimeout(pinReleaseTimerRef.current);
    pinReleaseTimerRef.current = setTimeout(() => {
      pinnedIdRef.current = null;
      setActiveId(computeActiveId());
    }, SCROLL_SETTLE_MS);
  }, [computeActiveId]);

  /**
   * Scrolls `targetElId` into view (if it exists) and pins the rail's
   * highlight to `pillId` for the duration of that scroll. The two can
   * differ: arriving at `/legal#terms` scrolls to the *document* heading
   * (`terms`) but pills its *first section* — otherwise the pinned value
   * itself would be the bare doc heading the fallback above exists to avoid.
   */
  const scrollAndPin = useCallback(
    (targetElId: string, pillId: string) => {
      setActiveId(pillId);
      pinnedIdRef.current = pillId;
      armPinRelease();
      const el = document.getElementById(targetElId);
      if (el) {
        el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
      }
    },
    [armPinRelease],
  );

  useEffect(() => {
    if (!contentReady || spyTargetIds.length === 0) return;

    function handleScroll() {
      if (pinnedIdRef.current) {
        // Still mid-flight: keep pushing the release out rather than acting
        // on this event, so a long smooth scroll stays pinned for its whole
        // duration.
        armPinRelease();
        return;
      }
      setActiveId(computeActiveId());
    }

    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleScroll);
    return () => {
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleScroll);
    };
  }, [contentReady, spyTargetIds, computeActiveId, armPinRelease]);

  // Release a pin left over from an unmounted click (e.g. navigating away
  // mid-scroll) rather than leaking the timer.
  useEffect(() => {
    return () => {
      if (pinReleaseTimerRef.current) clearTimeout(pinReleaseTimerRef.current);
    };
  }, []);

  // Deep-link / arrival landing. Two ways a target section fails to scroll
  // into view without this:
  //   (a) a rail click is a same-page anchor, not a full navigation — so the
  //       browser's own one-shot fragment-scroll never fires at all.
  //   (b) a cold `/privacy#retention` load, or a plain `/terms` load: the
  //       content this needs to scroll to only renders once the
  //       consent-config fetch resolves, which is almost always after the
  //       browser's one-shot fragment-scroll attempt (if any) has already run
  //       and found nothing.
  // The fragment is the only thing that decides where an arrival lands —
  // `#privacy`, `#terms`, or any section id. It is re-run on every hash
  // change, so a footer link to `/legal#terms` scrolls even when the reader is
  // already on the page and the browser therefore performs no navigation.
  //
  // Without it a deep link would not scroll at all: the content it targets
  // only renders once the consent-config fetch resolves, which is almost
  // always after the browser's one-shot fragment-scroll attempt has already
  // run and found nothing.
  //
  // No-hash arrival highlights nothing on its own: every document opens with
  // intro prose before its first heading, so the scroll-spy has nothing
  // "passed" at scroll-top (see `pillFallbackId`). Rather than land with the
  // rail showing no pill at all, default the highlight to the first
  // document's first section — the same fallback the spy uses once real
  // scrolling starts. `scrollAndPin` also keeps the spy from fighting a
  // programmatic scroll while it's in flight: a real browser fires genuine
  // `scroll` events for `scrollIntoView` exactly as it would for a user's own
  // scrolling, and without the pin the spy would recompute mid-flight and
  // briefly show whichever heading the animation happens to be passing
  // through.
  useEffect(() => {
    if (!contentReady) return;
    const hashId = location.hash ? decodeURIComponent(location.hash.slice(1)) : null;
    if (hashId) {
      // A hash naming a document scrolls to that document but pills its first
      // section: there is no rail entry for a bare document heading to
      // highlight, so pinning one would show no pill at all.
      const targetDoc = availableDocs.find((d) => docHeadingId(d.doc) === hashId);
      const pillId = (targetDoc && pillFallbackId(targetDoc)) ?? hashId;
      if (document.getElementById(hashId)) scrollAndPin(hashId, pillId);
      return;
    }
    // Top of the page, nothing to scroll to — just seed the pill.
    const firstPill = pillFallbackId(availableDocs[0]);
    if (firstPill) setActiveId(firstPill);
  }, [location.hash, contentReady, availableDocs, scrollAndPin]);

  /**
   * `targetId` is what gets scrolled to; `pillId` (defaulting to the same
   * value) is what the rail highlights meanwhile. They differ for a
   * document-header click: it scrolls to that document's own heading, but
   * pins the highlight to its first section — there is no rail entry for
   * the bare heading itself to highlight, since document-level highlighting
   * was removed (only section pills are a live indicator now).
   */
  function handleRailClick(targetId: string, pillId: string = targetId) {
    return (event: React.MouseEvent) => {
      event.preventDefault();
      scrollAndPin(targetId, pillId);
    };
  }

  if (isLoading) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Nothing to show only when NEITHER document resolved. Previously this
  // keyed on the routed document alone, so a network missing just one of the
  // two hid the other as well.
  if (!contentReady) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('legal.unavailable')}</p>
      </div>
    );
  }

  return (
    <div className="min-h-svh bg-background">
      <TooltipProvider>
        {/* App bar: matches `TopBar`'s own height/padding/border (the app's
            real bar elsewhere) rather than inventing new spacing, plus the
            brand logo it was missing — this page previously had no branding
            at all, which is what made it look foreign next to the rest of
            the app. `TopBar` itself isn't reused wholesale: it pulls in
            search, view-toggle, filters, notifications and login/user-menu
            state via `useAuth`, none of which mean anything on a public,
            unauthenticated legal page. `PortalHeader` is the piece that
            actually carries the logo, so it's composed here directly with
            the same language/theme controls, plus the back link — the only
            way back for someone mid-signup. */}
        {/* `bg-background` under the gradient is load-bearing: `bg-gradient-to-r
            from-background to-primary/5` is a *translucent* image (its right
            stop is 5% alpha), and unlike `TopBar` — whose page content lives in
            its own `overflow-y-auto` <main> and so never passes underneath —
            this page scrolls the window itself, so without an opaque base the
            reading column showed straight through the bar. Height and padding
            still match `TopBar`.

            `h-14` rather than `min-h-14`: a fixed height is what lets the
            contents rail below park itself exactly under the bar via
            `md:top-14` without the two measurements drifting apart. Nothing in
            this bar wraps at any width — the back link collapses to its icon
            below `sm` — so there is no row for a min-height to grow for. */}
        <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b bg-background bg-gradient-to-r from-background to-primary/5 px-4 py-2 sm:px-6">
          <PortalHeader />
          {/* Label drops below `sm` (icon-only) so a long wordmark plus
              language/theme controls never wrap the row and overlap the
              content underneath — same collapse `TopBar`'s own Back control
              uses. The link stays reachable and named for screen readers via
              `aria-label` either way. */}
          <Link
            to="/auth/login"
            aria-label={t('legal.back_to_sign_in')}
            className="inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-muted-foreground transition-colors hover:text-primary"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">{t('legal.back_to_sign_in')}</span>
          </Link>
          <div className="ml-auto flex items-center gap-1">
            <LanguageSwitcher compact />
            <ThemeModeToggle />
          </div>
        </header>
      </TooltipProvider>

      <div className="px-6 py-8">
        <div className="mx-auto max-w-5xl">
          <div className="grid gap-6 md:grid-cols-[236px_1fr] md:gap-10">
            <nav
              aria-label={t('legal.contents_label')}
              // `md:top-14` parks the rail directly under the sticky app bar
              // (`h-14`) rather than under the viewport top, where the bar was
              // covering its first entries.
              //
              // `max-h` + `overflow-y-auto` are what make it usable at all: a
              // sticky element is only as scrollable as the box it is given, and
              // this rail is taller than the viewport on every network (two
              // documents, ~25 sections). Without a bounded height its tail sat
              // below the fold with no way — wheel, drag or keyboard — to reach
              // it. `overscroll-contain` stops a wheel that reaches the rail's
              // end from carrying on into the page behind it.
              className="border-b border-border pb-6 mb-6 md:sticky md:top-14 md:mb-0 md:max-h-[calc(100svh-3.5rem)] md:self-start md:overflow-y-auto md:overscroll-contain md:border-b-0 md:border-r md:py-6 md:pr-6"
            >
              {availableDocs.map(({ doc: d, version, sections }) => {
                const headingId = docHeadingId(d);

                return (
                  <div key={d} className="mb-6">
                    <a
                      href={`#${headingId}`}
                      onClick={handleRailClick(headingId, sections[0]?.id ?? headingId)}
                      className="block rounded-md px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
                    >
                      {version.title}
                    </a>
                    <ul className="mt-1 space-y-0.5">
                      {sections.map((section) => {
                        const isActiveSection = activeId === section.id;
                        return (
                          <li key={section.id}>
                            <a
                              href={`#${section.id}`}
                              onClick={handleRailClick(section.id)}
                              aria-current={isActiveSection ? 'true' : undefined}
                              className={cn(
                                'block rounded-md border-l-2 py-1.5 pl-3 text-[12.5px] transition-colors',
                                isActiveSection
                                  ? 'border-primary bg-primary/10 font-semibold text-primary'
                                  : 'border-transparent text-muted-foreground hover:bg-muted hover:text-primary',
                              )}
                            >
                              {section.heading}
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </nav>

            <div className="min-w-0 max-w-[72ch]">
              {availableDocs.map(({ doc: d, version, preamble, sections }, index) => {
                const effectiveDate = new Date(version.effective_from).toLocaleDateString();
                // The first document on the page is its <h1> — there is only
                // ever one per page — and the rest are <h2>s: real headings,
                // just not the page's primary one. Fixed by position rather
                // than by route, now that there is only one route.
                const DocHeading = index === 0 ? 'h1' : 'h2';
                return (
                  <div key={d}>
                    {index > 0 && <hr className="mt-11 border-t border-border" />}
                    <DocHeading
                      id={docHeadingId(d)}
                      className={cn(
                        'text-2xl font-bold text-foreground scroll-mt-20',
                        index > 0 && 'mt-9',
                      )}
                    >
                      {version.title}
                    </DocHeading>
                    <p className="mb-6 text-xs text-muted-foreground">
                      {t('legal.version_effective', {
                        version: version.version,
                        date: effectiveDate,
                      })}
                    </p>

                    {preamble && <Markdown>{preamble}</Markdown>}

                    {sections.map((section) =>
                      section.level === 2 ? (
                        <div key={section.id}>
                          <h2
                            id={section.id}
                            className="mt-8 mb-2 text-lg font-semibold text-foreground scroll-mt-20"
                          >
                            {section.heading}
                          </h2>
                          {section.body && <Markdown>{section.body}</Markdown>}
                        </div>
                      ) : (
                        <div key={section.id}>
                          <h3
                            id={section.id}
                            className="mt-6 mb-2 text-base font-semibold text-foreground scroll-mt-20"
                          >
                            {section.heading}
                          </h3>
                          {section.body && <Markdown>{section.body}</Markdown>}
                        </div>
                      ),
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
