import "server-only";
import fs from "node:fs";
import path from "node:path";
import { marked, Renderer } from "marked";

// Defence-in-depth: drop any raw HTML the markdown might contain and
// scheme-validate every link/image URL so a future doc edit can't
// sneak a `javascript:` (or other unsafe scheme) payload into the
// `dangerouslySetInnerHTML` sink.
const SAFE_LINK = /^(https?:|mailto:|#|\/|\.{0,2}\/)/i;
const SAFE_IMAGE = /^(https?:|\/|\.{0,2}\/)/i;

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const renderer = new Renderer();
renderer.html = () => "";
renderer.link = function ({ href, title, tokens }) {
  const text = this.parser.parseInline(tokens);
  if (!href || !SAFE_LINK.test(href)) return text;
  const t = title ? ` title="${escapeAttr(title)}"` : "";
  return `<a href="${escapeAttr(href)}"${t}>${text}</a>`;
};
renderer.image = ({ href, title, text }) => {
  if (!href || !SAFE_IMAGE.test(href)) return escapeAttr(text ?? "");
  const t = title ? ` title="${escapeAttr(title)}"` : "";
  return `<img src="${escapeAttr(href)}" alt="${escapeAttr(text ?? "")}"${t} />`;
};

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
