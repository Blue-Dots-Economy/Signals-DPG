import type { RJSFSchema } from '@rjsf/utils';
import type { DotNetworkDomain } from '@/engine/types';

/**
 * enum-filters.ts
 *
 * Generic helpers for deriving filter groups from JSON Schema enum fields.
 * Completely schema-driven — nothing is hardcoded to a specific network or
 * domain name. Works with any network that uses JSON Schema `enum` /
 * `type:"array" + items.enum` conventions.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EnumFilterField {
  /** Property name from the JSON Schema, e.g. "looking_for". */
  key: string;
  /**
   * Human-readable label. Prefers the schema property's `title`; falls back
   * to humanizing the key (snake_case / camelCase → Title Case).
   */
  label: string;
  /** All possible option values for this field (unioned across schemas). */
  options: string[];
  /**
   * `true` when the field is `type:"array"` with `items.enum` (multi-value
   * per item). `false` when it is a simple `enum` (single value per item).
   */
  isArray: boolean;
}

// ─── Humanization ─────────────────────────────────────────────────────────────

/**
 * Convert a snake_case or camelCase key to Title Case.
 * Examples: "looking_for" → "Looking For", "providerCategory" → "Provider Category"
 */
export function humanizeKey(key: string): string {
  // Split on underscores and camelCase boundaries
  return key
    .replaceAll(/_/g, ' ')
    .replaceAll(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Scan a single JSON Schema's `properties` for enum and array-of-enum fields.
 * Returns one `EnumFilterField` per matching property.
 *
 * Detection rules (generic — inspects JSON Schema `properties`):
 *   - `{ type: "string"|"number", enum: [...] }` → single-value enum (`isArray: false`)
 *   - `{ type: "array", items: { enum: [...] } }` → array-of-enum (`isArray: true`)
 *   - Any other shape is ignored.
 */
function extractEnumFields(schema: RJSFSchema): EnumFilterField[] {
  if (!schema.properties || typeof schema.properties !== 'object') return [];

  const fields: EnumFilterField[] = [];

  for (const [key, rawProp] of Object.entries(schema.properties)) {
    // JSON Schema properties can be boolean (true/false) when using additionalProperties
    if (typeof rawProp !== 'object' || rawProp === null) continue;
    const prop = rawProp as RJSFSchema & { private?: boolean };

    // Defense-in-depth (#203 Task 7, restated #394): never offer a
    // `private: true` field as a filter option, even though the server's
    // facet guard (`resolveAllowedFacetFields`) would silently drop any
    // filter request on one anyway. No currently-configured network schema
    // declares both `private: true` and `enum` on the same property
    // (verified across every `examples/schemas/*/network.json`), so this
    // doesn't change any network's filter options today — it just stops a
    // future schema edit from silently surfacing an inert-but-visible filter
    // for a private field. This is the ONLY gate now — #394 removed the
    // separate `filterable: true` marker that used to additionally restrict
    // the map's offered/sent facets; every declared, non-private enum field
    // is a filter again in both views. Proper schema-driven search/filter
    // declaration is tracked in #360.
    if (prop.private === true) continue;

    // Single-value enum: string or number property with a top-level `enum` array
    if (Array.isArray(prop.enum) && prop.enum.length > 0) {
      const options = prop.enum
        .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
        .map(String);
      if (options.length > 0) {
        fields.push({
          key,
          label: typeof prop.title === 'string' && prop.title.trim() ? prop.title.trim() : humanizeKey(key),
          options,
          isArray: false,
        });
      }
      continue;
    }

    // Array-of-enum: `type: "array"` with `items.enum`
    if (
      prop.type === 'array' &&
      prop.items !== null &&
      typeof prop.items === 'object' &&
      !Array.isArray(prop.items)
    ) {
      const items = prop.items as RJSFSchema;
      if (Array.isArray(items.enum) && items.enum.length > 0) {
        const options = items.enum
          .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
          .map(String);
        if (options.length > 0) {
          fields.push({
            key,
            label: typeof prop.title === 'string' && prop.title.trim() ? prop.title.trim() : humanizeKey(key),
            options,
            isArray: true,
          });
        }
      }
    }
  }

  return fields;
}

// ─── Multi-schema union ────────────────────────────────────────────────────────

/**
 * Derive enum filter fields from an array of JSON Schemas (e.g. all item_type
 * schemas from all visible domains).
 *
 * When the same `key` appears in multiple schemas:
 *   - The `label` from the first occurrence is used.
 *   - `options` are unioned (preserving first-seen order, deduped by value).
 *   - `isArray` from the first occurrence wins.
 *
 * Fields are returned in declaration order across schemas (first schema first).
 */
export function getEnumFilterFields(schemas: RJSFSchema[]): EnumFilterField[] {
  // Map from key → accumulated field (mutable during the loop)
  const byKey = new Map<
    string,
    { label: string; optionsSet: Set<string>; options: string[]; isArray: boolean }
  >();

  for (const schema of schemas) {
    for (const field of extractEnumFields(schema)) {
      const existing = byKey.get(field.key);
      if (!existing) {
        byKey.set(field.key, {
          label: field.label,
          optionsSet: new Set(field.options),
          options: [...field.options],
          isArray: field.isArray,
        });
      } else {
        // Union options, preserving insertion order, deduping by value
        for (const opt of field.options) {
          if (!existing.optionsSet.has(opt)) {
            existing.optionsSet.add(opt);
            existing.options.push(opt);
          }
        }
      }
    }
  }

  return Array.from(byKey.entries()).map(([key, { label, options, isArray }]) => ({
    key,
    label,
    options,
    isArray,
  }));
}

/**
 * Convenience helper: extract all item_schemas from the given visible domains,
 * then derive enum filter fields. Both the map and list views use this same
 * full set — every declared, non-private enum field is a filter in both
 * (#394 dropped the `filterable: true` gate that used to additionally
 * restrict what the map offered/sent; proper schema-driven search/filter
 * declaration is tracked in #360).
 */
export function getEnumFilterFieldsForDomains(domains: DotNetworkDomain[]): EnumFilterField[] {
  const schemas: RJSFSchema[] = [];
  for (const domain of domains) {
    if (domain.item_schemas) {
      for (const schema of Object.values(domain.item_schemas)) {
        schemas.push(schema);
      }
    }
    // Also check default_item_schemas for backwards-compat
    if (domain.default_item_schemas?.profile) {
      schemas.push(domain.default_item_schemas.profile);
    }
  }
  return getEnumFilterFields(schemas);
}

// ─── Filter application ───────────────────────────────────────────────────────

/**
 * Apply `selectedFields` (a map of fieldKey → selected values[]) to a single
 * item's data object.
 *
 * Semantics:
 *   - AND across different field keys (item must pass every active field filter).
 *   - OR within a single field's selected values (match ANY selected value).
 *   - If the item does NOT have the field in its data → the item PASSES this
 *     field check (domain-safe: a provider field won't kill seeker items).
 *   - If the field is present:
 *       • Single value: passes if the item's value is in the selected set.
 *       • Array value:  passes if the item's array intersects the selected set.
 *
 * @param data           - The item's data object (from `item.data`).
 * @param selectedFields - Map of fieldKey → non-empty selected value arrays.
 * @param enumFields     - The field metadata (used to know `isArray`).
 */
export function itemPassesEnumFilters(
  data: Record<string, unknown>,
  selectedFields: Record<string, string[]>,
  enumFields: EnumFilterField[],
): boolean {
  // Build a quick lookup from key → metadata
  const fieldMeta = new Map<string, EnumFilterField>();
  for (const f of enumFields) {
    fieldMeta.set(f.key, f);
  }

  for (const [key, selectedValues] of Object.entries(selectedFields)) {
    if (selectedValues.length === 0) continue; // no selection → don't filter

    // Absent field → passes (domain-safe)
    if (!(key in data)) continue;

    const itemValue = data[key];
    const meta = fieldMeta.get(key);
    const isArray = meta?.isArray ?? Array.isArray(itemValue);

    if (isArray) {
      // Array field: passes if any of the item's values is in the selected set
      if (!Array.isArray(itemValue)) {
        // Malformed data — treat the single value as a one-element array
        const strVal = String(itemValue);
        if (!selectedValues.includes(strVal)) return false;
      } else {
        const itemArr = (itemValue as unknown[]).map(String);
        const intersects = itemArr.some((v) => selectedValues.includes(v));
        if (!intersects) return false;
      }
    } else {
      // Single-value field: passes if the item's value is in the selected set
      const strVal = itemValue === null || itemValue === undefined ? '' : String(itemValue);
      if (!selectedValues.includes(strVal)) return false;
    }
  }

  return true;
}
