"use client";

import { usePreferences } from "../_lib/preferences";

export default function SettingsPage() {
  const { prefs, setPref } = usePreferences();
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Workspace-local preferences. Persisted in this browser only.
        </p>
      </div>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1">
            <h2 className="text-base font-medium">Stealth addresses</h2>
            <p className="text-sm text-[var(--color-text-muted)]">
              When on, you can send to stealth meta-addresses (one-time
              addresses derived per recipient) and access the Stealth menu
              (Wallet, Inbox). Off by default — most payroll, grants, and
              contractor flows don&apos;t need stealth and stay simpler
              with plain verified ETH addresses.
            </p>
            <p className="text-xs text-[var(--color-text-subtle)]">
              Turning this off hides the Stealth menu and the meta-address
              field in the address book. Existing stealth data is preserved
              and reappears when you turn it back on.
            </p>
          </div>
          <label className="relative inline-flex shrink-0 cursor-pointer items-center">
            <input
              type="checkbox"
              role="switch"
              aria-label="Enable stealth addresses"
              checked={prefs.stealthEnabled}
              onChange={(e) => setPref("stealthEnabled", e.target.checked)}
              className="peer sr-only"
            />
            <span className="h-6 w-11 rounded-full bg-[var(--color-border-strong)] peer-checked:bg-[var(--color-primary)] peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--color-primary)] peer-focus-visible:ring-offset-2" />
            <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
          </label>
        </div>
      </section>
    </div>
  );
}
