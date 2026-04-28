/* Page header — section badge + (optional) description + a Copy-page
 * button — and the shared shell used by every page so the docs site
 * has one canonical layout for "above the fold". `DocsPageShell` is
 * called from both `app/[[...mdxPath]]/page.tsx` and the explicit
 * `app/sdk/rest/relayer/page.tsx`. */
"use client";

import * as React from "react";
import { ClipboardCopy, Check } from "lucide-react";

export function SectionBadge({ children }: { children: React.ReactNode }) {
  return <div className="zs-section-badge">{children}</div>;
}

export function CopyPageButton() {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function copy() {
    // `textContent` skips the `<style>`/script bodies and avoids the
    // forced layout `innerText` triggers — fine for plain copy use.
    const main = document.querySelector("main");
    const text = main?.textContent ?? document.body.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard blocked by permissions / non-secure context — let
      // the user select-all manually rather than surface a noisy
      // toast for a non-essential affordance.
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

/* Standard page-header shell. Pages render their H1/body as
 * `children` after this; the shell handles only the badge row and
 * the optional description paragraph so two pages don't duplicate
 * inline-style flex blocks. */
export function DocsPageShell({
  section,
  description,
  children,
}: {
  section?: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="zs-page-header">
      <div className="zs-page-header-row">
        {section ? <SectionBadge>{section}</SectionBadge> : <span />}
        <CopyPageButton />
      </div>
      {description && <p className="zs-page-header-desc">{description}</p>}
      {children}
    </div>
  );
}
