"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import type { AuditDoc } from "../audit-loader";

interface Props {
  docs: AuditDoc[];
}

export function AuditViewer({ docs }: Props) {
  const [activeSlug, setActiveSlug] = useState<string>(docs[0]?.slug ?? "");
  const current = docs.find((d) => d.slug === activeSlug) ?? docs[0];
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  if (!current) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
        No audit documents bundled.
      </div>
    );
  }

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    let next = idx;
    if (e.key === "ArrowLeft") next = (idx - 1 + docs.length) % docs.length;
    if (e.key === "ArrowRight") next = (idx + 1) % docs.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = docs.length - 1;
    setActiveSlug(docs[next].slug);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <div
        role="tablist"
        aria-label="Audit documents"
        className="mb-4 flex flex-wrap gap-2 border-b border-[var(--color-border)] pb-3"
      >
        {docs.map((d, idx) => {
          const active = d.slug === current.slug;
          return (
            <button
              key={d.slug}
              ref={(el) => {
                tabRefs.current[idx] = el;
              }}
              type="button"
              role="tab"
              id={`audit-tab-${d.slug}`}
              aria-selected={active}
              aria-controls={`audit-panel-${d.slug}`}
              tabIndex={active ? 0 : -1}
              onClick={() => setActiveSlug(d.slug)}
              onKeyDown={(e) => onTabKey(e, idx)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                active
                  ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
                  : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]"
              }`}
            >
              {d.title}
            </button>
          );
        })}
      </div>

      <div className="mb-3 text-xs text-[var(--color-text-subtle)]">
        Source:{" "}
        <code className="font-mono">{current.sourcePath}</code>
      </div>

      {/* The HTML is built at build time from a trusted in-repo
       *  markdown source. `audit-loader.ts` strips raw HTML and
       *  scheme-validates every link/image URL before rendering, so
       *  the bundled string cannot carry a `javascript:` payload. */}
      <div
        role="tabpanel"
        id={`audit-panel-${current.slug}`}
        aria-labelledby={`audit-tab-${current.slug}`}
        className="docs-prose"
        dangerouslySetInnerHTML={{ __html: current.html }}
      />
    </div>
  );
}
