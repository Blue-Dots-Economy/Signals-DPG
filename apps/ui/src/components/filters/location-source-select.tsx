import { useTranslation } from 'react-i18next';
import { MapPin } from 'lucide-react';
import { OptionSelect } from './option-select';
import type { SelectOption } from './option-select';
import type { PreferredLocationSource } from '@/hooks/use-user-location';

export interface LocationSourceSelectProps {
  /** Which of the two sources is in force. */
  value: PreferredLocationSource;
  onChange: (next: PreferredLocationSource) => void;
  /** Whether each source can supply a coordinate at all. */
  profileAvailable: boolean;
  browserAvailable: boolean;
}

/**
 * The location-source half of `LocationSelect`, for the MAP.
 *
 * #644 (spec D26) took the whole `LocationSelect` off the map row, and it was
 * right about the half it was reasoning about: a radius there is inert
 * (`useMapMarkers` scopes by viewport, never by `area`) and contradictory if
 * wired up (a 5 km circle inside a 40 km viewport paints an empty map with
 * pins just off-screen). But the SOURCE half went with it, and that half is
 * not inert on the map — it decides where the map opens (`focusPoint`), where
 * the "You are here" marker sits (`selfLocation`), and, via `focusNonce`,
 * re-centres the map when it changes. So the map had no way to answer "show me
 * around my current position instead of my profile" at all.
 *
 * This is deliberately NOT a `variant` on `LocationSelect`. Everything that
 * component does beyond these two rows — the radius field, its validation, the
 * `usesCenter` gate, the viewport row — has no meaning here, so a variant
 * would be a second component sharing only a filename. What it shares that
 * matters (the trigger's exact shape, icon-only below `sm`, the ticked option
 * list, "listed but unavailable, with a reason") is `OptionSelect`, and that
 * is what both build on.
 *
 * Only the ROW is different, not the control: same `MapPin`, same position in
 * the toolbar, same words for the two sources as the list's switch.
 */
export function LocationSourceSelect({
  value,
  onChange,
  profileAvailable,
  browserAvailable,
}: Readonly<LocationSourceSelectProps>) {
  const { t } = useTranslation();

  const options: SelectOption<PreferredLocationSource>[] = [
    {
      value: 'profile',
      label: t('browse.location_from_profile'),
      available: profileAvailable,
      // `hint` on a choosable option, `reason` on an unavailable one —
      // OptionSelect shows one or the other, never both.
      hint: t('browse.location_profile_hint'),
      reason: t('browse.location_profile_unavailable'),
    },
    {
      value: 'browser',
      label: t('browse.location_from_browser'),
      available: browserAvailable,
      hint: t('browse.location_browser_hint'),
      reason: t('browse.location_browser_unavailable'),
    },
  ];

  return (
    <OptionSelect
      name={t('browse.location_label')}
      // Names the CENTRE, not a filter. On the list this trigger shows the
      // radius ("Within 5 km of my profile"); here there is no radius, so the
      // source itself is the value — and the heading says what choosing it
      // does, because "Location — My profile" on a map otherwise reads as a
      // constraint on which pins are shown. It is not one: the viewport is.
      heading={t('browse.location_map_centre')}
      displayLabel={
        value === 'browser'
          ? t('browse.location_from_browser')
          : t('browse.location_from_profile')
      }
      icon={MapPin}
      options={options}
      value={value}
      onChange={onChange}
    />
  );
}
