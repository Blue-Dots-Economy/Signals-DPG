import type { RJSFSchema } from '@rjsf/utils';
import { setCachedSchema, getCachedSchema } from './schema-loader';

/**
 * Resolves a JSON Pointer (e.g., "#/definitions/student") within a root document.
 */
export function resolveJsonPointer(doc: unknown, pointer: string): unknown {
  if (!pointer.startsWith('#/')) {
    throw new Error(`Invalid JSON Pointer: ${pointer}`);
  }

  if (pointer === '#') return doc;

  const segments = pointer
    .slice(2)
    .split('/')
    .map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'));

  let current: unknown = doc;

  for (const segment of segments) {
    if (current === null || current === undefined) {
      throw new Error(`Cannot resolve pointer ${pointer}: null/undefined at segment "${segment}"`);
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new Error(`Invalid array index "${segment}" in pointer ${pointer}`);
      }
      current = current[index];
    } else if (typeof current === 'object') {
      const obj = current as Record<string, unknown>;
      if (!(segment in obj)) {
        throw new Error(`Key "${segment}" not found in pointer ${pointer}`);
      }
      current = obj[segment];
    } else {
      throw new Error(`Cannot resolve pointer ${pointer}: primitive at segment "${segment}"`);
    }
  }

  return current;
}

/**
 * Detects whether a fetched result is a DotProfileSchema wrapper
 * (has `schema_type: "profile"` and a `schema` property) and extracts
 * the inner JSON Schema. Otherwise returns the result as-is.
 */
export function extractSchema(result: unknown): RJSFSchema {
  if (
    typeof result === 'object' &&
    result !== null &&
    'schema_type' in result &&
    (result as Record<string, unknown>).schema_type === 'profile' &&
    'schema' in result
  ) {
    return (result as Record<string, unknown>).schema as RJSFSchema;
  }
  return result as RJSFSchema;
}

/**
 * Resolves a single $ref string. Supports:
 *   - "#/definitions/key"     → local JSON Pointer (requires rootDocument)
 *   - "./file.json"           → relative path (looked up in refMap or fetched)
 *   - "https://..."           → absolute URL (fetched)
 *   - "http://..."            → absolute URL (fetched)
 * Results are cached via schema-loader.
 */
export async function resolveRefString(
  ref: string,
  options?: { baseUrl?: string; rootDocument?: unknown; refMap?: Record<string, unknown> }
): Promise<unknown> {
  // Check cache first
  const cached = getCachedSchema(ref);
  if (cached) return cached;

  let resolved: unknown;

  if (ref.startsWith('#/')) {
    // Local JSON Pointer within root document
    if (!options?.rootDocument) {
      throw new Error(`Cannot resolve local ref "${ref}" without rootDocument`);
    }
    resolved = resolveJsonPointer(options.rootDocument, ref);
  } else if (options?.refMap && ref in options.refMap) {
    // Look up in provided ref map (build-time imports)
    resolved = options.refMap[ref];
  } else {
    // External URL or relative path → fetch
    let url: string;
    if (ref.startsWith('http://') || ref.startsWith('https://')) {
      url = ref;
    } else if (options?.baseUrl) {
      url = `${options.baseUrl}/${ref.replace(/^\.\//, '')}`;
    } else {
      url = new URL(ref, window.location.origin).href;
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to resolve $ref "${ref}": ${response.status}`);
    }
    resolved = await response.json();
  }

  setCachedSchema(ref, resolved as RJSFSchema);
  return resolved;
}

/**
 * Walks an entire object tree and resolves any `{ $ref: "..." }` nodes.
 * Detects DotProfileSchema wrappers and extracts the inner schema.
 * Returns a deep copy with all $ref resolved.
 *
 * @param network - The raw network object (may contain $ref nodes)
 * @param options.refMap - Map of $ref values to pre-loaded schemas (avoids fetch)
 * @param options.baseUrl - Base URL for resolving relative $ref paths via fetch
 */
export async function resolveNetworkRefs(
  network: unknown,
  options?: { baseUrl?: string; refMap?: Record<string, unknown> }
): Promise<unknown> {
  if (typeof network !== 'object' || network === null) {
    return network;
  }

  if (Array.isArray(network)) {
    return Promise.all(
      network.map((item) => resolveNetworkRefs(item, options))
    );
  }

  const obj = network as Record<string, unknown>;

  // If this node is a $ref, resolve it.
  // Skip local JSON Pointers ("#/...") — RJSF resolves $defs/definitions
  // natively at render time, and we don't have the schema's local root here.
  if (typeof obj.$ref === 'string') {
    if (obj.$ref.startsWith('#/') || obj.$ref === '#') {
      return obj;
    }
    const raw = await resolveRefString(obj.$ref, {
      baseUrl: options?.baseUrl,
      rootDocument: network,
      refMap: options?.refMap,
    });
    const schema = extractSchema(raw);
    return resolveNetworkRefs(schema, options);
  }

  // Otherwise recurse into all properties
  const entries = await Promise.all(
    Object.entries(obj).map(async ([key, value]) => [
      key,
      await resolveNetworkRefs(value, options),
    ])
  );

  return Object.fromEntries(entries);
}

export async function resolveRefs(
  schema: RJSFSchema,
  baseUrl?: string
): Promise<RJSFSchema> {
  const resolved = { ...schema };

  if (resolved.$ref) {
    const refTarget = await resolveRef(resolved.$ref, baseUrl);
    const { $ref, ...rest } = resolved;
    return resolveRefs({ ...refTarget, ...rest }, baseUrl);
  }

  if (resolved.properties) {
    const props: Record<string, RJSFSchema> = {};
    for (const [key, prop] of Object.entries(resolved.properties)) {
      props[key] = await resolveRefs(prop as RJSFSchema, baseUrl);
    }
    resolved.properties = props;
  }

  if (resolved.items && typeof resolved.items === 'object') {
    resolved.items = await resolveRefs(resolved.items as RJSFSchema, baseUrl);
  }

  if (resolved.allOf) {
    resolved.allOf = await Promise.all(
      resolved.allOf.map((s) => resolveRefs(s as RJSFSchema, baseUrl))
    );
  }

  if (resolved.oneOf) {
    resolved.oneOf = await Promise.all(
      resolved.oneOf.map((s) => resolveRefs(s as RJSFSchema, baseUrl))
    );
  }

  if (resolved.anyOf) {
    resolved.anyOf = await Promise.all(
      resolved.anyOf.map((s) => resolveRefs(s as RJSFSchema, baseUrl))
    );
  }

  return resolved;
}

async function resolveRef(
  $ref: string,
  baseUrl?: string
): Promise<RJSFSchema> {
  if ($ref.startsWith('#/')) {
    throw new Error(
      `Local JSON Pointer resolution not yet supported: ${$ref}`
    );
  }

  const cached = getCachedSchema($ref);
  if (cached) return cached as RJSFSchema;

  const url = $ref.startsWith('http')
    ? $ref
    : baseUrl
      ? `${baseUrl}/${$ref}`
      : $ref;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to resolve $ref ${url}: ${response.status}`);
  }

  const schema: RJSFSchema = await response.json();
  setCachedSchema($ref, schema);
  return schema;
}

export function mergeAllOf(schemas: RJSFSchema[]): RJSFSchema {
  const merged: RJSFSchema = {
    type: 'object',
    properties: {},
    required: [],
  };

  for (const schema of schemas) {
    if (schema.properties) {
      merged.properties = {
        ...merged.properties,
        ...schema.properties,
      };
    }
    if (schema.required) {
      merged.required = [...(merged.required ?? []), ...schema.required];
    }
    if (schema.description) {
      merged.description = schema.description;
    }
  }

  if (merged.required && merged.required.length === 0) {
    delete merged.required;
  }

  return merged;
}
