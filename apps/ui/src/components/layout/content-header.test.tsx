import type * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ContentHeader } from './content-header';

// The no-profile prompt renders a router <Link>, so anything that can show it
// needs a Router in scope.
const inRouter = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('ContentHeader', () => {
  it('renders nothing when every slot is empty', () => {
    // #645 stripped the title, description and count out of this header, so a
    // signed-in viewer who already has a profile leaves every slot empty — and
    // the wrapper's `mb-6` then drew a dead band between the filter bar and
    // the results.
    const { container } = render(
      <ContentHeader noProfilePrompt={{ show: false, networkId: 'blue_dot' }} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders when it has the no-profile prompt to show', () => {
    const { container } = inRouter(
      <ContentHeader noProfilePrompt={{ show: true, networkId: 'blue_dot' }} />,
    );

    expect(container).not.toBeEmptyDOMElement();
  });

  it('renders when it has a title', () => {
    const { container } = render(<ContentHeader title="Providers" />);
    expect(container).not.toBeEmptyDOMElement();
  });
});
