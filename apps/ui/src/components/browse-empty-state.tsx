import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';

export interface BrowseEmptyStateProps {
  /** Typed query, if any — an empty result then means "no matches", not "nothing here". */
  search: string;
  signedIn: boolean;
  /** Whether the viewer has an own profile to browse from. */
  hasProfile: boolean;
  /** Target of the create-profile CTA. */
  networkId: string;
  /** Plural label of the domain being browsed, for the fallback message. */
  domainLabel: string;
  /** Whether a centre resolved, i.e. whether the list was location-bounded. */
  hasLocation: boolean;
  /** The radius the list actually applied, in metres; undefined when unbounded. */
  distanceMeters?: number;
  /** Raw `useUserLocation` source — 'browser' reads as "your current location". */
  locationSource: string;
}

/**
 * "Nothing to show" for the browse list, in the one variant that is true.
 *
 * Lives in its own component rather than as a nested `buildEmptyState` inside
 * `HomePage` because five mutually exclusive branches at one nesting level cost
 * roughly nine points of cognitive complexity on the enclosing function
 * (Sonar S3776) — HomePage was over the limit on that alone. The branches
 * belong together, so the fix is to move them out as a unit, not to flatten
 * them in place.
 *
 * Order is load-bearing: most specific cause first, so the message names the
 * thing the viewer can actually act on.
 */
export function BrowseEmptyState({
  search,
  signedIn,
  hasProfile,
  networkId,
  domainLabel,
  hasLocation,
  distanceMeters,
  locationSource,
}: Readonly<BrowseEmptyStateProps>) {
  const { t } = useTranslation();

  if (search) return <EmptyState message={t('home.no_search_results', { search })} />;

  // GuestHero already shows the sign-in CTA — keep this message simple.
  if (!signedIn) return <EmptyState message={t('home.no_listings_yet')} />;

  if (!hasProfile) {
    return (
      <EmptyState
        heading={t('home.empty_create_heading')}
        message={t('home.empty_create_message')}
        action={
          <Button asChild size="sm">
            <Link to={`/profile/new?network=${networkId}`}>{t('nav.create_profile')}</Link>
          </Button>
        }
      />
    );
  }

  // Location-bounded discover returned nothing: the network may well have
  // listings — just none within the (hard) radius. Say THAT, not "none in
  // this network" (false) or nothing at all. Mirrors the map's area-scoped
  // empty message; the Location control makes trying elsewhere actionable.
  if (hasLocation && distanceMeters !== undefined) {
    return (
      <EmptyState
        heading={t('home.nothing_here_heading')}
        message={t('home.no_listings_in_radius', {
          km: Math.round(distanceMeters / 1000),
          locationSource: t(
            `home.location_source_${locationSource === 'browser' ? 'current' : 'profile'}`,
          ),
        })}
      />
    );
  }

  return (
    <EmptyState
      heading={t('home.nothing_here_heading')}
      message={t('home.no_domain_listings', { domain: domainLabel.toLowerCase() })}
    />
  );
}
