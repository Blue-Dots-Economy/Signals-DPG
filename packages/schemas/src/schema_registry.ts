type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonValue[];

type JsonObject = {
  [key: string]: JsonValue | unknown;
};

type FetchLike = typeof fetch;

export type FetchSchemaOptions = {
  fetchFn?: FetchLike;
  resolveRefs?: boolean;
};

export class SchemaFetchError extends Error {
  public readonly url: string;
  public readonly status?: number;
  public readonly statusText?: string;

  constructor(input: {
    url: string;
    status?: number;
    statusText?: string;
    cause?: unknown;
  }) {
    const message = input.status
      ? [
          `Failed to fetch schema from ${input.url}:`,
          input.status,
          input.statusText,
        ]
          .filter(Boolean)
          .join(' ')
      : `Failed to fetch schema from ${input.url}`;

    super(message, { cause: input.cause });
    this.name = 'SchemaFetchError';
    this.url = input.url;
    this.status = input.status;
    this.statusText = input.statusText;
  }
}

export class fetchSchema {
  public readonly url: string;
  public schema: JsonValue | unknown | null = null;

  private readonly fetchFn: FetchLike;
  private readonly resolveRefs: boolean;
  private readonly documentCache = new Map<string, Promise<JsonValue | unknown>>();
  private pendingLoad: Promise<unknown> | null = null;

  constructor(url: string | URL, options: FetchSchemaOptions = {}) {
    this.url = url.toString();
    this.fetchFn = options.fetchFn ?? fetch;
    this.resolveRefs = options.resolveRefs ?? true;
  }

  /**
   * Starts the fetch/resolve on first access and memoises it, so the load runs
   * exactly once per instance and every caller shares one promise.
   *
   * Deliberately NOT kicked off in the constructor: a constructor cannot hand
   * its promise to anyone before `new` returns, so a failing fetch would become
   * an unhandled rejection for a caller that merely constructed the registry.
   * Starting here means the promise always has an owner — whoever touched
   * `.ready` / `getSchema()` — and a fetch failure surfaces to them.
   *
   * The flip side of starting on access: `new fetchSchema(url)` does no I/O at
   * all. Constructing a batch of registries and awaiting them in a later loop
   * runs the fetches one after another. Construct and await in the same
   * expression — `await new fetchSchema(url).getSchema()`, as every call site
   * does — so a `Promise.all` over them stays genuinely parallel.
   *
   * A failed load is memoised as well: the rejection replays to every later
   * caller and is never retried. Retry by constructing a new instance.
   */
  public get ready(): Promise<unknown> {
    this.pendingLoad ??= this.load();
    return this.pendingLoad;
  }

  /**
   * The resolved schema document. Calling this is what starts the load, if
   * nothing has touched `.ready` yet — see `ready` for the parallelism and
   * retry notes.
   */
  public async getSchema(): Promise<JsonValue | unknown> {
    await this.ready;
    return this.schema;
  }

  private async load(): Promise<JsonValue | unknown> {
    const document = await this.fetchDocument(this.url);
    const resolved = this.resolveRefs
      ? await this.resolveNode(document, new URL(this.url), document)
      : document;

    this.schema = resolved;
    return resolved;
  }

  private async fetchDocument(url: string): Promise<JsonValue | unknown> {
    const normalizedUrl = new URL(url).toString();
    const cachedDocument = this.documentCache.get(normalizedUrl);

    if (cachedDocument) {
      return cachedDocument;
    }

    const pendingDocument = (async () => {
      let response: Response;

      try {
        response = await this.fetchFn(normalizedUrl);
      } catch (err) {
        throw new SchemaFetchError({
          url: normalizedUrl,
          cause: err,
        });
      }

      if (!response.ok) {
        throw new SchemaFetchError({
          url: normalizedUrl,
          status: response.status,
          statusText: response.statusText,
        });
      }

      return (await response.json()) as JsonValue | unknown;
    })();

    this.documentCache.set(normalizedUrl, pendingDocument);
    return pendingDocument;
  }

  private async resolveNode(
    node: JsonValue | unknown,
    baseUrl: URL,
    rootDocument: JsonValue | unknown,
  ): Promise<JsonValue | unknown> {
    if (Array.isArray(node)) {
      return Promise.all(
        node.map((value) => this.resolveNode(value, baseUrl, rootDocument)),
      );
    }

    if (!this.isObject(node)) {
      return node;
    }

    if (typeof node.$ref === 'string') {
      const resolvedReference = await this.resolveReference(
        node.$ref,
        baseUrl,
        rootDocument,
      );
      const siblingEntries = Object.entries(node).filter(([key]) => key !== '$ref');

      if (siblingEntries.length === 0) {
        return resolvedReference;
      }

      const resolvedSiblings = (await this.resolveNode(
        Object.fromEntries(siblingEntries),
        baseUrl,
        rootDocument,
      )) as JsonObject;

      if (this.isObject(resolvedReference)) {
        return {
          ...resolvedReference,
          ...resolvedSiblings,
        };
      }

      return {
        value: resolvedReference,
        ...resolvedSiblings,
      };
    }

    const resolvedEntries = await Promise.all(
      Object.entries(node).map(async ([key, value]) => [
        key,
        await this.resolveNode(value, baseUrl, rootDocument),
      ]),
    );

    return Object.fromEntries(resolvedEntries);
  }

  private async resolveReference(
    reference: string,
    baseUrl: URL,
    rootDocument: JsonValue | unknown,
  ): Promise<JsonValue | unknown> {
    if (reference.startsWith('#')) {
      const fragmentValue = this.getFragmentValue(rootDocument, reference);
      return this.resolveNode(fragmentValue, baseUrl, rootDocument);
    }

    const referenceUrl = new URL(reference, baseUrl);
    const documentUrl = new URL(referenceUrl.toString());
    documentUrl.hash = '';

    const referencedDocument = await this.fetchDocument(documentUrl.toString());
    const referencedRoot = referencedDocument;
    const referencedValue = referenceUrl.hash
      ? this.getFragmentValue(referencedDocument, referenceUrl.hash)
      : referencedDocument;

    return this.resolveNode(referencedValue, documentUrl, referencedRoot);
  }

  private getFragmentValue(
    document: JsonValue | unknown,
    fragment: string,
  ): JsonValue | unknown {
    if (fragment === '#') {
      return document;
    }

    const pathSegments = fragment
      .slice(1)
      .split('/')
      .filter(Boolean)
      .map((segment) => segment.replaceAll(/~1/g, '/').replaceAll(/~0/g, '~'));

    let currentValue: JsonValue | unknown = document;

    for (const segment of pathSegments) {
      if (Array.isArray(currentValue)) {
        const index = Number(segment);

        if (!Number.isInteger(index) || index < 0 || index >= currentValue.length) {
          throw new Error(`Invalid schema reference fragment: ${fragment}`);
        }

        currentValue = currentValue[index];
        continue;
      }

      if (this.isObject(currentValue) && segment in currentValue) {
        currentValue = currentValue[segment];
        continue;
      }

      throw new Error(`Invalid schema reference fragment: ${fragment}`);
    }

    return currentValue;
  }

  private isObject(value: JsonValue | unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

export const FetchSchema = fetchSchema;
