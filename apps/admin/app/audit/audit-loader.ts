import "server-only";
import fs from "node:fs";
import path from "node:path";
import { marked, Renderer } from "marked";

// Defence-in-depth: drop any raw HTML the markdown might contain. We
// override both block- and inline-HTML renderers so a future doc
// edit can't sneak a `dangerouslySetInnerHTML` XSS surface in.
const renderer = new Renderer();
renderer.html = () => "";

// Resolved at module load: `next build` runs from apps/admin, so
// cwd + ../../docs/security is reliable.
const DOCS_DIR = (() => {
  const candidate = path.join(process.cwd(), "..", "..", "docs", "security");
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `Security docs directory not found at ${candidate}. ` +
        `Run \`next build\` from apps/admin (current cwd: ${process.cwd()}).`,
    );
  }
  return candidate;
})();

export interface AuditDoc {
  slug: string;
  title: string;
  /** Source-of-truth path inside the repo, surfaced in the UI so
   *  auditors can locate it in `git log`. */
  sourcePath: string;
  html: string;
}

const DOCS: { slug: string; title: string; file: string }[] = [
  { slug: "audit", title: "AUDIT.md — External audit package", file: "AUDIT.md" },
  { slug: "hardening", title: "HARDENING.md — Defence-in-depth layers", file: "HARDENING.md" },
];

export function loadAuditDocs(): AuditDoc[] {
  return DOCS.map(({ slug, title, file }) => {
    const fullPath = path.join(DOCS_DIR, file);
    const raw = fs.readFileSync(fullPath, "utf8");
    const html = marked.parse(raw, {
      async: false,
      gfm: true,
      renderer,
    }) as string;
    return {
      slug,
      title,
      sourcePath: `docs/security/${file}`,
      html,
    };
  });
}
