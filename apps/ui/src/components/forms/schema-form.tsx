import * as React from 'react';
import Form from '@rjsf/shadcn';
import validator from '@rjsf/validator-ajv8';
import { useTranslation } from 'react-i18next';
import type {
  RJSFSchema,
  UiSchema,
  RegistryWidgetsType,
  ObjectFieldTemplateProps,
  RJSFValidationError,
} from '@rjsf/utils';
import { applyUriPatterns, collectUriFieldKeys, URI_FIELD_MARKER } from '@dpg/schemas/uri_fields';
import { DatePickerWidget } from './custom-widgets/date-picker-widget';
import { LocationAutocompleteWidget } from './custom-widgets/location-autocomplete-widget';
import { MultiLocationAutocompleteWidget } from './custom-widgets/multi-location-autocomplete-widget';
import { ReferenceAutocompleteWidget } from './custom-widgets/reference-autocomplete-widget';
import { ClearableSelectWidget } from './custom-widgets/clearable-select-widget';
import CustomFieldTemplate from './custom-field-template';
import { resolveFormLayout, type FormLayout } from '@/theme/form-layouts';
import { resolveVisibleSchema } from '@/lib/show-if';
import { filterErrorSchemaToVisited } from './field-error-visibility';
import { FIELD_ERROR_MESSAGE_MARKER, resolvePatternErrorMessage } from './field-error-message';
import { cn } from '@/lib/utils';

interface RjsfError {
  property?: string;
  name?: string;
  params?: { missingProperty?: string };
}

/**
 * Map an RJSF validation error to the DOM id RJSF assigns the offending field.
 * RJSF defaults to idPrefix "root" + idSeparator "_", so a property like
 * ".trip_window_start" becomes "root_trip_window_start" and ".items.0.name"
 * becomes "root_items_0_name". (RJSF v6 already points `property` at the field
 * for `required` errors, so no special-casing is needed.)
 */
function fieldIdFromError(error: RjsfError): string {
  const segments = (error.property ?? '')
    .replace(/\[(\w+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  return ['root', ...segments].join('_');
}

/**
 * `focusOnFirstError` handler: on a blocked submit RJSF passes us the first
 * error; we smooth-scroll its field to the centre of the viewport and focus it,
 * so the user is taken to the problem instead of nothing happening. Resolution
 * mirrors RJSF's own (exact id, then a prefix match) because some shadcn widgets
 * put the field id on a wrapping button rather than a native input.
 */
function focusErrorField(container: HTMLElement | null, error: RjsfError): void {
  if (!container) return;
  const elementId = fieldIdFromError(error);
  const form = container.querySelector('form');

  // Resolve like RJSF does: the form's elements collection matches by id OR
  // name, with a prefix fallback for widgets (e.g. shadcn radios/selects) that
  // put the id on a wrapping button rather than a native input.
  const named = form?.elements.namedItem(elementId) ?? null;
  let candidate: Element | null =
    named instanceof RadioNodeList ? (named.item(0) as Element | null) : named;
  if (!candidate) {
    try {
      candidate = container.querySelector(`#${CSS.escape(elementId)}`);
    } catch {
      candidate = null;
    }
  }
  if (!candidate) {
    candidate = container.querySelector(
      `input[id^="${elementId}"], button[id^="${elementId}"], [id^="${elementId}"]`
    );
  }
  if (!(candidate instanceof HTMLElement)) return;
  const field = candidate;

  field.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const focusable = field.matches('input, select, textarea, button, [tabindex]')
    ? field
    : field.querySelector<HTMLElement>('input, select, textarea, button, [tabindex]');
  (focusable ?? field).focus({ preventScroll: true });
}

interface SchemaFormProps {
  schema: RJSFSchema;
  /**
   * Initial form values. MUST be referentially stable (e.g. React state or a
   * memoized object) — the controlled form re-seeds its internal state whenever
   * this prop's identity changes, so an inline object literal would discard the
   * user's edits on every render.
   */
  formData?: Record<string, unknown>;
  onSubmit: (data: Record<string, unknown>) => void;
  onError?: (errors: unknown[]) => void;
  mode?: 'full' | 'compact';
  disabled?: boolean;
  className?: string;
  submitButtonText?: string;
  id?: string;
  hideSubmit?: boolean;
  /**
   * Called with the AJV validity of the current form data whenever data changes
   * and once on mount. Only computed when this prop is provided.
   */
  /** `detail` says WHY it is invalid; the boolean stays first for existing callers. */
  onValidityChange?: (isValid: boolean, detail?: SchemaFormValidity) => void;
  domainId?: string;
  /**
   * Network id, used with domainId to resolve the section layout. Domain ids
   * (seeker/provider) collide across networks, so the layout is keyed on
   * `${networkId}:${domainId}` — see resolveFormLayout.
   */
  networkId?: string;
  formContext?: Record<string, unknown>;
  /**
   * Heading level for section titles (default 3). The profile form passes 2
   * because its page heading is the hero <h1>, so sections must be <h2> to avoid
   * a heading-level skip; action-modal keeps the default <h3> under its <h2>
   * dialog title.
   */
  sectionHeadingLevel?: 2 | 3;
}

// Root-only ObjectFieldTemplate that renders section headers + two-column grid.
// For nested objects (non-root) it falls back to the default RJSF column layout.
function SectionedObjectFieldTemplate(
  layout: FormLayout | undefined,
  headingLevel: 2 | 3 = 3,
) {
  const SectionHeading = headingLevel === 2 ? 'h2' : 'h3';
  return function ObjectFieldTemplate(props: ObjectFieldTemplateProps) {
    if (!layout) {
      // No layout config — render properties in a simple column
      return (
        <div className="space-y-4">
          {props.properties.map((element) => (
            <div key={element.name}>{element.content}</div>
          ))}
        </div>
      );
    }

    // Build a lookup of name → element
    const elementMap = new Map(props.properties.map((el) => [el.name, el]));
    const rendered = new Set<string>();

    // Track which section is being rendered so we can number them and show
    // the divider only between sections (not above the first one).
    let visibleSectionIndex = 0;

    return (
      <div className="space-y-10">
        {layout.sections.map((section) => {
          const sectionElements = section.fields
            .map((f) => elementMap.get(f))
            .filter((el): el is NonNullable<typeof el> => !!el);

          if (sectionElements.length === 0) return null;

          // Group into rows: pairs from twoColumn list go side-by-side, rest go full-width
          const rows: Array<typeof sectionElements> = [];
          let i = 0;
          while (i < sectionElements.length) {
            const curr = sectionElements[i];
            const next = sectionElements[i + 1];
            const currIsTwo = layout.twoColumn.includes(curr.name);
            const nextIsTwo = next && layout.twoColumn.includes(next.name);
            if (currIsTwo && nextIsTwo) {
              rows.push([curr, next]);
              i += 2;
            } else {
              rows.push([curr]);
              i += 1;
            }
            rendered.add(curr.name);
            if (next && currIsTwo && nextIsTwo) rendered.add(next.name);
          }

          const sectionNum = ++visibleSectionIndex;

          return (
            <section key={section.title}>
              {/* Section header: numbered badge + title + accent bar + divider line below */}
              <div className="mb-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-bold text-primary">
                    {sectionNum}
                  </div>
                  <SectionHeading className="text-base font-semibold text-foreground tracking-tight">{section.title}</SectionHeading>
                </div>
                <div className="mt-3 h-px bg-gradient-to-r from-border via-border/60 to-transparent" />
              </div>
              <div className="space-y-3">
                {rows.map((row, ri) =>
                  row.length === 2 ? (
                    <div key={ri} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {row.map((el) => <div key={el.name}>{el.content}</div>)}
                    </div>
                  ) : (
                    <div key={ri}>{row[0].content}</div>
                  )
                )}
              </div>
            </section>
          );
        })}

        {/* Render any fields not covered by sections */}
        {props.properties
          .filter((el) => !rendered.has(el.name))
          .map((el) => (
            <div key={el.name}>{el.content}</div>
          ))}
      </div>
    );
  };
}

// Walks a local JSON pointer like "#/$defs/support_category" against the
// root schema. Returns the referenced subschema or undefined if not found.
function resolveLocalRef(schema: RJSFSchema, ref: string): RJSFSchema | undefined {
  if (!ref.startsWith('#/')) return undefined;
  const parts = ref.slice(2).split('/');
  let curr: unknown = schema;
  for (const p of parts) {
    if (curr && typeof curr === 'object' && p in (curr as Record<string, unknown>)) {
      curr = (curr as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return curr as RJSFSchema;
}

function generateUiSchema(
  schema: RJSFSchema,
  mode: 'full' | 'compact',
  submitButtonText?: string
): UiSchema {
  const uiSchema: Record<string, unknown> = {};

  // Suppress the JSON-Schema-supplied root title/description. Surrounding
  // page chrome (CardTitle / CardDescription) already announces the form;
  // the inline duplicate adds noise. Section headers come from SectionedObjectFieldTemplate.
  uiSchema['ui:title'] = '';
  uiSchema['ui:description'] = '';

  uiSchema['ui:submitButtonOptions'] = {
    ...(submitButtonText ? { submitText: submitButtonText } : {}),
    props: {
      className: 'mt-8 h-12 w-full text-base font-semibold bg-brand-cta hover:brightness-110 transition-all active:scale-95 shadow-md',
    },
  };

  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const typed = prop as RJSFSchema & {
      private?: boolean;
      format?: string;
      [URI_FIELD_MARKER]?: unknown;
    };

    if (mode === 'compact' && typed.private === true) {
      uiSchema[key] = { 'ui:widget': 'hidden' };
      continue;
    }

    if (typed.format === 'date') {
      uiSchema[key] = { 'ui:widget': 'date' };
    }

    if (typed.format === 'email') {
      uiSchema[key] = { 'ui:placeholder': 'email@example.com' };
    }

    // A link field (network.json `x-uri`) gets a sample URL as its prompt, so
    // the expected shape is visible before the user types. Merged (not assigned)
    // because earlier blocks in this loop may already have written this key.
    if (typed[URI_FIELD_MARKER] === true) {
      uiSchema[key] = { ...(uiSchema[key] as object), 'ui:placeholder': 'https://example.com' };
    }

    if (typed.enum && typed.type === 'string') {
      uiSchema[key] = { 'ui:placeholder': 'Select...' };
    }

    // Render array-of-enums as a single multi-select (FancyMultiSelect:
    // Popover + cmdk Command + Badge chips) instead of RJSF's default stack
    // of single-selects with up/down/delete buttons per index.
    if (typed.type === 'array' && typed.items) {
      const items = typed.items as RJSFSchema & { $ref?: string };
      let itemEnum = items.enum;
      if (!itemEnum && items.$ref) {
        itemEnum = resolveLocalRef(schema, items.$ref)?.enum;
      }
      if (itemEnum && itemEnum.length > 0) {
        uiSchema[key] = {
          ...(uiSchema[key] as object),
          'ui:widget': 'select',
          'ui:placeholder': 'Select...',
        };
      }
    }

    // A field-level `placeholder` on the schema (network.json) wins over the
    // generic defaults above ('Select...', email sample) so each field can
    // carry its own prompt text.
    const fieldPlaceholder = (typed as { placeholder?: unknown }).placeholder;
    if (typeof fieldPlaceholder === 'string' && fieldPlaceholder.length > 0) {
      uiSchema[key] = {
        ...(uiSchema[key] as object),
        'ui:placeholder': fieldPlaceholder,
      };
    }

    // External reference vocabulary (network.json `x-reference-source`): render
    // an autocomplete backed by a reference dataset instead of an inline enum,
    // so large lists (colleges/institutes/trades) stay out of the schema. The
    // marker is either a bare `"source"` string or `{ source, subtitle }`, where
    // `subtitle` is the ordered option fields shown under each result.
    const referenceMarker = (typed as { 'x-reference-source'?: unknown })['x-reference-source'];
    let referenceSource: string | undefined;
    let subtitleFields: string[] | undefined;
    if (typeof referenceMarker === 'string') {
      referenceSource = referenceMarker;
    } else if (referenceMarker && typeof referenceMarker === 'object') {
      const m = referenceMarker as { source?: unknown; subtitle?: unknown };
      if (typeof m.source === 'string') referenceSource = m.source;
      if (Array.isArray(m.subtitle)) {
        subtitleFields = m.subtitle.filter((s): s is string => typeof s === 'string');
      }
    }
    if (referenceSource && referenceSource.length > 0) {
      const existing = (uiSchema[key] as Record<string, unknown>) ?? {};
      const existingOptions = (existing['ui:options'] as Record<string, unknown>) ?? {};
      uiSchema[key] = {
        ...existing,
        'ui:widget': 'reference-autocomplete',
        'ui:options': {
          ...existingOptions,
          source: referenceSource,
          ...(subtitleFields ? { subtitleFields } : {}),
        },
      };
    }

    const locationRole = (typed as { location?: unknown }).location;
    if (locationRole === 'primary' || locationRole === 'secondary') {
      const isArray = typed.type === 'array';
      const existing = (uiSchema[key] as Record<string, unknown>) ?? {};
      const existingOptions = (existing['ui:options'] as Record<string, unknown>) ?? {};
      uiSchema[key] = {
        ...existing,
        'ui:widget': isArray ? 'location-multi' : 'location-autocomplete',
        // Only the primary field's picked coordinate feeds item_locations;
        // secondary fields are autocomplete-only.
        'ui:options': { ...existingOptions, isPrimaryLocation: locationRole === 'primary' },
      };
    }
  }

  return uiSchema;
}

const widgets: RegistryWidgetsType = {
  date: DatePickerWidget,
  'location-autocomplete': LocationAutocompleteWidget,
  'location-multi': MultiLocationAutocompleteWidget,
  'reference-autocomplete': ReferenceAutocompleteWidget,
  // Overrides the theme's own `SelectWidget` by name — every enum field routes
  // through this one, which is the theme's select plus a clear button for
  // optional fields (see the widget's own comment).
  SelectWidget: ClearableSelectWidget,
};

function stripMetaSchema(schema: RJSFSchema): RJSFSchema {
  const { $schema, ...rest } = schema as RJSFSchema & { $schema?: string };
  return rest as RJSFSchema;
}

// Walks the schema tree, replacing local `{ $ref: "#/..." }` nodes with the
// referenced subschema and ensuring array-of-enum fields have `uniqueItems:
// true`. RJSF's `multiple=true` (which routes SelectWidget to FancyMultiSelect)
// requires the items enum to be visible at the field level AND uniqueItems
// set — without these, an `ui:widget: 'select'` array renders as a non-functional
// single-select with no options.
function normalizeSchemaForRjsf(schema: RJSFSchema, rootSchema?: RJSFSchema): RJSFSchema {
  const root = rootSchema ?? schema;
  if (typeof schema !== 'object' || schema === null) return schema;
  if (Array.isArray(schema)) {
    return (schema as unknown[]).map((s) => normalizeSchemaForRjsf(s as RJSFSchema, root)) as unknown as RJSFSchema;
  }

  const schemaAny = schema as RJSFSchema & { $ref?: string };
  if (typeof schemaAny.$ref === 'string' && schemaAny.$ref.startsWith('#/')) {
    const resolved = resolveLocalRef(root, schemaAny.$ref);
    if (resolved) {
      const { $ref: _, ...rest } = schemaAny;
      return normalizeSchemaForRjsf({ ...resolved, ...rest } as RJSFSchema, root);
    }
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    // Strip the custom `location` MARKER (value "primary" | "secondary"), which is consumed
    // by generateUiSchema, not real JSON Schema. Must NOT strip a property whose
    // NAME is "location" (its value is the field's schema object, not a string).
    if (key === 'location' && (value === 'primary' || value === 'secondary')) continue;
    // Strip the custom `x-show-if` keyword — consumed by resolveVisibleSchema before
    // this point; ajv must never see it.
    if (key === 'x-show-if') continue;
    // Strip the custom `x-form-layout` keyword — consumed by the section
    // renderer (read off the raw schema); ajv/RJSF must never see it.
    if (key === 'x-form-layout') continue;
    // Strip the custom field-level `placeholder` keyword (string value) — it's
    // mapped to `ui:placeholder` by generateUiSchema, so ajv must not see it.
    // The `typeof string` guard avoids stripping a property NAMED "placeholder".
    if (key === 'placeholder' && typeof value === 'string') continue;
    // Strip the custom `x-reference-source` marker (string or `{source,subtitle}`
    // object) — it's mapped to the reference-autocomplete widget by
    // generateUiSchema, so ajv must not see it.
    if (key === 'x-reference-source') continue;
    // Strip the custom `x-error-message` keyword (per-field copy for a failed
    // `pattern`, consumed when building the error message) — ajv must not see it.
    if (key === FIELD_ERROR_MESSAGE_MARKER) continue;
    // Strip the custom `x-uri` marker — its effect is the `pattern` injected by
    // applyUriPatterns before this point, plus the card-side link rendering.
    // (RJSF's ajv runs strict:false so an unknown keyword would be tolerated,
    // but every other custom marker is stripped here; keep it consistent.)
    if (key === URI_FIELD_MARKER) continue;
    result[key] = normalizeSchemaForRjsf(value as RJSFSchema, root);
  }

  // After children are normalized, force uniqueItems on array-of-enum fields.
  const normalized = result as RJSFSchema & { type?: string; items?: RJSFSchema; uniqueItems?: boolean };
  if (
    normalized.type === 'array' &&
    normalized.items &&
    typeof normalized.items === 'object' &&
    Array.isArray((normalized.items as RJSFSchema).enum) &&
    normalized.uniqueItems !== true
  ) {
    normalized.uniqueItems = true;
  }

  return normalized as RJSFSchema;
}

/**
 * Pure helper for AJV-backed validity checking. Extracted so it can be
 * unit-tested deterministically without mounting the full form.
 */
export function isSchemaFormValid(
  v: typeof validator,
  schema: RJSFSchema,
  data: Record<string, unknown>,
): boolean {
  return v.isValid(schema, data, schema);
}

/** Why a form is invalid, so callers can say which of the two it is. */
export interface SchemaFormValidity {
  valid: boolean;
  /** Required fields the user has not filled in. */
  missingRequired: number;
  /** Fields that hold a value which breaks its own rule (pattern, format, …). */
  invalidValues: number;
}

/** Resolve an RJSF error `property` (".a", ".a.0") against the form data. */
function valueAtProperty(data: Record<string, unknown>, property: string | undefined): unknown {
  if (!property) return undefined;
  const segments = property.replace(/\[(\w+)\]/g, '.$1').split('.').filter(Boolean);
  let cursor: unknown = data;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Classify a form's AJV errors into "you have not filled this in" versus "what
 * you typed is not valid". A single boolean cannot tell those apart, and the two
 * need different copy — telling someone to "fill in all the required fields"
 * when the field IS filled (just malformed) sends them looking in the wrong
 * place. A blank-but-present value counts as missing rather than invalid: it
 * trips `minLength` in AJV terms, but to the user it is simply not filled in.
 */
export function getSchemaFormValidity(
  v: typeof validator,
  schema: RJSFSchema,
  data: Record<string, unknown>,
): SchemaFormValidity {
  const { errors } = v.validateFormData(data, schema);
  let missingRequired = 0;
  let invalidValues = 0;
  for (const error of errors) {
    const blank = isBlank(valueAtProperty(data, error.property));
    if (error.name === 'required' || blank) missingRequired += 1;
    else invalidValues += 1;
  }
  return { valid: errors.length === 0, missingRequired, invalidValues };
}



export function SchemaForm({
  schema,
  formData,
  onSubmit,
  onError,
  mode = 'full',
  disabled = false,
  className,
  submitButtonText,
  id,
  hideSubmit = false,
  onValidityChange,
  domainId,
  networkId,
  formContext,
  sectionHeadingLevel = 3,
}: Readonly<SchemaFormProps>) {
  const { t } = useTranslation();

  // Base schema (meta stripped) still carries `x-show-if` so the evaluator can read it.
  const baseSchema = React.useMemo(() => stripMetaSchema(schema), [schema]);

  // Controlled form data. Seeded from the prop, with hidden values pre-cleared so
  // an edit-mode load whose stored control no longer matches starts clean.
  const [data, setData] = React.useState<Record<string, unknown>>(
    () => resolveVisibleSchema(baseSchema, formData ?? {}).formData,
  );

  // Re-seed when the incoming formData identity changes (edit mode loads async).
  // Parents pass a stable formData identity except on (re)load, so this does not
  // fire while the user is typing.
  React.useEffect(() => {
    setData(resolveVisibleSchema(baseSchema, formData ?? {}).formData);
  }, [baseSchema, formData]);

  const resolved = resolveVisibleSchema(baseSchema, data);
  // Signature of the visible set. The normalized schema + uiSchema are memoized on
  // this so their object identity is stable while the visible set is unchanged —
  // otherwise RJSF remounts fields and text inputs lose focus on every keystroke.
  const hiddenKey = resolved.hidden.join('|');

  const rjsfSchema = React.useMemo(
    // applyUriPatterns FIRST: it injects `pattern` for `x-uri` fields, then
    // normalizeSchemaForRjsf strips the marker so ajv only sees the pattern.
    () => normalizeSchemaForRjsf(applyUriPatterns(resolved.schema)),
    // resolved.schema depends only on (schema, visible set); key on hiddenKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schema, hiddenKey],
  );

  const uiSchema = React.useMemo(() => {
    const ui = generateUiSchema(resolved.schema, mode, hideSubmit ? undefined : submitButtonText);
    if (hideSubmit) ui['ui:submitButtonOptions'] = { norender: true };
    return ui;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, hiddenKey, mode, hideSubmit, submitButtonText]);

  // ajv reports a pattern failure as `must match pattern "^\s*$|^\s*(https?..."`,
  // which is meaningless to a user. Rewrite it for `x-uri` fields only.
  const uriFieldKeys = React.useMemo(() => new Set(collectUriFieldKeys(baseSchema)), [baseSchema]);

  /**
   * Readable copy for a failed `pattern`. AJV's own message is the raw regex, so
   * it must never reach the user; the regex comes from network.json, so the copy
   * is resolved from the field too (authored `x-error-message`, else the `x-uri`
   * default, else a generic naming the field). Shared by both error paths below —
   * `extraErrors` bypasses `transformErrors` entirely, so each needs it.
   */
  const patternMessageFor = React.useCallback(
    (property: string): string => {
      const properties = (baseSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
      return resolvePatternErrorMessage(properties[property], uriFieldKeys.has(property), {
        uri: t('form.invalid_url', 'Enter a valid link, e.g. https://example.com'),
        generic: (label) => t('form.invalid_format', 'Please enter a valid {{field}}.', { field: label }),
      });
    },
    [baseSchema, uriFieldKeys, t],
  );

  const transformErrors = React.useCallback(
    (errors: RJSFValidationError[]) =>
      errors.map((error) => {
        if (error.name !== 'pattern') return error;
        const field = (error.property ?? '').replace(/^\./, '').split('.')[0];
        const message = patternMessageFor(field);
        // `stack` is what RJSF's ErrorList template renders, so it has to be
        // rewritten too — otherwise flipping `showErrorList` on would put the
        // raw pattern back in front of the user.
        return { ...error, message, stack: `${error.property} ${message}` };
      }),
    [patternMessageFor],
  );

  // Keep a ref to the latest onValidityChange so the validity effect below does
  // not depend on the callback's identity. This prevents a render loop when a
  // consumer passes an unstable function reference (e.g. an inline arrow).
  const onValidityChangeRef = React.useRef(onValidityChange);
  React.useEffect(() => {
    onValidityChangeRef.current = onValidityChange;
  });

  // Report AJV validity to the consumer once on mount and whenever data or schema
  // changes. Depends only on [rjsfSchema, data] — not on the callback ref — so it
  // never re-fires due to an unstable callback identity. The second argument says
  // WHY it is invalid; the boolean stays first so existing callers are unaffected.
  React.useEffect(() => {
    const cb = onValidityChangeRef.current;
    if (!cb) return;
    const detail = getSchemaFormValidity(validator, rjsfSchema, data);
    cb(detail.valid, detail);
  }, [rjsfSchema, data]);

  // Which fields the user has actually visited, by RJSF field id ("root_phone").
  // Only these fields' errors are handed to RJSF (see `extraErrors` below), so an
  // untouched field is never told it is invalid and nothing renders it red.
  const [touchedFieldIds, setTouchedFieldIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [submitAttempted, setSubmitAttempted] = React.useState(false);

  const markTouched = React.useCallback((fieldId: string) => {
    setTouchedFieldIds((prev) => {
      if (prev.has(fieldId)) return prev;
      const next = new Set(prev);
      next.add(fieldId);
      return next;
    });
  }, []);

  // Re-arm on a schema swap (edit-mode load, or a different domain's form) so
  // one form's touched set never suppresses or leaks into another's.
  React.useEffect(() => {
    setTouchedFieldIds(new Set());
    setSubmitAttempted(false);
  }, [schema]);

  // Display errors, fed to RJSF as `extraErrors`. `liveValidate` is deliberately
  // OFF: it hands an error to every invalid field at once, and the theme's own
  // input/select templates redden their borders straight off `rawErrors`, so a
  // pristine form lit up as soon as anything was typed. Supplying only the
  // visited fields' errors means an untouched field never receives one, so every
  // renderer stays quiet without knowing about the rule. RJSF still validates
  // natively on submit, so this cannot let invalid data through.
  const extraErrors = React.useMemo(() => {
    // Rewrite pattern messages BEFORE filtering: `extraErrors` never passes
    // through `transformErrors`, so without this the raw regex is what renders.
    const { errors, errorSchema } = validator.validateFormData(data, rjsfSchema);
    const patternFields = new Set(
      errors
        .filter((error) => error.name === 'pattern')
        .map((error) => (error.property ?? '').replace(/^\./, '').split('.')[0])
        .filter(Boolean),
    );
    const readable: Record<string, unknown> = { ...errorSchema };
    for (const property of patternFields) {
      readable[property] = { __errors: [patternMessageFor(property)] };
    }
    return filterErrorSchemaToVisited(readable as typeof errorSchema, touchedFieldIds, submitAttempted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rjsfSchema, data, touchedFieldIds, submitAttempted, patternMessageFor]);

  // Section layout is schema-driven first: an `x-form-layout` block on the item
  // schema (network.json) is the single source of truth, so field add/remove/
  // reorder needs no code change. Falls back to the code-side `formLayouts` map
  // (keyed network:domain) for networks not yet migrated to x-form-layout.
  const activeLayout: FormLayout | undefined =
    (schema as { 'x-form-layout'?: FormLayout })['x-form-layout'] ??
    resolveFormLayout(networkId, domainId);

  // FieldTemplate applies to every form (red required marker). ObjectFieldTemplate
  // (section layout) is added only when a layout is resolved.
  const templates = {
    FieldTemplate: CustomFieldTemplate,
    ...(activeLayout
      ? { ObjectFieldTemplate: SectionedObjectFieldTemplate(activeLayout, sectionHeadingLevel) }
      : {}),
  };

  const containerRef = React.useRef<HTMLDivElement>(null);

  return (
    <div
      // Left-align enum/select triggers. `@rjsf/shadcn`'s `FancySelect` renders
      // its trigger as a `<button>`, and Tailwind's preflight does not reset the
      // UA `text-align: center` on buttons; its label span is `flex-1`, so it
      // spans the full trigger width and the value/"Select..." placeholder lands
      // dead-centre. Fixed here rather than in the vendored widget, and scoped to
      // the select trigger via `aria-haspopup=listbox` so no other button in the
      // form is affected. (Same fix as `filters/multi-select-group.tsx`, which
      // sets `text-left` on its own justify-between trigger.)
      className={cn('[&_button[aria-haspopup=listbox]]:text-left', className)}
      ref={containerRef}
    >
      <Form
        id={id}
        schema={rjsfSchema}
        uiSchema={uiSchema}
        formData={data}
        validator={validator}
        widgets={widgets}
        templates={templates}
        disabled={disabled}
        formContext={formContext}
        onChange={({ formData: next }) => {
          const nextData = resolveVisibleSchema(baseSchema, (next ?? {}) as Record<string, unknown>).formData;
          setData(nextData);
        }}
        onBlur={(fieldId) => markTouched(fieldId)}
        onSubmit={({ formData: submitted }) => {
          setSubmitAttempted(true);
          if (submitted) onSubmit(submitted as Record<string, unknown>);
        }}
        onError={(errors) => {
          setSubmitAttempted(true);
          onError?.(errors);
        }}
        transformErrors={transformErrors}
        focusOnFirstError={(error) =>
          focusErrorField(containerRef.current, error as RjsfError)
        }
        showErrorList={false}
        extraErrors={extraErrors}
        liveValidate={false}
        noHtml5Validate
        omitExtraData
        liveOmit
      />
    </div>
  );
}
