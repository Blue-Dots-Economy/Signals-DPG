import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import type { RJSFSchema } from '@rjsf/utils';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { DotCardConfig } from '@/engine/types';
import {
  resolveCardFields,
  formatCardValue,
  type CardRow,
} from './resolve-card-fields';
import { UriValue } from './uri-value';

export interface ItemCardProps {
  /** Item schema (drives field labels). May be absent for map markers. */
  schema?: RJSFSchema | null;
  data: Record<string, unknown>;
  /** Per-domain card config from network.json. */
  cardConfig?: DotCardConfig | null;
  /** Override the resolved title (e.g. the map marker label). */
  title?: string;
  /** Badge text under the title (e.g. "Practitioner"). */
  domainLabel?: string;
  /** Small location/precision line (e.g. "Exact location"). */
  precisionLabel?: string;
  /** Action buttons (Connect / See Match Score) rendered in the footer. */
  actions?: React.ReactNode;
  /** Optional node rendered top-right of the coloured header (e.g. a Share button). */
  headerAction?: React.ReactNode;
  /** When set, the avatar shows this image instead of the initials (e.g. a
   *  RubiX listing's favicon). */
  avatarImageUrl?: string;
  /** `popup` is the map marker card; `list` is the browse grid card. */
  variant?: 'popup' | 'list';
  className?: string;
  onClick?: () => void;
}

const HEADER_GRADIENT =
  'linear-gradient(135deg, var(--primary), color-mix(in srgb, var(--primary), white 32%))';

// Long text values (e.g. Description) are truncated to a preview length and
// expanded with an inline "Show more" toggle, so a long write-up doesn't make
// the card tall by default.
const LONG_VALUE_PREVIEW_CHARS = 140;

function FieldRow({ row, compact = false }: { row: CardRow; compact?: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(false);
  const formatted = formatCardValue(row.value, row.type);
  // A link row skips the "Show more" toggle: UriValue elides its own display
  // text and keeps the full value in the href + tooltip.
  const isLong = !row.isUri && formatted.length > LONG_VALUE_PREVIEW_CHARS;
  const display =
    isLong && !expanded
      ? `${formatted.slice(0, LONG_VALUE_PREVIEW_CHARS).trimEnd()}… `
      : formatted;

  return (
    <div
      className={cn(
        'flex items-start gap-3 text-sm',
        // Popup on mobile: tighter rows + smaller text so the card stays small.
        compact && 'gap-2 text-xs sm:gap-3 sm:text-sm'
      )}
    >
      <span
        className={cn(
          'shrink-0 font-medium text-muted-foreground',
          compact ? 'w-[80px] sm:w-[110px]' : 'w-[110px]'
        )}
      >
        {row.label}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 [overflow-wrap:anywhere]',
          row.isEmpty ? 'text-muted-foreground/60' : 'text-foreground'
        )}
      >
        {row.isUri ? <UriValue value={row.value} /> : display}
        {isLong && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            // z-10: stay above the whole-card activation button (see CardShell).
            className="relative z-10 font-medium text-primary hover:underline"
          >
            {expanded ? t('card.show_less', 'Show less') : t('card.show_more', 'Show more')}
          </button>
        )}
      </span>
    </div>
  );
}

type CardShellProps = Omit<React.ComponentPropsWithoutRef<'div'>, 'onClick'> & {
  /** Accessible name for the whole-card activation control. */
  heading: string;
  /** When given, the card gains a whole-card activation control. */
  onClick?: () => void;
};

/**
 * The card's outer element.
 *
 * Given an `onClick`, the whole card becomes activatable — but the outer
 * element itself stays a plain, non-interactive `div`. The affordance is a real
 * `<button>` stretched over the card as a *sibling* of the content, which is
 * the only shape that works here:
 *
 *  - a wrapping `<button>` is illegal, and `role="button"` on the outer div is
 *    the same defect in ARIA form — either one makes the card's own footer
 *    buttons and links focusable descendants of a button (axe
 *    `nested-interactive`, WCAG 4.1.2);
 *  - the stretched button has no focusable children of its own, and its
 *    `aria-label` is the card's title, so screen readers announce "Asha,
 *    button" rather than reading the whole record as one control name.
 *
 * The button paints above the card's static content (it is positioned, they are
 * not), so a click anywhere lands on it. The card's own controls sit above it
 * again via `relative z-10` — see the `z-10` sites in this file and in
 * `uri-value.tsx`; `isolate` on the card root keeps those layers local.
 *
 * Without an `onClick` nothing is rendered: no button, no role, no tab stop.
 */
function CardShell({
  heading,
  onClick,
  className,
  children,
  ...rest
}: Readonly<CardShellProps>) {
  if (!onClick) {
    return (
      <div className={className} {...rest}>
        {children}
      </div>
    );
  }

  return (
    <div className={className} {...rest}>
      <button
        type="button"
        onClick={onClick}
        aria-label={heading}
        // The card root clips overflow, so an outset focus ring would be cut
        // off; an inset one traces the same rounded card edge.
        className="absolute inset-0 cursor-pointer rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      />
      {children}
    </div>
  );
}

/**
 * Single card component shared by the map popup and the browse list. Default
 * fields (from the domain's network.json `card` block) render collapsed; a
 * "view more" accordion reveals the remaining schema fields. Connect / See
 * Match Score buttons are passed in via `actions` so each call site keeps its
 * own auth/profile gating.
 */
export function ItemCard({
  schema,
  data,
  cardConfig,
  title,
  domainLabel,
  precisionLabel,
  actions,
  headerAction,
  avatarImageUrl,
  variant = 'list',
  className,
  onClick,
}: Readonly<ItemCardProps>) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);

  const resolved = resolveCardFields(schema, data, cardConfig);
  const heading = title ?? resolved.title;
  const hasExtra = resolved.extraRows.length > 0;

  // Fields: default rows always, extra rows when expanded. On the DESKTOP popup
  // this region alone scrolls (the footer stays pinned). On mobile it does not
  // scroll on its own — the whole body wrapper scrolls instead (see below) so
  // the action buttons are always reachable.
  const fieldsBlock = (
    <div
      className={cn(
        'space-y-2 px-4 py-3',
        variant === 'popup' &&
          'space-y-1.5 px-3 py-2.5 sm:min-h-0 sm:flex-1 sm:space-y-2 sm:overflow-y-auto sm:px-4 sm:py-3'
      )}
    >
      {resolved.defaultRows.map((row) => (
        <FieldRow key={row.key} row={row} compact={variant === 'popup'} />
      ))}
      {open &&
        resolved.extraRows.map((row) => (
          <FieldRow key={row.key} row={row} compact={variant === 'popup'} />
        ))}
    </div>
  );

  // Footer: the "view more" toggle + action buttons. On a list card it is
  // pinned to the bottom (mt-auto) for equal-height rows. On the popup it is
  // pinned only on desktop (sm:mt-auto); on mobile it flows at the end of the
  // scrolling body so it can never be clipped when the fields expand.
  const footerBlock = (hasExtra || actions) ? (
    <div
      className={cn(
        // z-10: the footer's controls stay above the whole-card activation
        // button (see CardShell).
        'relative z-10 shrink-0 pt-1',
        variant === 'list' ? 'mt-auto' : 'sm:mt-auto'
      )}
    >
      {hasExtra && (
        <div className={cn('px-4 pb-1', variant === 'popup' && 'px-3 sm:px-4')}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
            className={cn(
              'flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-muted/40 py-2 text-[13px] font-semibold text-primary hover:bg-muted',
              variant === 'popup' && 'py-1.5 text-xs sm:py-2 sm:text-[13px]'
            )}
          >
            {open
              ? t('card.hide_details', 'Hide details')
              : t('card.view_more', 'View more details')}
            <ChevronDown
              className={cn(
                'h-4 w-4 transition-transform',
                open && 'rotate-180'
              )}
            />
          </button>
        </div>
      )}

      {/* Action buttons — supplied by the caller. justify-between spreads
          natural-width list buttons to the edges; the popup's buttons use
          flex-1 so they fill instead. */}
      {actions && (
        <div
          className={cn(
            'flex flex-wrap items-center justify-between gap-2 px-4 pb-4 pt-2',
            variant === 'popup' &&
              'gap-1.5 px-3 pb-3 pt-1.5 sm:gap-2 sm:px-4 sm:pb-4 sm:pt-2'
          )}
        >
          {actions}
        </div>
      )}
    </div>
  ) : null;

  return (
    <CardShell
      heading={heading}
      data-item-card={variant === 'list' ? '' : undefined}
      data-expanded={variant === 'list' ? open : undefined}
      className={cn(
        // `relative`: the containing block for CardShell's stretched button.
        // `isolate`: keeps the card's z-10 controls layered against that button
        // and nothing outside the card.
        'relative isolate flex flex-col overflow-hidden rounded-2xl bg-background text-foreground shadow-sm',
        // Map popup: bound BOTH dimensions so the card always fits the screen.
        //  - width: a fixed 28rem (wide enough for the three action buttons on
        //    one row, and so fewer field values wrap → a shorter card), capped
        //    at 90vw so it never exceeds a phone viewport. Being a definite
        //    width, long field values wrap to the next line rather than widening
        //    the card.
        //  - width: a small 17rem on mobile (≤ 86vw) so the card leaves room to
        //    pan the map; a roomier 28rem on desktop.
        //  - height: on mobile a compact 56dvh so an opened card never fills the
        //    screen; the whole body scrolls within it. On desktop ≤ 28rem (and
        //    ≤ 60dvh on short screens) with the footer pinned.
        variant === 'popup' &&
          'w-[min(17rem,86vw)] max-h-[56dvh] sm:w-[min(28rem,90vw)] sm:max-h-[min(60dvh,28rem)]',
        variant === 'list' &&
          'transition hover:shadow-md motion-safe:hover:-translate-y-0.5',
        className
      )}
      onClick={onClick}
    >
      {/* Branded header — colour is the per-network theme var */}
      <div
        className="flex shrink-0 items-center gap-2.5 px-3 py-2 sm:gap-3 sm:px-4 sm:py-3"
        style={{ background: HEADER_GRADIENT }}
      >
        <div
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-bold text-white sm:h-11 sm:w-11 sm:text-sm',
            avatarImageUrl ? 'bg-white' : 'bg-white/25'
          )}
        >
          {avatarImageUrl ? (
            <img src={avatarImageUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            resolved.initials
          )}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold leading-tight text-white sm:text-[15px]">
            {heading}
          </p>
          {domainLabel && (
            <Badge className="mt-1 border-0 bg-white/25 px-1.5 py-0 text-[10px] font-semibold text-white hover:bg-white/25">
              {domainLabel}
            </Badge>
          )}
          {precisionLabel && (
            <p className="mt-1 text-[10px] leading-none text-white/85">
              {precisionLabel}
            </p>
          )}
        </div>
        {/* z-10: stays above the whole-card activation button (see CardShell). */}
        {headerAction && <div className="relative z-10 ml-auto shrink-0">{headerAction}</div>}
      </div>

      {/* Body. Popup on mobile: fields + footer share ONE scroll area, so the
          action buttons are always reachable (even after "view more" expands
          the fields). Popup on desktop (sm+): the body itself doesn't scroll —
          the fields region scrolls internally and the footer stays pinned
          (unchanged). List: fields followed by the bottom-pinned footer. */}
      {variant === 'popup' ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto sm:overflow-hidden">
          {fieldsBlock}
          {footerBlock}
        </div>
      ) : (
        <>
          {fieldsBlock}
          {footerBlock}
        </>
      )}
    </CardShell>
  );
}
