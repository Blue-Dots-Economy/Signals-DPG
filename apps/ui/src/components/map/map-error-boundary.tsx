import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { MapPinOff } from 'lucide-react';

/**
 * Contains a map-provider failure to the map.
 *
 * Without this, anything the provider throws unmounts the whole browse page.
 * Two failures seen in QA, both from the Google provider:
 *
 *   - `No active map provider "<name>"` — a misconfigured `VITE_MAP_PROVIDER`
 *     throws during render.
 *   - `RefererNotAllowedMapError` leaves the Maps API half-initialized, and
 *     every `<AdvancedMarker>` then throws `Cannot read properties of
 *     undefined (reading 'getRootNode')` — ~190 console errors and a blank
 *     screen, with the toolbar and results gone too.
 *
 * A tile/key problem is a deployment issue, not a reason to lose the page, so
 * the map's own area degrades to a message and everything around it survives.
 * `heightClassName` mirrors `MapView`'s so the fallback occupies the same box
 * and the layout does not jump.
 *
 * A class component because `componentDidCatch` has no hook equivalent.
 */
interface MapErrorBoundaryProps {
  children: React.ReactNode;
  heightClassName?: string;
}

interface MapErrorBoundaryState {
  error: Error | null;
}

export class MapErrorBoundary extends React.Component<
  MapErrorBoundaryProps,
  MapErrorBoundaryState
> {
  state: MapErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): MapErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Kept: the message is the only place the provider name / Maps error code
    // survives, and diagnosing a blank map without it is guesswork.
    console.error('Map provider failed; rendering the fallback instead:', error);
  }

  render() {
    if (this.state.error) {
      return <MapFailureNotice heightClassName={this.props.heightClassName} />;
    }
    return this.props.children;
  }
}

function MapFailureNotice({ heightClassName }: Readonly<{ heightClassName?: string }>) {
  const { t } = useTranslation();
  return (
    // <output> rather than a <div role="status">: it carries the status role
    // implicitly, so assistive tech and `getByRole('status')` behave the same
    // while using the native element (Sonar S6819). `block` because <output>
    // is inline by default, which would collapse the flex column below.
    <output
      data-testid="map-failure-notice"
      className={`flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center ${
        heightClassName ?? 'h-[calc(100dvh-8rem)] min-h-[400px]'
      }`}
    >
      <MapPinOff className="h-6 w-6 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium text-foreground">{t('map.unavailable_title')}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{t('map.unavailable_body')}</p>
    </output>
  );
}
