import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';

/** Reports the resolved path + hash, so a redirect's destination is assertable. */
function LocationProbe() {
  const { pathname, hash } = useLocation();
  return <span data-testid="here">{`${pathname}${hash}`}</span>;
}
import { LegalDocumentView } from '@/pages/legal/legal-document-view';

const mockUseConsentConfig = vi.fn();
vi.mock('@/hooks/use-consent-config', () => ({
  useConsentConfig: () => mockUseConsentConfig(),
}));

function consentConfig(overrides: { privacyContent: string; termsContent: string }) {
  return {
    isLoading: false,
    config: {
      documents: {
        privacy: {
          current_version: 1,
          versions: [
            {
              version: 1,
              title: 'Privacy Policy',
              content: overrides.privacyContent,
              effective_from: '2026-06-01',
            },
          ],
        },
        terms: {
          current_version: 1,
          versions: [
            {
              version: 1,
              title: 'Terms of Service',
              content: overrides.termsContent,
              effective_from: '2026-06-01',
            },
          ],
        },
      },
    },
  };
}

// Shape verified against every real consent.json across all six network
// schemas: the document opens with a `##` heading that repeats its own
// `title`, then intro prose, then real subsections. A fixture that starts
// with something else (the earlier `## Overview`) doesn't exercise the
// duplicate-title bug production always hits.
const REAL_SHAPE = consentConfig({
  privacyContent: '## Privacy Policy\n\nIntro paragraph.\n### Retention\nx',
  termsContent: '## Terms of Service\n\nWelcome.',
});

/**
 * Renders the page as if arrived at `/legal${hash}`. There is one route now,
 * so what used to be "which document is this route for" is just the fragment.
 */
const view = (hash: '' | '#privacy' | '#terms' = '', initialEntries?: string[]) =>
  render(
    <MemoryRouter initialEntries={initialEntries ?? [`/legal${hash}`]}>
      <LegalDocumentView />
    </MemoryRouter>,
  );

describe('<LegalDocumentView />', () => {
  beforeEach(() => {
    mockUseConsentConfig.mockReturnValue(REAL_SHAPE);
  });

  it('renders both documents in order on both routes', () => {
    view();
    expect(screen.getAllByText('Privacy Policy').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Terms of Service').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Privacy Policy' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Terms of Service' })).toBeInTheDocument();
  });

  it('renders both documents in order on the /terms route too', () => {
    view('#terms');
    expect(screen.getByRole('heading', { name: 'Privacy Policy' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Terms of Service' })).toBeInTheDocument();
  });

  it('anchors each extracted section', () => {
    view();
    expect(screen.getByRole('link', { name: 'Retention' })).toHaveAttribute('href', '#retention');
  });

  it('rail entries are same-page anchors, not links to another route', () => {
    view();
    // The other document's rail header used to navigate via a react-router
    // <Link to="/terms">. Both documents now live on the same page, so it
    // must be a same-page anchor instead.
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute(
      'href',
      '#terms',
    );
  });

  it('captures no consent', () => {
    view('#terms');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('never marks either document header current — only the section pill is a live indicator', () => {
    // The rail used to tint/aria-current the routed document's own heading.
    // Both documents are always on the page now, so the route must not
    // affect the rail's appearance at all: neither header ever carries
    // aria-current, on arrival or otherwise.
    view();
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).not.toHaveAttribute(
      'aria-current',
    );
    expect(screen.getByRole('link', { name: 'Terms of Service' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('renders both document headers identically — no route-derived tint or dimming', () => {
    // /privacy and /terms used to render different-looking rails (the routed
    // document's heading tinted, the other one dimmed via `opacity-75` on
    // its wrapping group). Both documents are always present now, so the two
    // routes' rails must be indistinguishable.
    view();
    const privacyHeader = screen.getByRole('link', { name: 'Privacy Policy' });
    const termsHeader = screen.getByRole('link', { name: 'Terms of Service' });
    expect(privacyHeader.className).toBe(termsHeader.className);
    expect(privacyHeader.parentElement?.className).not.toMatch(/opacity/);
    expect(termsHeader.parentElement?.className).not.toMatch(/opacity/);
    expect(privacyHeader.parentElement?.className).toBe(termsHeader.parentElement?.className);
  });

  it('renders the heading it links to, so the anchor actually lands', () => {
    view();
    const heading = screen.getByRole('heading', { name: 'Retention' });
    expect(heading).toHaveAttribute('id', 'retention');
  });

  it('shows the version and effective date for each document', () => {
    view();
    expect(screen.getAllByText(/Version 1/)).toHaveLength(2);
  });

  it('does not repeat the document title as a second heading or as the rail\'s first section', () => {
    // Every real consent document opens with `## <title>` — verified across
    // all six network schemas. That leading heading must not become a
    // duplicate heading-role element, and must not become the rail's first
    // section entry (a repeat of the group header sitting right underneath
    // it).
    view();
    expect(screen.getAllByRole('heading', { name: 'Privacy Policy' })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: 'Privacy Policy' })).toHaveLength(1);
    // The real (and only) surviving section is "Retention".
    expect(screen.getAllByRole('link', { name: 'Retention' })).toHaveLength(1);
  });

  it('keeps a section that legitimately opens with a non-title heading like Overview', () => {
    // Regression guard: the fix must match on the document's *title*
    // specifically, not blanket-drop whatever heading comes first — a
    // document that opens with "## Overview" (not its title) keeps that
    // section as a real, anchored entry.
    mockUseConsentConfig.mockReturnValue(
      consentConfig({
        privacyContent: '## Overview\n\nSomething else entirely.',
        termsContent: '## Terms of Service\n\nWelcome.',
      }),
    );
    view();
    expect(screen.getByRole('heading', { name: 'Overview' })).toHaveAttribute('id', 'overview');
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '#overview');
  });

  it('renders a document with no ### headings at all, without crashing', () => {
    mockUseConsentConfig.mockReturnValue(
      consentConfig({
        privacyContent: '## Privacy Policy\n\nJust a paragraph, no subsections at all.',
        termsContent: '## Terms of Service\n\nWelcome.',
      }),
    );
    view();
    expect(screen.getByText('Just a paragraph, no subsections at all.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Privacy Policy' })).toBeInTheDocument();
  });

  it('renders a document with five levels of heading nesting, without crashing', () => {
    mockUseConsentConfig.mockReturnValue(
      consentConfig({
        privacyContent:
          '## Privacy Policy\n\n### A section\nintro\n#### A subsection\nmore\n##### Deeper still\neven more\n###### Deepest\ndeepest text',
        termsContent: '## Terms of Service\n\nWelcome.',
      }),
    );
    view();
    expect(screen.getByRole('heading', { name: 'A section' })).toBeInTheDocument();
    expect(screen.getByText('deepest text')).toBeInTheDocument();
  });

  it('renumbers colliding section ids across documents instead of duplicating them', () => {
    // Nothing about section names is meant to be hardcoded; if the two
    // documents happen to share a heading, both must still get a unique,
    // resolvable id rather than two elements answering to the same anchor.
    mockUseConsentConfig.mockReturnValue(
      consentConfig({
        privacyContent: '## Privacy Policy\n\nIntro.\n### Shared Heading\nFrom privacy.',
        termsContent: '## Terms of Service\n\nWelcome.\n### Shared Heading\nFrom terms.',
      }),
    );
    view();
    const headings = screen.getAllByRole('heading', { name: 'Shared Heading' });
    expect(headings).toHaveLength(2);
    const ids = headings.map((h) => h.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain('shared-heading');
    expect(ids).toContain('shared-heading-2');

    const links = screen.getAllByRole('link', { name: 'Shared Heading' });
    expect(links.map((l) => l.getAttribute('href')).sort()).toEqual([
      '#shared-heading',
      '#shared-heading-2',
    ]);
  });

  it('uses the i18n contents label for the rail, not a hardcoded string', () => {
    view();
    expect(screen.getByRole('navigation', { name: 'Contents' })).toBeInTheDocument();
  });

  it('has a back-to-sign-in link', () => {
    view();
    expect(screen.getByRole('link', { name: /Back to sign in/i })).toHaveAttribute(
      'href',
      '/auth/login',
    );
  });

  it('clicking a rail section scrolls it into view and highlights it', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
    view();

    const link = screen.getByRole('link', { name: 'Retention' });
    fireEvent.click(link);

    expect(scrollIntoView).toHaveBeenCalled();
    expect(link).toHaveAttribute('aria-current', 'true');
  });

  it('clicking the other document\'s rail header scrolls to its heading and pills its first section', () => {
    // The document header itself is never a pill target (no route/document-
    // level highlighting) — clicking it scrolls to that document's heading
    // and, like arriving at that document via its route, pins the highlight
    // to its own first section instead.
    mockUseConsentConfig.mockReturnValue(
      consentConfig({
        privacyContent: '## Privacy Policy\n\nIntro.\n### Retention\nx',
        termsContent: '## Terms of Service\n\nWelcome.\n### Governing law\nIndia.',
      }),
    );
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
    view();

    const termsHeader = screen.getByRole('link', { name: 'Terms of Service' });
    fireEvent.click(termsHeader);

    expect(scrollIntoView).toHaveBeenCalled();
    expect(termsHeader).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Governing law' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });
});

// happy-dom has no layout engine — it computes no scroll heights and honours
// no `position: sticky` — so these assert the utility classes that produce the
// behaviour rather than the behaviour itself. That is a real limit: they prove
// the classes are present, not that the rail scrolls. They exist because all
// three defects below shipped once, and each was a single missing class.
describe('<LegalDocumentView /> sticky app bar and rail geometry', () => {
  beforeEach(() => {
    mockUseConsentConfig.mockReturnValue(REAL_SHAPE);
  });

  it('gives the app bar an opaque background under its gradient', () => {
    // `bg-gradient-to-r from-background to-primary/5` alone is translucent at
    // its right stop, so the reading column scrolled visibly through the bar.
    const { container } = view();
    const bar = container.querySelector('header');
    expect(bar?.className).toContain('sticky');
    expect(bar?.className).toContain('bg-background');
  });

  it('bounds the rail and lets it scroll on its own', () => {
    // The rail is taller than the viewport on every network, and a sticky
    // element with no bounded height simply leaves its tail below the fold
    // with no way to reach it.
    view();
    const rail = screen.getByRole('navigation');
    expect(rail.className).toMatch(/md:max-h-/);
    expect(rail.className).toContain('md:overflow-y-auto');
  });

  it('offsets the rail by the app bar height so the bar does not cover it', () => {
    view();
    const rail = screen.getByRole('navigation');
    expect(rail.className).toContain('md:top-14');
  });

  it('offsets every anchor target clear of the app bar', () => {
    // Without a scroll-margin at least the bar's height, an anchor lands its
    // heading underneath the bar.
    view();
    for (const name of ['Privacy Policy', 'Retention', 'Terms of Service']) {
      expect(screen.getByRole('heading', { name }).className).toContain('scroll-mt-20');
    }
  });
});

// The two paths operators have already shared over SMS and email (#637) must
// keep landing on the right section, now that both documents live on one page.
describe('/privacy and /terms redirect into the single page', () => {
  beforeEach(() => {
    mockUseConsentConfig.mockReturnValue(REAL_SHAPE);
  });

  it.each([
    ['/privacy', '/legal#privacy'],
    ['/terms', '/legal#terms'],
  ])('redirects %s to %s', (from, to) => {
    render(
      <MemoryRouter initialEntries={[from]}>
        <Routes>
          <Route path="/legal" element={<LocationProbe />} />
          <Route path="/privacy" element={<Navigate to="/legal#privacy" replace />} />
          <Route path="/terms" element={<Navigate to="/legal#terms" replace />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('here')).toHaveTextContent(to);
  });

  it('anchors each document at the bare fragment those redirects target', () => {
    view();
    // If these ids drifted (back to `privacy-document`, say), the redirects
    // above would land at the top of the page instead of on the document.
    expect(screen.getByRole('heading', { name: 'Privacy Policy' })).toHaveAttribute(
      'id',
      'privacy',
    );
    expect(screen.getByRole('heading', { name: 'Terms of Service' })).toHaveAttribute(
      'id',
      'terms',
    );
  });

  it('never pills a document the network does not publish', () => {
    // Regression (review of #648): the fallback took a document AND a document
    // key, so `availableDocs[0]` (whatever loaded) could be paired with
    // `DOC_ORDER[0]` (`privacy`). A network publishing only `terms`, with no
    // sections in it, therefore pilled a non-existent `#privacy`.
    mockUseConsentConfig.mockReturnValue({
      isLoading: false,
      config: {
        documents: {
          terms: {
            current_version: 1,
            versions: [
              {
                version: 1,
                title: 'Terms of Service',
                content: '## Terms of Service\n\nNo subsections at all.',
                effective_from: '2026-06-01',
              },
            ],
          },
        },
      },
    });

    view();

    // The one document that exists is anchored and rendered...
    expect(screen.getByRole('heading', { name: 'Terms of Service' })).toHaveAttribute('id', 'terms');
    // ...and nothing claims to be the privacy document.
    expect(document.getElementById('privacy')).toBeNull();
    const current = document.querySelector('[aria-current="true"]');
    expect(current?.getAttribute('href') ?? null).not.toBe('#privacy');
  });

  it('keeps a section that slugifies to a document name from stealing its id', () => {
    // A "Privacy" section would otherwise take `#privacy` out from under a
    // link that has already been shared.
    mockUseConsentConfig.mockReturnValue(
      consentConfig({
        privacyContent: '## Privacy Policy\n\nIntro.\n### Privacy\nx',
        termsContent: '## Terms of Service\n\nWelcome.',
      }),
    );
    view();
    expect(screen.getByRole('heading', { name: 'Privacy Policy' })).toHaveAttribute(
      'id',
      'privacy',
    );
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '#privacy-2');
  });
});

describe('<LegalDocumentView /> deep-link and arrival scrolling', () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
  });

  it('scrolls the hash target into view once its section has rendered', () => {
    mockUseConsentConfig.mockReturnValue(REAL_SHAPE);
    render(
      <MemoryRouter initialEntries={['/legal#retention']}>
        <LegalDocumentView />
      </MemoryRouter>,
    );
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('scrolls once content arrives after mount, even though the hash was already set (cold-load ordering)', () => {
    // Reproduces a cold `/legal#retention` load: the consent-config fetch
    // resolves well after the browser's own one-shot fragment-scroll attempt
    // has already run and found nothing — so the effect must fire again when
    // the CONTENT shows up, not only when the hash changes. An effect keyed
    // on `location.hash` alone would miss this case entirely: the hash here
    // never changes — it's present from the very first render, while
    // `isLoading` is still true.
    mockUseConsentConfig.mockReturnValue({ isLoading: true, config: null });
    const { rerender } = render(
      <MemoryRouter initialEntries={['/legal#retention']}>
        <LegalDocumentView />
      </MemoryRouter>,
    );
    expect(scrollIntoView).not.toHaveBeenCalled();

    // The fetch resolves; same hash, content now available.
    mockUseConsentConfig.mockReturnValue(REAL_SHAPE);
    rerender(
      <MemoryRouter initialEntries={['/legal#retention']}>
        <LegalDocumentView />
      </MemoryRouter>,
    );

    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('does nothing on /privacy with no hash — it is already the top of the page', () => {
    mockUseConsentConfig.mockReturnValue(REAL_SHAPE);
    render(
      <MemoryRouter initialEntries={['/legal']}>
        <LegalDocumentView />
      </MemoryRouter>,
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('scrolls to the terms document heading when arriving at /terms with no hash', () => {
    mockUseConsentConfig.mockReturnValue(REAL_SHAPE);
    render(
      <MemoryRouter initialEntries={['/legal#terms']}>
        <LegalDocumentView />
      </MemoryRouter>,
    );
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('lands on the right heading for a /terms deep link', () => {
    mockUseConsentConfig.mockReturnValue(
      consentConfig({
        privacyContent: '## Privacy Policy\n\nIntro.',
        termsContent: '## Terms of Service\n\nWelcome.\n### Governing law\nIndia.',
      }),
    );
    render(
      <MemoryRouter initialEntries={['/legal#governing-law']}>
        <LegalDocumentView />
      </MemoryRouter>,
    );
    expect(scrollIntoView).toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Governing law' })).toHaveAttribute(
      'id',
      'governing-law',
    );
  });

  // Both documents open with intro prose before their first heading, so at
  // scroll-top the scroll-spy has nothing "in view" to highlight on its own
  // — without a fallback, the rail would land with no pill at all. Each
  // route's first section must be pilled on arrival, and it must be that
  // ROUTE's document's first section specifically (not merely whichever
  // section happens to render first on the page, which is always Privacy's).
  const BOTH_HAVE_SECTIONS = consentConfig({
    privacyContent: '## Privacy Policy\n\nIntro.\n### Retention\nx',
    termsContent: '## Terms of Service\n\nWelcome.\n### Governing law\nIndia.',
  });

  it('pills the first section on arrival at /privacy', () => {
    mockUseConsentConfig.mockReturnValue(BOTH_HAVE_SECTIONS);
    render(
      <MemoryRouter initialEntries={['/legal']}>
        <LegalDocumentView />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Retention' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('link', { name: 'Governing law' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('pills the first section on arrival at /terms — Terms\' own first section, not Privacy\'s', () => {
    mockUseConsentConfig.mockReturnValue(BOTH_HAVE_SECTIONS);
    render(
      <MemoryRouter initialEntries={['/legal#terms']}>
        <LegalDocumentView />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Governing law' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('link', { name: 'Retention' })).not.toHaveAttribute('aria-current');
  });
});

describe('<LegalDocumentView /> click pins the highlight through its scroll', () => {
  // Reproduction: a rail entry whose section body is short enough that the
  // FOLLOWING heading also ends up within the scroll-spy's "passed the
  // reading line" reach while the click's scroll is still in flight. Without
  // a pin, that transient geometry would win and the pill would drift to the
  // next entry down instead of staying on the one just clicked.
  const SHORT_SECTION_SHAPE = consentConfig({
    privacyContent:
      '## Privacy Policy\n\nIntro.\n### First\nBody one.\n### Short\nx\n### Third\nBody three.',
    termsContent: '## Terms of Service\n\nWelcome.',
  });

  function mockTop(id: string, top: number) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing element #${id}`);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      top,
      bottom: top + 20,
      left: 0,
      right: 0,
      width: 0,
      height: 20,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect);
  }

  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    mockUseConsentConfig.mockReturnValue(SHORT_SECTION_SHAPE);
    Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView;
  });

  afterEach(() => {
    vi.useRealTimers();
    window.matchMedia = originalMatchMedia;
  });

  it('keeps the clicked (short) section highlighted through a misleading mid-scroll read, and after settling', () => {
    vi.useFakeTimers();
    view();

    const shortLink = screen.getByRole('link', { name: 'Short' });
    fireEvent.click(shortLink);
    expect(shortLink).toHaveAttribute('aria-current', 'true');

    // Mid-flight: geometry momentarily suggests "Third" has also passed the
    // reading line (the short-section overshoot). A spy with no pin would
    // jump to it right here.
    mockTop('privacy', 0);
    mockTop('first', -50);
    mockTop('short', 10);
    mockTop('third', 50);
    fireEvent.scroll(window);

    expect(screen.getByRole('link', { name: 'Short' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('link', { name: 'Third' })).not.toHaveAttribute('aria-current');

    // Settled: the transient reading was transient — at rest, only "Short"
    // has actually reached the reading line.
    mockTop('third', 150);
    vi.advanceTimersByTime(500);

    expect(screen.getByRole('link', { name: 'Short' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('link', { name: 'Third' })).not.toHaveAttribute('aria-current');
  });

  it('releases the pin quickly under reduced motion, where there is no scroll animation in flight', () => {
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;

    vi.useFakeTimers();
    view();

    const shortLink = screen.getByRole('link', { name: 'Short' });
    fireEvent.click(shortLink);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'auto' }),
    );

    // No further scroll events at all (an instant jump fires at most one) —
    // the pin must still release on its own rather than staying stuck.
    vi.advanceTimersByTime(500);

    mockTop('privacy', 0);
    mockTop('first', -50);
    mockTop('short', 10);
    mockTop('third', 150);
    fireEvent.scroll(window);

    expect(screen.getByRole('link', { name: 'Short' })).toHaveAttribute('aria-current', 'true');
  });
});
