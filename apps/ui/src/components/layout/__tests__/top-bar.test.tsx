import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TopBar } from '../top-bar';

const mockUseAuth = vi.fn();

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('@/hooks/use-actions', () => ({
  usePendingActionsCount: () => ({ data: 0 }),
}));

vi.mock('@/components/auth/user-menu', () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));

vi.mock('@/components/layout/theme-mode-toggle', () => ({
  ThemeModeToggle: () => <div data-testid="theme" />,
}));

vi.mock('@/components/layout/language-switcher', () => ({
  LanguageSwitcher: () => <div data-testid="lang" />,
}));

// NOTE: SidebarTrigger (rendered unconditionally by TopBar) calls useSidebar(),
// which throws outside a SidebarProvider — so every render here, including the
// form-variant cases, must stay wrapped in one.
function renderBar(props: Partial<React.ComponentProps<typeof TopBar>> = {}) {
  return render(
    <MemoryRouter>
      <SidebarProvider>
        <TopBar
          search=""
          onSearchChange={() => {}}
          viewMode="map"
          onViewModeChange={() => {}}
          {...props}
        />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

describe('TopBar search accessibility', () => {
  it('exposes the search input by an accessible name', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    renderBar();
    expect(screen.getByRole('searchbox', { name: /search/i })).toBeInTheDocument();
  });
});

describe('TopBar mobile decluttering (W1.3)', () => {
  it('hides the inline Language/Theme group on mobile only when authenticated', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    renderBar();
    // LanguageSwitcher is mocked to a bare div, so its own tag can't be used
    // as the closest('div') anchor (it would match itself) — go via parentElement.
    const wrapper = screen.getByTestId('lang').parentElement;
    expect(wrapper).toHaveClass('hidden', 'md:flex');
  });

  it('keeps the inline Language/Theme group visible on mobile when logged out', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    renderBar();
    const wrapper = screen.getByTestId('lang').parentElement;
    expect(wrapper).not.toHaveClass('hidden');
  });

  it('wraps the inline notification bell so it is md-only when authenticated', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    renderBar();
    const bell = screen.getByRole('button', { name: /pending actions/i });
    expect(bell.closest('span')).toHaveClass('hidden', 'md:inline-flex');
  });
});

describe('TopBar — form variant', () => {
  it('hides browse controls and shows Back + title', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    renderBar({ variant: 'form', title: 'Edit Provider Profile', onBack: vi.fn() });
    expect(screen.getByText('Edit Provider Profile')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    // view toggle (map/list) is gone
    expect(screen.queryByRole('radio', { name: /map view/i })).not.toBeInTheDocument();
    // account controls stay
    expect(screen.getByTestId('user-menu')).toBeInTheDocument();
    expect(screen.getByTestId('theme')).toBeInTheDocument();
    expect(screen.getByTestId('lang')).toBeInTheDocument();
  });

  it('browse variant still renders search + view toggle', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    renderBar({ variant: 'browse' });
    expect(screen.getByRole('searchbox')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /map view/i })).toBeInTheDocument();
  });
});

describe('TopBar search row placement on mobile', () => {
  /**
   * Reported from a real phone: row one held nothing but icons and a gap while
   * the search sat on a line of its own below it — two rows of chrome before
   * any content. The search now shares row one WHEN THERE IS ROOM, and the
   * room depends on auth: the language + theme pair beside it is hidden under
   * `md` only for a signed-in viewer.
   */
  const searchWrapper = () =>
    document.querySelector('input[type="search"]')?.parentElement;

  it('lets the search share row one when signed in', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    renderBar();

    const cls = searchWrapper()?.className ?? '';
    expect(cls).toContain('flex-1');
    // `order-last w-full` is what pushed it onto its own line.
    expect(cls).not.toContain('order-last');
    expect(cls).not.toMatch(/(^|\s)w-full(\s|$)/);
  });

  it('keeps the search on its own line when signed out, rather than crushing it', () => {
    // Signed out, the language switcher and theme toggle are both present, so
    // the row genuinely cannot fit a legible search box beside them. A stub of
    // a search box is worse than a second line.
    mockUseAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    renderBar();

    const cls = searchWrapper()?.className ?? '';
    expect(cls).toContain('order-last');
    expect(cls).toContain('w-full');
  });

  it('is inline and wide from sm up regardless of auth', () => {
    for (const isAuthenticated of [true, false]) {
      mockUseAuth.mockReturnValue({ isAuthenticated, isLoading: false });
      const { unmount } = renderBar();
      const cls = searchWrapper()?.className ?? '';
      expect(cls).toContain('sm:flex-1');
      expect(cls).toContain('sm:max-w-2xl');
      unmount();
    }
  });
});
