/* REST API reference for the zkScatter relayer.
 *
 * Server component — reads the OpenAPI yml at request time (`fs.readFile`,
 * not bundler `import`) so dev hot-reload picks up regenerated specs
 * without restarting Next, and prod builds embed the latest committed
 * yml. The `RestEndpoint` component does the actual rendering with
 * the same `zs-*` styles every other page uses.
 *
 * The yml itself is auto-generated from the relayer's zod schemas
 * (`zk-relayer/scripts/build-openapi.mjs`) — schema change → `npm run
 * openapi` → page reflects the new shape on next request. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { listOperations, type OpenApiDoc } from "../../../../lib/openapi";
import { RestEndpoint } from "../../../../components/rest-endpoint";
import {
  CopyPageButton,
  SectionBadge,
} from "../../../../components/page-header";
import { useMDXComponents as getMDXComponents } from "../../../../mdx-components";

// Same wrapper Nextra uses for MDX content — gives our REST page
// the article container, prose width, heading scale, prev/next nav,
// and "Edit this page" link so it visually matches the catch-all
// MDX pages tab-for-tab.
const Wrapper = getMDXComponents().wrapper;

export const metadata = {
  title: "Relayer REST API",
  description:
    "HTTP API every zkScatter relayer node exposes. Auto-generated from the relayer's zod schemas.",
};

async function loadSpec(): Promise<OpenApiDoc> {
  const path = join(process.cwd(), "public", "openapi", "relayer.yaml");
  const text = await readFile(path, "utf8");
  return parseYaml(text) as OpenApiDoc;
}

export default async function Page() {
  const doc = await loadSpec();
  const operations = listOperations(doc);
  const server = doc.servers?.[0]?.url;

  // Build TOC entries from the operations so Nextra's right-rail
  // "On this page" links to each endpoint card.
  const toc = operations.map(({ method, path, op }) => {
    const id = `${method}-${path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`.toLowerCase();
    return { value: op.summary ?? `${method.toUpperCase()} ${path}`, id, depth: 2 };
  });

  return (
    <Wrapper toc={toc} metadata={metadata}>
    <article className="zs-rest-page">
      {/* Same page-header treatment Documentation/SDK pages get from
          the catch-all route — keeps the three tabs visually aligned. */}
      <div className="zs-page-header">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "1rem",
            marginBottom: "0.4rem",
          }}
        >
          <SectionBadge>REST API</SectionBadge>
          <CopyPageButton />
        </div>
        {/* No custom class — let Nextra's MDX H1 styles apply so the
            heading scale matches the Documentation/SDK ref tabs. */}
        <h1>{doc.info.title}</h1>
        {doc.info.description && (
          <p
            style={{
              fontSize: "1.05rem",
              opacity: 0.7,
              margin: "0.25rem 0 0",
              lineHeight: 1.5,
            }}
          >
            {doc.info.description}
          </p>
        )}
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
      </div>

      {/* Endpoints index — laid out as Cards so it picks up the same
          hover treatment Documentation pages use. */}
      <section className="zs-rest-toc-section">
        <h2 className="zs-rest-toc-title">Endpoints</h2>
        <div className="zs-rest-toc-grid">
          {operations.map(({ path, method, op }) => (
            <a
              key={`${method}-${path}`}
              href={`#${method}-${path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`}
              className="zs-card-link"
            >
              <div className="zs-card">
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    marginBottom: "0.3rem",
                  }}
                >
                  <span
                    className="zs-rest-method zs-rest-method-sm"
                    data-method={method}
                  >
                    {method.toUpperCase()}
                  </span>
                  <code className="zs-card-title">{path}</code>
                </div>
                <div className="zs-card-body">{op.summary}</div>
              </div>
            </a>
          ))}
        </div>
      </section>

      <div className="zs-rest-list">
        {operations.map(({ path, method, op }) => (
          <RestEndpoint
            key={`${method}-${path}`}
            doc={doc}
            method={method}
            path={path}
            op={op}
            serverUrl={server}
          />
        ))}
      </div>
    </article>
    </Wrapper>
  );
}
