/* Render a single OpenAPI operation as a Mintlify-flavoured card.
 *
 * Static / server-component — reads the spec at build time from
 * `apps/docs/public/openapi/*.yaml`, walks its operations, and lays
 * out method+path, summary, parameters, request body, responses, and
 * a cURL example, all using our `zs-*` styles so the output blends
 * with every other page in the docs.
 *
 * Schema rendering is deliberately shallow: top-level properties of
 * the response/request schema get a row each, with nested objects
 * folded under a `<SchemaTree>` indent. Going deeper would duplicate
 * what an SDK reference page already shows. */
import * as React from "react";
import {
  exampleFromSchema,
  inlineSchema,
  operationSlug,
  refName,
  type OpenApiDoc,
  type OpenApiOperation,
  type OpenApiParameter,
  type OpenApiSchema,
  type OpenApiRef,
} from "../lib/openapi";

interface Props {
  doc: OpenApiDoc;
  method: string;
  path: string;
  op: OpenApiOperation;
  serverUrl?: string;
  /** Optional precomputed slug — falls back to `operationSlug()`. */
  slug?: string;
}

export function RestEndpoint({ doc, method, path, op, serverUrl, slug }: Props) {
  const M = method.toUpperCase();
  const id = slug ?? operationSlug(method, path);
  const requestSchema = op.requestBody?.content?.["application/json"]?.schema;
  const responses = Object.entries(op.responses ?? {});

  // Hoisted once: success-response schema for the Example block.
  const successSchema = responses.find(([s]) => s.startsWith("2"))?.[1]
    ?.content?.["application/json"]?.schema;

  return (
    <section id={id} className="zs-rest-endpoint">
      <header className="zs-rest-head">
        <h2 className="zs-rest-title">{op.summary ?? `${M} ${path}`}</h2>
        <div className="zs-rest-line">
          <span className="zs-rest-method" data-method={method}>
            {M}
          </span>
          <code className="zs-rest-path">{path}</code>
        </div>
        {op.description && (
          <p className="zs-rest-description">{op.description}</p>
        )}
      </header>

      {op.parameters && op.parameters.length > 0 && (
        <ParameterSection title="Parameters" params={op.parameters} doc={doc} />
      )}

      {requestSchema && (
        <Block title="Request body">
          <SchemaTree doc={doc} schema={requestSchema} />
        </Block>
      )}

      {responses.length > 0 && (
        <Block title="Responses">
          {responses.map(([status, res]) => {
            const schema = res.content?.["application/json"]?.schema;
            const tone = status.startsWith("2") ? "ok" : "err";
            return (
              <div key={status} className="zs-rest-response">
                <div className="zs-rest-status">
                  <span className="zs-rest-status-pill" data-tone={tone}>
                    {status}
                  </span>
                  <span className="zs-rest-status-desc">
                    {res.description ?? ""}
                  </span>
                </div>
                {schema && <SchemaTree doc={doc} schema={schema} />}
              </div>
            );
          })}
        </Block>
      )}

      <Block title="Example">
        <CurlBlock
          method={M}
          url={`${serverUrl ?? "https://relayer.example.com"}${path}`}
        />
        {successSchema && <ResponseSample doc={doc} schema={successSchema} />}
      </Block>
    </section>
  );
}

function Block({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="zs-rest-block">
      <h3 className="zs-rest-block-title">{title}</h3>
      {children}
    </div>
  );
}

function ParameterSection({
  title,
  params,
  doc,
}: {
  title: string;
  params: OpenApiParameter[];
  doc: OpenApiDoc;
}) {
  return (
    <Block title={title}>
      <div className="zs-rest-params">
        {params.map((p) => {
          const s = inlineSchema(doc, p.schema);
          return (
            <div key={`${p.in}-${p.name}`} className="zs-rest-param">
              <div className="zs-rest-param-head">
                <code className="zs-rest-param-name">{p.name}</code>
                <span className="zs-rest-param-meta">
                  {s?.type ?? "string"}
                </span>
                <span className="zs-rest-param-loc">{p.in}</span>
                {p.required && <span className="zs-rest-required">required</span>}
              </div>
              {p.description && (
                <p className="zs-rest-param-desc">{p.description}</p>
              )}
            </div>
          );
        })}
      </div>
    </Block>
  );
}

function SchemaTree({
  doc,
  schema,
  depth = 0,
}: {
  doc: OpenApiDoc;
  schema: OpenApiSchema | OpenApiRef;
  depth?: number;
}) {
  const ref = refName(schema);
  const s = inlineSchema(doc, schema);
  if (!s) {
    return ref ? (
      <p className="zs-rest-param-desc">
        See <code>{ref}</code> schema.
      </p>
    ) : null;
  }
  if (s.type !== "object" || !s.properties) {
    return (
      <pre className="zs-code-pre">
        <code>{JSON.stringify(s, null, 2)}</code>
      </pre>
    );
  }
  const required = new Set(s.required ?? []);
  return (
    <div className="zs-rest-params" data-depth={depth}>
      {ref && depth === 0 && (
        <div className="zs-rest-schema-name">{ref}</div>
      )}
      {Object.entries(s.properties).map(([name, prop]) => {
        const propSchema = inlineSchema(doc, prop);
        const isObject =
          propSchema?.type === "object" && !!propSchema.properties;
        return (
          <div key={name} className="zs-rest-param">
            <div className="zs-rest-param-head">
              <code className="zs-rest-param-name">{name}</code>
              <span className="zs-rest-param-meta">
                {propSchema?.type ?? refName(prop) ?? "any"}
              </span>
              {required.has(name) && (
                <span className="zs-rest-required">required</span>
              )}
            </div>
            {propSchema?.description && (
              <p className="zs-rest-param-desc">{propSchema.description}</p>
            )}
            {propSchema?.example !== undefined && (
              <p className="zs-rest-param-example">
                example: <code>{JSON.stringify(propSchema.example)}</code>
              </p>
            )}
            {isObject && propSchema && (
              <SchemaTree doc={doc} schema={propSchema} depth={depth + 1} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function CurlBlock({ method, url }: { method: string; url: string }) {
  return (
    <pre className="zs-code-pre">
      <code>
        {`curl --request ${method} \\
  --url ${url}`}
      </code>
    </pre>
  );
}

function ResponseSample({
  doc,
  schema,
}: {
  doc: OpenApiDoc;
  schema: OpenApiSchema | OpenApiRef;
}) {
  const sample = exampleFromSchema(doc, schema);
  return (
    <pre className="zs-code-pre">
      <code>{JSON.stringify(sample, null, 2)}</code>
    </pre>
  );
}
