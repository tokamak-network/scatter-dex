"use client";

import type { ReactNode } from "react";
import { SectionHeader } from "../../components/SectionHeader";
import { DEMO_NETWORK } from "../../lib/network";

/** Wrapper used by every /protocol/* sub-page so the "configured /
 *  not-configured" handling is uniform: when the env var isn't set
 *  for the active network we render a dashed mock placeholder with
 *  the exact env-var name the operator needs to set, instead of an
 *  empty card. Lifted out of the original /protocol/page.tsx
 *  (pre-split) verbatim so behaviour stays identical. */
export interface ContractSectionProps {
  title: string;
  address: string | null;
  ready: boolean;
  envHint?: string;
  children: ReactNode;
}

export function ContractSection({
  title,
  address,
  ready,
  envHint,
  children,
}: ContractSectionProps) {
  if (!ready) {
    return (
      <section>
        <SectionHeader title={title} badge="mock" />
        <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-text-muted)]">
          Set <code className="font-mono">{envHint}</code> to enable this section on{" "}
          <strong>{DEMO_NETWORK.name}</strong>.
        </div>
      </section>
    );
  }
  return (
    <section>
      <SectionHeader title={title} badge="live" hint={address ? address : undefined} />
      {children}
    </section>
  );
}
