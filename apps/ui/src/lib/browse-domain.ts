import { domainsInteract, type NetworkInteractionActions } from '@/lib/browse-discover';

// ─── Which domain the list is scoped to (#644) ───────────────────────────────
//
// The "All" tab is gone (spec D8). It merged N independently-paged per-domain
// feeds client-side and then re-sorted the union by haversine distance,
// discarding the server's ranking while each card still showed the server's
// score. No correct merge order existed either: cosine scores from different
// domains' embeddings do not share a scale, concatenating buries the second
// domain, and `/discover` takes exactly one `item_domain` so a true global
// ranking was not available. Removing the tab deleted the wrong order and the
// unanswerable question together.
//
// Two consequences need explicit rules, which is what this module holds:
// something must replace All as the no-`?domain=` default, and the map's
// multi-selection has to collapse when the user switches to the list.

/**
 * The domain the list shows when the URL does not say (spec D19).
 *
 * A signed-in viewer is sent to the first domain their own domain can actually
 * interact with — a seeker lands on providers, not on a domain where every
 * card would hide its Connect button and the relevance anchor would be
 * refused. Invisible for a viewer with only one visible domain.
 *
 * `fromParam` is validated against `visibleDomains` rather than trusted: a
 * stale bookmark, or a `?domain=` naming a domain the interaction matrix hides,
 * must not fetch it.
 *
 * Returns `null` only when there are no visible domains at all — a transient
 * pre-network state, not "all domains".
 */
export function resolveDefaultDomain(input: {
  fromParam: string | null;
  visibleDomains: { id: string }[];
  viewerDomain: string | null;
  actions: NetworkInteractionActions;
}): string | null {
  const visibleIds = input.visibleDomains.map((d) => d.id);

  if (input.fromParam && visibleIds.includes(input.fromParam)) {
    return input.fromParam;
  }

  const viewerDomain = input.viewerDomain;
  if (viewerDomain) {
    const interacting = visibleIds.find((id) => domainsInteract(input.actions, viewerDomain, id));
    if (interacting) return interacting;
  }

  return visibleIds[0] ?? null;
}

/**
 * Map → list transition (spec D27). The map allows several domains at once
 * (one `/markers` request each), but the list is one `/discover` call and that
 * takes exactly one `item_domain` — so a multi-selection has to collapse.
 *
 * Keeps the first STILL-VISIBLE selection. Silent by design: the domain
 * control itself shows the result, which is the read-out's job, so a separate
 * notice would just be noise.
 */
export function collapseToSingleDomain(
  selected: string[],
  visibleDomains: { id: string }[],
): string | null {
  const visibleIds = visibleDomains.map((d) => d.id);
  return selected.find((id) => visibleIds.includes(id)) ?? visibleIds[0] ?? null;
}
