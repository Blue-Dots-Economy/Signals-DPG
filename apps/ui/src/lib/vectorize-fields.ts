import type { RJSFSchema } from '@rjsf/utils';

export interface VectorizeField {
  /** Property name in `item_state`. */
  name: string;
  /** The schema's own title, or the property name when it has none. */
  label: string;
  /** `vector_weight` from the schema; 1 when unset, matching the ingest default. */
  weight: number;
}

/**
 * The `vectorize: true` properties of an item schema, with their
 * `vector_weight` (#646 C4).
 *
 * These are exactly the fields signals-search serializes into the embedding it
 * ranks on (`serializeItemText` repeats each line `vector_weight` times at
 * ingest), so listing them is an honest answer to "what feeds this relevance
 * number?".
 *
 * It is NOT an answer to "how much did each field contribute" — see
 * `RelevanceExplanation` for why that question has no answer.
 *
 * Sorted by weight descending so the heaviest contributors read first; ties
 * keep schema order, which is the author's own intended reading order.
 */
export function vectorizeFieldsOf(schema: RJSFSchema | undefined): VectorizeField[] {
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') return [];

  const out: VectorizeField[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    if (!raw || typeof raw !== 'object') continue;
    const prop = raw as Record<string, unknown>;
    if (prop.vectorize !== true) continue;

    const weight = typeof prop.vector_weight === 'number' ? prop.vector_weight : 1;
    const label = typeof prop.title === 'string' && prop.title ? prop.title : name;
    out.push({ name, label, weight });
  }

  // Stable: Array.prototype.sort is stable in modern engines, so equal weights
  // retain the schema's declaration order.
  return out.sort((a, b) => b.weight - a.weight);
}

/**
 * The viewer's and the item's values for one vectorized field, as display
 * strings.
 *
 * Deliberately dumb: it compares attributes, it does NOT decompose the score.
 * Arrays are joined and objects are dropped rather than stringified, because
 * `[object Object]` in an explanation panel is worse than an omission.
 */
export function readFieldValue(
  state: Record<string, unknown> | undefined,
  name: string,
): string | null {
  const value = state?.[name];
  if (value == null) return null;
  if (Array.isArray(value)) {
    const parts = value.filter((v) => typeof v === 'string' || typeof v === 'number');
    return parts.length > 0 ? parts.join(', ') : null;
  }
  if (typeof value === 'string') return value || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}
