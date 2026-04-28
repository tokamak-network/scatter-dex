/* REST API reference for the zkScatter relayer.
 *
 * Server component — reads the OpenAPI yml at request time
 * (`fs/promises.readFile` + `parseYaml`), wrapped with React `cache()`
 * so multiple components on the same render share one parse, and
 * Nextra's static-generation pass also gets a single read at build
 * time.
 *
 * The yml itself is auto-generated from the relayer's zod schemas
 * (`zk-relayer/scripts/build-openapi.mjs`) — schema change → `npm run
 * openapi` → page reflects the new shape on next request. */
import { cache } from "react";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  listOperations,
  operationSlug,
  type OpenApiDoc,
} from "../../../../lib/openapi";
import { RestEndpoint } from "../../../../components/rest-endpoint";
import { DocsPageShell } from "../../../../components/page-header";
import { useMDXComponents as getMDXComponents } from "../../../../mdx-components";

export const metadata = {
  title: "Relayer REST API",
  description:
    "HTTP API every zkScatter relayer node exposes. Auto-generated from the relayer's zod schemas.",
};

const Wrapper = getMDXComponents().wrapper;

const loadSpec = cache(async (): Promise<OpenApiDoc> => {
  const path = join(process.cwd(), "public", "openapi", "relayer.yaml");
  const text = await readFile(path, "utf8");
  return parseYaml(text) as OpenApiDoc;
});

export default async function Page() {
  const doc = await loadSpec();
  const operations = listOperations(doc).map((entry) => ({
    ...entry,
    slug: operationSlug(entry.method, entry.path),
  }));
  const server = doc.servers?.[0]?.url;

  const toc = operations.map((entry) => ({
    value: entry.op.summary ?? `${entry.method.toUpperCase()} ${entry.path}`,
    id: entry.slug,
    depth: 2,
  }));

  return (
    <Wrapper toc={toc} metadata={metadata}>
      <article className="zs-rest-page">
        <DocsPageShell section="REST API" description={doc.info.description}>
          <h1>{doc.info.title}</h1>
          {server && (
            <div className="zs-rest-server">
              <span className="zs-rest-server-label">Server</span>
              <code className="zs-rest-server-url">{server}</code>
              {doc.servers?.[0]?.description && (
                <span className="zs-rest-server-desc">
                  {doc.servers[0].description}
                </span>
              )}
            </div>
          )}
        </DocsPageShell>

        <section className="zs-rest-toc-section">
          <h2 className="zs-rest-toc-title">Endpoints</h2>
          <div className="zs-rest-toc-grid">
            {operations.map((entry) => (
              <a
                key={entry.slug}
                href={`#${entry.slug}`}
                className="zs-card-link"
              >
                <div className="zs-card">
                  <div className="zs-rest-toc-row">
                    <span
                      className="zs-rest-method zs-rest-method-sm"
                      data-method={entry.method}
                    >
                      {entry.method.toUpperCase()}
                    </span>
                    <code className="zs-card-title">{entry.path}</code>
                  </div>
                  <div className="zs-card-body">{entry.op.summary}</div>
                </div>
              </a>
            ))}
          </div>
        </section>

        <div className="zs-rest-list">
          {operations.map((entry) => (
            <RestEndpoint
              key={entry.slug}
              doc={doc}
              method={entry.method}
              path={entry.path}
              op={entry.op}
              serverUrl={server}
              slug={entry.slug}
            />
          ))}
        </div>
      </article>
    </Wrapper>
  );
}
