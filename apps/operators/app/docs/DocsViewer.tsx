"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CATEGORY_ORDER, type DocContent, type DocMeta } from "./docs-data";

interface Props {
  docs: DocContent[];
  index: DocMeta[];
}

const NAV_BASE = "block rounded-lg px-3 py-2 text-sm";
const NAV_ACTIVE = "bg-[var(--color-primary-soft)] font-medium text-[var(--color-primary)]";
const NAV_IDLE = "text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]";

export function DocsViewer({ docs, index }: Props) {
  const params = useSearchParams();
  const selected = params.get("d") ?? "operations-guide";

  // `docs` is built at build time from a non-empty curated `DOCS`
  // index, but guarding here means a future `DOCS = []` can't crash
  // the route — it renders an explicit empty state instead.
  if (docs.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
        No documentation available.
      </div>
    );
  }
  const current = docs.find((d) => d.meta.slug === selected) ?? docs[0];

  return (
    <div className="grid gap-8 lg:grid-cols-[260px_minmax(0,820px)]">
      <aside className="space-y-6 lg:sticky lg:top-24 lg:self-start">
        {CATEGORY_ORDER.map((cat) => {
          const items = index.filter((d) => d.category === cat);
          if (items.length === 0) return null;
          return (
            <div key={cat}>
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-subtle)]">
                {cat}
              </div>
              <ul className="space-y-1">
                {items.map((d) => {
                  const active = d.slug === current.meta.slug;
                  return (
                    <li key={d.slug}>
                      <Link
                        href={`/docs?d=${d.slug}`}
                        aria-current={active ? "page" : undefined}
                        className={`${NAV_BASE} ${active ? NAV_ACTIVE : NAV_IDLE}`}
                      >
                        {d.title}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs text-[var(--color-text-muted)]">
          <div className="mb-1 font-medium text-[var(--color-text)]">Source</div>
          Docs are versioned with the relayer. View the raw markdown in{" "}
          <code className="rounded bg-[var(--color-bg)] px-1">docs/operations/</code>.
        </div>
      </aside>

      <article className="min-w-0">
        <div className="mb-6">
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-subtle)]">
            {current.meta.category}
          </div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">
            {current.meta.title}
          </h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            {current.meta.blurb}
          </p>
        </div>
        <div
          className="docs-prose"
          // Markdown is built from in-tree files we control, so the
          // HTML is trusted — no untrusted-input XSS surface.
          dangerouslySetInnerHTML={{ __html: current.html }}
        />
      </article>
    </div>
  );
}
