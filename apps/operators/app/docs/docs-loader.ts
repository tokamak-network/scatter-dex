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

// Build a Set of known doc slugs once so the link rewriter below
// can validate cross-doc references in O(1). Computed at module
// init from `DOCS` so adding a new slug + file is enough — no
// need to update this list separately.
const KNOWN_SLUGS: ReadonlySet<string> = new Set(DOCS.map((d) => d.slug));

// Rewrite cross-doc markdown links so the same source works in two
// readers: on GitHub (`[Local Setup](./local-setup.md)` renders as
// a normal repo file link) and inside the in-app /docs viewer
// (where the file is loaded via `?d=<slug>`, not a sibling URL).
// Without this, the operator clicking a sibling link in the in-app
// viewer would 404 on `/docs/local-setup.md`. Matches `(./)?slug.md`
// with optional `#anchor`, rewrites href to `?d=slug#anchor`, and
// leaves everything else (`http://`, `mailto:`, `#anchor-only`,
// anchors into unknown md files) untouched.
const SIBLING_MD_LINK = /^(?:\.\/)?([a-z0-9-]+)\.md(#.*)?$/i;
const originalLink = renderer.link.bind(renderer);
renderer.link = (link) => {
  const match = link.href.match(SIBLING_MD_LINK);
  if (match && KNOWN_SLUGS.has(match[1])) {
    const anchor = match[2] ?? "";
    // Spread to preserve every other Link token field (type, raw,
    // text) — overriding only `href`. Bypasses the marked Link
    // type's stricter shape that bare-object literals don't satisfy.
    return originalLink({ ...link, href: `?d=${match[1]}${anchor}` });
  }
  return originalLink(link);
};

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
