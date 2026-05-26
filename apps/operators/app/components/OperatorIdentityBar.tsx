"use client";

import Link from "next/link";
import { shortAddr } from "@zkscatter/sdk/react";
import type { OperatorStatus } from "@zkscatter/sdk/relayer";
import { addressInitials, safeOperatorUrl } from "../lib/operatorDisplay";
import { useOperator } from "../lib/useOperator";

/** Top-of-page identity banner for operator-scoped views
 *  (`/dashboard`, `/profile`, `/treasury`, `/orders`). Renders the
 *  connected operator's address + on-chain status; falls back to a
 *  "connect wallet" prompt when no account is available so the
 *  surface is unambiguous about which relayer is in scope. */
export function OperatorIdentityBar() {
  const { account, row, registryDeployed, loading } = useOperator();

  if (!account) {
    return (
      <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-5 py-3 text-sm text-[var(--color-text-muted)]">
        <span>Connect a wallet to load your operator data.</span>
        <span className="text-xs">Use the &ldquo;Connect wallet&rdquo; pill in the header.</span>
      </div>
    );
  }

  const safeUrl = safeOperatorUrl(row?.url);
  const initials = addressInitials(account);
  const status: OperatorStatus = row?.status ?? "unregistered";

  return (
    <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-soft)] font-mono text-xs font-semibold text-[var(--color-primary)]">
          {initials}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {/* Prefer the operator's on-chain `name` over the bare
                address — once a name is set during registration it's
                the canonical display string (see the leaderboard's
                relayerDisplayName fallback chain). Operators that
                registered before the name field existed, or that
                haven't picked one yet, still see "Operator <addr>" so
                the identity bar never reads blank. */}
            <span className="font-semibold">
              {row?.name?.trim() || `Operator ${shortAddr(account)}`}
            </span>
            <IdentityBadge registryDeployed={registryDeployed} loading={loading} status={status} />
          </div>
          <div className="truncate text-xs text-[var(--color-text-muted)]">
            <span className="font-mono" title={account}>{shortAddr(account)}</span>
            {safeUrl ? (
              <>
                {" · "}
                <a
                  href={safeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-[var(--color-text)] hover:underline"
                >
                  {safeUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                </a>
              </>
            ) : row?.url ? (
              <>
                {" · "}
                <span
                  className="text-[var(--color-warning)]"
                  title="Endpoint URL has an unsupported scheme; not rendered as a link."
                >
                  endpoint url invalid
                </span>
              </>
            ) : null}
          </div>
        </div>
      </div>
      <Link
        href="/profile"
        prefetch={false}
        className="flex-shrink-0 text-xs font-medium text-[var(--color-primary)] hover:underline"
      >
        Edit profile →
      </Link>
    </div>
  );
}

const STATUS_CONFIG: Record<OperatorStatus, { dot: string; text: string }> = {
  active:       { dot: "bg-[var(--color-success)]",      text: "Active" },
  cooldown:     { dot: "bg-[var(--color-warning)]",      text: "In cool-down" },
  offline:      { dot: "bg-[var(--color-text-subtle)]",  text: "Offline" },
  unregistered: { dot: "bg-[var(--color-text-subtle)]",  text: "Not registered" },
};

function IdentityBadge({
  registryDeployed,
  loading,
  status,
}: {
  registryDeployed: boolean;
  loading: boolean;
  status: OperatorStatus;
}) {
  if (!registryDeployed) {
    return <span className="text-[10px] text-[var(--color-warning)]">registry not deployed</span>;
  }
  if (loading) {
    return <span className="text-[10px] text-[var(--color-text-subtle)]">loading…</span>;
  }
  const config = STATUS_CONFIG[status];
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]">
      <span className={`h-1.5 w-1.5 rounded-full ${config.dot}`} />
      {config.text}
    </span>
  );
}
