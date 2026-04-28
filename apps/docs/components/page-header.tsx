/* Page header — section badge above the H1 + optional subtitle and
 * a "Copy page" affordance. Matches the visual rhythm Mintlify ships
 * by default; rendered manually at the top of any mdx page that
 * declares `section` / `description` in frontmatter (the existing
 * frontmatter we already author drives this — no new fields). */
"use client";

import * as React from "react";
import { ClipboardCopy, Check } from "lucide-react";

export function SectionBadge({ children }: { children: React.ReactNode }) {
  return <div className="zs-section-badge">{children}</div>;
}

export function CopyPageButton() {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    const main = document.querySelector("main");
    const text = main?.innerText ?? document.body.innerText;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Surface nothing — the browser blocked clipboard access; the
      // user can still select-all manually.
    }
  }

  return (
    <button type="button" className="zs-copy-btn" onClick={copy}>
      {copied ? (
        <>
          <Check size={14} /> Copied
        </>
      ) : (
        <>
          <ClipboardCopy size={14} /> Copy page
        </>
      )}
    </button>
  );
}
