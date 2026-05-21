"use client";

import { useState } from "react";
import type { AuditDoc } from "../audit-loader";

interface Props {
  docs: AuditDoc[];
}

export function AuditViewer({ docs }: Props) {
  const [activeSlug, setActiveSlug] = useState<string>(docs[0]?.slug ?? "");
  const current = docs.find((d) => d.slug === activeSlug) ?? docs[0];

  if (!current) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
        No audit documents bundled.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <div className="mb-4 flex flex-wrap gap-2 border-b border-[var(--color-border)] pb-3">
        {docs.map((d) => {
          const active = d.slug === current.slug;
          return (
            <button
              key={d.slug}
              type="button"
              onClick={() => setActiveSlug(d.slug)}
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
       *  markdown source with raw-HTML stripped by the marked
       *  renderer override in `audit-loader.ts`, so there's no XSS
       *  surface from the bundled string. */}
      <div className="docs-prose" dangerouslySetInnerHTML={{ __html: current.html }} />
    </div>
  );
}
