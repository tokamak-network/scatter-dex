import "server-only";
import fs from "node:fs";
import path from "node:path";
import { marked, Renderer } from "marked";
import { DOCS, type DocContent, type DocSlug } from "./docs-data";

// Defence-in-depth: drop any raw HTML the markdown might contain.
// Our docs don't currently use raw HTML, but stripping it at the
// renderer level means a future doc edit can't accidentally turn
// into a `dangerouslySetInnerHTML` XSS surface. We override both the
// block- and inline-HTML token renderers to emit empty strings.
const renderer = new Renderer();
renderer.html = () => "";

// Resolved at module load: `next build` always runs from the package
// dir (apps/operators), so cwd + ../../docs/operations is reliable in
// CI and local. We assert the directory exists so a misconfigured
// build fails loudly at startup instead of erroring per-page.
const DOCS_DIR = (() => {
  const candidate = path.join(process.cwd(), "..", "..", "docs", "operations");
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `In-app docs directory not found at ${candidate}. ` +
        `Run \`next build\` from apps/operators (current cwd: ${process.cwd()}).`,
    );
  }
  return candidate;
})();

export function loadDoc(slug: DocSlug): DocContent {
  const meta = DOCS.find((d) => d.slug === slug);
  if (!meta) throw new Error(`Unknown doc slug: ${slug}`);
  const raw = fs.readFileSync(path.join(DOCS_DIR, `${slug}.md`), "utf8");
  // `async: false` makes the return type a plain string — without it,
  // marked's signature widens to `string | Promise<string>`.
  const html = marked.parse(raw, {
    async: false,
    gfm: true,
    renderer,
  }) as string;
  return { meta, html };
}

export function loadAllDocs(): DocContent[] {
  return DOCS.map((d) => loadDoc(d.slug));
}
