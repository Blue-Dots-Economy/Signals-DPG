import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MapErrorBoundary } from '../map-error-boundary';

function Boom(): React.ReactElement {
  throw new Error('No active map provider "google-maps". Registered: leaflet');
}

/**
 * Found in QA: a `RefererNotAllowedMapError` left the Google Maps API
 * half-initialized, every `<AdvancedMarker>` then threw
 * `Cannot read properties of undefined (reading 'getRootNode')`, and the
 * result was ~190 console errors and a BLANK page — toolbar, filters and
 * results all gone, because nothing contained the throw.
 */
describe('MapErrorBoundary', () => {
  it('renders the fallback instead of propagating a provider failure', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <MapErrorBoundary>
          <Boom />
        </MapErrorBoundary>,
      );

      expect(screen.getByTestId('map-failure-notice')).toBeInTheDocument();
      expect(screen.getByRole('status')).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('logs the underlying error, which names the provider or Maps error code', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <MapErrorBoundary>
          <Boom />
        </MapErrorBoundary>,
      );

      // Diagnosing a blank map without this is guesswork.
      expect(consoleError).toHaveBeenCalledWith(
        'Map provider failed; rendering the fallback instead:',
        expect.objectContaining({ message: expect.stringContaining('No active map provider') }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('renders children untouched when nothing throws', () => {
    render(
      <MapErrorBoundary>
        <p>the map</p>
      </MapErrorBoundary>,
    );

    expect(screen.getByText('the map')).toBeInTheDocument();
    expect(screen.queryByTestId('map-failure-notice')).toBeNull();
  });
});
