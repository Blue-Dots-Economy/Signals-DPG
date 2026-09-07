import * as React from 'react';
import { cn } from '@/lib/utils';
import { toSafeHref, URI_DISPLAY_MAX_CHARS } from '@/lib/uri-field';

/**
 * Renders the value of a field flagged `"x-uri": true` in network.json.
 *
 * Each linkable entry becomes an `<a>`; anything that is not safely linkable
 * (masked stub, non-http scheme, junk) falls back to the plain text it renders
 * today, so a bad value degrades instead of producing a dead link. Arrays
 * render one link per entry.
 */
export function UriValue({ value, className }: Readonly<{ value: unknown; className?: string }>) {
  const entries = (Array.isArray(value) ? value : [value])
    .filter((entry) => entry !== null && entry !== undefined)
    .map(String)
    .filter((entry) => entry.trim().length > 0);

  if (entries.length === 0) return <>—</>;

  return (
    <>
      {entries.map((entry, index) => (
        <React.Fragment key={`${entry}-${index}`}>
          {index > 0 && ', '}
          <UriEntry value={entry} className={className} />
        </React.Fragment>
      ))}
    </>
  );
}

function UriEntry({ value, className }: Readonly<{ value: string; className?: string }>) {
  const href = toSafeHref(value);
  if (!href) return <>{value}</>;

  // A URL needs no progressive disclosure, so unlike a long text field there is
  // no "Show more" toggle — the text is elided and the full value lives in the
  // href and the tooltip.
  const text =
    value.length > URI_DISPLAY_MAX_CHARS
      ? `${value.slice(0, URI_DISPLAY_MAX_CHARS).trimEnd()}…`
      : value;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={value}
      // List cards carry their own onClick; without this, following a link
      // would also trigger the card's click handler.
      onClick={(e) => e.stopPropagation()}
      // z-10: stay above the whole-card activation button ItemCard stretches
      // over a clickable card (see `CardShell` in item-card.tsx), which would
      // otherwise swallow the click on this link.
      className={cn(
        'relative z-10 font-medium text-primary underline underline-offset-2 hover:opacity-80',
        className
      )}
    >
      {text}
    </a>
  );
}
