/* Minimal OpenAPI 3.x type model and helpers.
 *
 * We don't pull `openapi-types` to keep the docs app lean — the spec
 * surface we render covers a small subset (paths / operations /
 * schemas with primitive properties + `$ref`). Add fields here as
 * relayer endpoints grow. */

export interface OpenApiSchema {
  type?: string;
  format?: string;
  description?: string;
  example?: unknown;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  required?: string[];
  properties?: Record<string, OpenApiSchema | OpenApiRef>;
  items?: OpenApiSchema | OpenApiRef;
  $ref?: string;
}

export interface OpenApiRef {
  $ref: string;
}

export interface OpenApiParameter {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: OpenApiSchema | OpenApiRef;
}

export interface OpenApiOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    description?: string;
    required?: boolean;
    content?: Record<string, { schema: OpenApiSchema | OpenApiRef }>;
  };
  responses?: Record<
    string,
    {
      description?: string;
      content?: Record<string, { schema: OpenApiSchema | OpenApiRef }>;
    }
  >;
}

export interface OpenApiDoc {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
    contact?: { name?: string; url?: string; email?: string };
  };
  servers?: { url: string; description?: string }[];
  tags?: { name: string; description?: string }[];
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
  };
}

export type Method = "get" | "post" | "put" | "delete" | "patch" | "options" | "head";

export const HTTP_METHODS: Method[] = [
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "options",
  "head",
];

/* Iterate every operation in the spec in path order, then by HTTP
 * method order. Higher-level pages use this to lay out endpoints
 * sequentially; the order matches the yml so authors control it
 * by reordering the `paths` block. */
export function listOperations(
  doc: OpenApiDoc,
): Array<{ path: string; method: Method; op: OpenApiOperation }> {
  const out: Array<{ path: string; method: Method; op: OpenApiOperation }> = [];
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const m of HTTP_METHODS) {
      const op = methods[m];
      if (op) out.push({ path, method: m, op });
    }
  }
  return out;
}

/* Per-doc memoization. The keys live in WeakMaps so they GC with the
 * doc — important when the dev server hot-reloads a fresh spec. */
const exampleCache = new WeakMap<OpenApiDoc, Map<string, unknown>>();

/* Resolve a local `$ref` into the actual schema. We only handle
 * `#/components/schemas/...` since that's what zod-openapi emits;
 * `$ref` pointing outside the doc returns null and the caller
 * surfaces a placeholder rather than crashing.
 *
 * Plain prefix slice — no regex per call. */
const REF_PREFIX = "#/components/schemas/";
export function resolveRef(
  doc: OpenApiDoc,
  ref: string,
): OpenApiSchema | null {
  if (!ref.startsWith(REF_PREFIX)) return null;
  return doc.components?.schemas?.[ref.slice(REF_PREFIX.length)] ?? null;
}

/* Walk a schema, inlining `$ref`s. Apps/docs don't need a full
 * resolver — circular refs in our schemas are already cut by
 * `zod-openapi` when it emits component definitions. */
export function inlineSchema(
  doc: OpenApiDoc,
  schema: OpenApiSchema | OpenApiRef | undefined,
): OpenApiSchema | null {
  if (!schema) return null;
  if ("$ref" in schema && schema.$ref) {
    return resolveRef(doc, schema.$ref);
  }
  return schema as OpenApiSchema;
}

/* Generate a synthetic example object from a schema by walking
 * `example` values on each property. Used by the "Response sample"
 * block when no explicit example is supplied at the operation level.
 *
 * `$ref`-keyed results are memoized per doc so the same schema (e.g.
 * `RelayerProfile` referenced by multiple operations) only walks
 * once. Caches GC with the doc via `WeakMap`. */
export function exampleFromSchema(
  doc: OpenApiDoc,
  schema: OpenApiSchema | OpenApiRef | null | undefined,
): unknown {
  if (!schema) return null;
  if ("$ref" in schema && schema.$ref) {
    let cache = exampleCache.get(doc);
    if (!cache) {
      cache = new Map();
      exampleCache.set(doc, cache);
    }
    const cached = cache.get(schema.$ref);
    if (cached !== undefined) return cached;
    const built = buildExample(doc, resolveRef(doc, schema.$ref));
    cache.set(schema.$ref, built);
    return built;
  }
  return buildExample(doc, schema as OpenApiSchema);
}

const TYPE_FALLBACK: Record<string, unknown> = {
  string: "string",
  integer: 0,
  number: 0,
  boolean: false,
};

function buildExample(doc: OpenApiDoc, s: OpenApiSchema | null): unknown {
  if (!s) return null;
  if (s.example !== undefined) return s.example;
  if (s.type === "object" && s.properties) {
    const out: Record<string, unknown> = {};
    for (const [name, prop] of Object.entries(s.properties)) {
      out[name] = exampleFromSchema(doc, prop);
    }
    return out;
  }
  if (s.type === "array" && s.items) {
    return [exampleFromSchema(doc, s.items)];
  }
  if (s.enum && s.enum.length) return s.enum[0];
  if (s.type && s.type in TYPE_FALLBACK) return TYPE_FALLBACK[s.type];
  return null;
}

/* Display name for a `$ref` — used for "see SchemaName" links. */
export function refName(schema: OpenApiSchema | OpenApiRef | undefined): string | null {
  if (!schema) return null;
  if ("$ref" in schema && schema.$ref) {
    const m = /([^/]+)$/.exec(schema.$ref);
    return m?.[1] ?? null;
  }
  return null;
}

/* Stable in-page anchor for an operation. Shared by the per-page TOC
 * grid, the `RestEndpoint` card it scrolls to, and any cross-doc
 * link generators. Drift between the producers used to be a real
 * source of broken anchors. */
export function operationSlug(method: string, path: string): string {
  const cleaned = path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  return `${method}-${cleaned}`.toLowerCase();
}
