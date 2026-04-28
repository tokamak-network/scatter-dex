"use client";

import type { ReactNode } from "react";

export interface AppShellHeaderProps {
  /** Brand mark / wordmark — typically `<Brand />` from the host app. */
  brand: ReactNode;
  /** Pill rendered next to the brand showing the active chain.
   *  Pro passes a multi-chain `NetworkSwitcher`; Operators / Pay pass
   *  a static `Pill` since their chain is fixed by env. */
  chainPill?: ReactNode;
  /** Wallet element on the right side of the header — usually
   *  `ConnectWalletPill` (shared) or an app-specific button. */
  walletSlot?: ReactNode;
  /** Pre-rendered nav links (`<Link />` / `<a />`). The "← All apps"
   *  link is prepended automatically. */
  navLinks: ReactNode;
  /** Optional in-page slots before the nav links (e.g. Pay's
   *  `<FolderPill />`). Rendered after `navLinks`, before the
   *  wallet slot. */
  navTrailing?: ReactNode;
  /** Hub URL used by the "← All apps" link. */
  hubUrl: string;
  /** Banner ribbon above the header (launch event copy, etc). */
  topRibbon?: ReactNode;
}

/** Shared app-shell header — same layout across Pro / Operators /
 *  Pay so a header tweak in one place propagates everywhere. The
 *  layout is `flex flex-wrap justify-between`, so narrow viewports
 *  shed groups onto a second row instead of overlapping. */
export function AppShellHeader({
  brand,
  chainPill,
  walletSlot,
  navLinks,
  navTrailing,
  hubUrl,
  topRibbon,
}: AppShellHeaderProps) {
  return (
    <>
      {topRibbon}
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-y-2 px-6 py-4">
          <div className="flex items-center gap-3">
            {brand}
            {chainPill}
          </div>
          <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-[var(--color-text-muted)]">
            <a href={hubUrl} className="hover:text-[var(--color-text)]">
              ← All apps
            </a>
            {navLinks}
            {navTrailing}
            {walletSlot}
          </nav>
        </div>
      </header>
    </>
  );
}
