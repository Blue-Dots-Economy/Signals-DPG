import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthFooter } from '@/components/layout/auth-footer';

vi.mock('@/theme/theme-provider', async () => {
  const { resolveTheme } = await import('@/theme/network-themes');
  return {
    useNetworkTheme: () => ({
      themeId: 'blue_dot',
      theme: resolveTheme('blue_dot'),
      brand: 'standard',
    }),
  };
});

describe('<AuthFooter />', () => {
  it('links to the public pages rather than opening a modal', () => {
    render(
      <MemoryRouter>
        <AuthFooter />
      </MemoryRouter>,
    );

    // One page holds both documents; the fragment picks the section. `/privacy`
    // and `/terms` still resolve — they redirect here — but a link that already
    // knows where it is going should not spend a redirect to get there.
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
      'href',
      '/legal#privacy',
    );
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/legal#terms');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
