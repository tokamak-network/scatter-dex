"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  shortAddr,
  useConnectWalletPill,
  useWallet,
} from "@zkscatter/sdk/react";
import { ConnectWalletPillView, useOutsideClick } from "@zkscatter/ui";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { DEMO_NETWORK } from "../lib/network";
import { useOperator } from "../lib/useOperator";
import {
  useOperatorIdentityRefresh,
  useOperatorIdentityStatus,
  useRelayerCaAddress,
} from "../lib/identity";
import { addressInitials, safeOperatorUrl } from "../lib/operatorDisplay";
import { OperatorIdentityBadge } from "./OperatorIdentityBadge";
import {
  formatBalanceForDropdown,
  useTokenBalances,
  type TokenBalanceRow,
} from "../lib/useTokenBalances";

/** Header wallet trigger + expandable info panel.
 *
 *  - Disconnected → fall back to the existing `ConnectWalletPillView`
 *    so the connect UX stays identical to Pay / Pro / the legacy
 *    operators pill. No surprise for first-time visitors.
 *  - Connected → render a Click-to-open button that drops a six-
 *    section panel below. Sections render and error independently
 *    so a flaky RPC for token balances doesn't take down the
 *    identity row.
 *
 *  Why not nav-drop hover like Pay/Pro's IdentityMenu: the panel
 *  reads four scoped contexts and shows a real balance table; a
 *  hover trigger would re-fetch every time the cursor flicked
 *  across the header. Click + outside-click-to-close keeps the
 *  fetch lifecycle tied to explicit user intent.
 */
export function OperatorWalletDropdown() {
  const pill = useConnectWalletPill(DEMO_NETWORK);
  if (!pill.connected) {
    return <ConnectWalletPillView {...pill} />;
  }
  return <ConnectedDropdown />;
}

function ConnectedDropdown() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideClick({ enabled: open, ref: wrapRef, onClose: close });

  // Escape-to-close for keyboard users.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  const { account, disconnect, readProvider } = useWallet();
  const { row: operatorRow, registryDeployed, refresh: refreshOperator } = useOperator();
  const identity = useOperatorIdentityStatus();
  const refreshIdentity = useOperatorIdentityRefresh();
  const relayerCa = useRelayerCaAddress();

  const balances = useTokenBalances(account, readProvider ?? null, DEMO_NETWORK.tokens, {
    enabled: open,
  });

  const explorer = DEMO_NETWORK.explorerBase
    ? `${DEMO_NETWORK.explorerBase.replace(/\/$/, "")}/address/${account}`
    : null;

  const initials = addressInitials(account ?? "");
  const safeUrl = safeOperatorUrl(operatorRow?.url);

  const refreshAll = useCallback(() => {
    refreshOperator();
    refreshIdentity();
  }, [refreshOperator, refreshIdentity]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-mono hover:bg-[var(--color-primary-soft)]"
        title={account ?? undefined}
      >
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-primary-soft)] text-[10px] font-semibold text-[var(--color-primary)]">
          {initials}
        </span>
        <span>{shortAddr(account)}</span>
        <span aria-hidden className="text-[var(--color-text-muted)]">
          ▾
        </span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Operator wallet"
          className="absolute right-0 top-full z-20 mt-2 w-80 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg"
        >
          <IdentityHeaderSection account={account ?? ""} explorer={explorer} />
          <NetworkSection />
          <BalancesSection balances={balances} />
          <RelayerStatusSection
            row={operatorRow}
            registryDeployed={registryDeployed}
            safeUrl={safeUrl}
          />
          <OperatorIdentitySection identity={identity} relayerCa={relayerCa} />
          <ActionsSection
            onDisconnect={() => {
              close();
              disconnect();
            }}
            onRefresh={refreshAll}
            explorer={explorer}
          />
        </div>
      )}
    </div>
  );
}

/* ─── Sections ──────────────────────────────────────────────────── */

function SectionShell({
  title,
  children,
  topBorder = true,
}: {
  title?: string;
  children: React.ReactNode;
  topBorder?: boolean;
}) {
  return (
    <div className={`px-4 py-3 ${topBorder ? "border-t border-[var(--color-border)]" : ""}`}>
      {title && (
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-subtle)]">
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

function IdentityHeaderSection({ account, explorer }: { account: string; explorer: string | null }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(account);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore — copy failure is a UX gap, not a fault we surface */
    }
  }, [account]);
  return (
    <SectionShell topBorder={false}>
      <div className="flex items-center gap-3">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-primary-soft)] font-mono text-xs font-semibold text-[var(--color-primary)]">
          {addressInitials(account)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-[var(--color-text-muted)]">Connected wallet</div>
          <div className="truncate font-mono text-xs" title={account}>
            {account}
          </div>
        </div>
      </div>
      <div className="mt-2 flex gap-2 text-xs">
        <button
          type="button"
          onClick={onCopy}
          className="rounded border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-primary-soft)]"
        >
          {copied ? "Copied" : "Copy"}
        </button>
        {explorer && (
          <a
            href={explorer}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-primary-soft)]"
          >
            Explorer ↗
          </a>
        )}
      </div>
    </SectionShell>
  );
}

function NetworkSection() {
  const isLocal = DEMO_NETWORK.chainId === 31337;
  return (
    <SectionShell title="Network">
      <div className="flex items-center justify-between gap-3 text-xs">
        <div className="min-w-0">
          <div className="font-medium">
            {DEMO_NETWORK.name ?? `Chain ${DEMO_NETWORK.chainId}`}
            {isLocal && (
              <span className="ml-1 rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[9px] font-mono text-[var(--color-text-subtle)]">
                local
              </span>
            )}
          </div>
          <div className="truncate font-mono text-[10px] text-[var(--color-text-muted)]">
            {DEMO_NETWORK.rpcUrl}
          </div>
        </div>
        <div className="font-mono text-[10px] text-[var(--color-text-subtle)]">
          id {DEMO_NETWORK.chainId}
        </div>
      </div>
    </SectionShell>
  );
}

function BalancesSection({ balances }: { balances: TokenBalanceRow[] }) {
  if (balances.length === 0) {
    return (
      <SectionShell title="Balances">
        <div className="text-xs text-[var(--color-text-subtle)]">
          No tokens configured.
        </div>
      </SectionShell>
    );
  }
  return (
    <SectionShell title="Balances">
      <ul className="space-y-1.5">
        {balances.map((row) => (
          <li key={row.symbol} className="flex items-center justify-between text-xs">
            <span className="font-medium">{row.symbol}</span>
            {row.error ? (
              <span
                className="font-mono text-[var(--color-error)]"
                title={row.error}
              >
                error
              </span>
            ) : (
              <span className="font-mono">{formatBalanceForDropdown(row)}</span>
            )}
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

function RelayerStatusSection({
  row,
  registryDeployed,
  safeUrl,
}: {
  row: ReturnType<typeof useOperator>["row"];
  registryDeployed: boolean;
  safeUrl: string | null;
}) {
  if (!registryDeployed) {
    return (
      <SectionShell title="Relayer status">
        <div className="text-xs text-[var(--color-text-subtle)]">
          RelayerRegistry not deployed on this network.
        </div>
      </SectionShell>
    );
  }
  if (!row || row.status === "unregistered") {
    return (
      <SectionShell title="Relayer status">
        <div className="text-xs text-[var(--color-text-subtle)]">
          Not registered.{" "}
          <Link href="/register" className="text-[var(--color-primary)] hover:underline">
            Register →
          </Link>
        </div>
      </SectionShell>
    );
  }
  return (
    <SectionShell title="Relayer status">
      <div className="space-y-1 text-xs">
        <Row label="Status">
          <span className="font-mono">{row.status}</span>
        </Row>
        <Row label="Bond">
          <span className="font-mono">{row.bondEth} ETH</span>
        </Row>
        <Row label="Fee">
          <span className="font-mono">{row.feeBps} bps</span>
        </Row>
        {safeUrl && (
          <Row label="URL">
            <a
              href={safeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate font-mono text-[var(--color-primary)] hover:underline"
              title={safeUrl}
            >
              {safeUrl}
            </a>
          </Row>
        )}
      </div>
    </SectionShell>
  );
}

function OperatorIdentitySection({
  identity,
  relayerCa,
}: {
  identity: ReturnType<typeof useOperatorIdentityStatus>;
  relayerCa: string | null;
}) {
  const supportUrl = process.env.NEXT_PUBLIC_OPERATORS_SUPPORT_URL;
  const showCta =
    identity.kind === "unverified" || identity.kind === "expired" || identity.kind === "no-registry";
  return (
    <SectionShell title="Operator identity (Relayer CA)">
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <OperatorIdentityBadge status={identity} />
          </div>
          {relayerCa && isConfiguredAddress(relayerCa) && (
            <div
              className="mt-1 truncate font-mono text-[10px] text-[var(--color-text-subtle)]"
              title={relayerCa}
            >
              CA {relayerCa.slice(0, 8)}…{relayerCa.slice(-4)}
            </div>
          )}
        </div>
      </div>
      {showCta && (
        <div className="mt-2 text-[11px] leading-snug text-[var(--color-text-muted)]">
          Operator CAs are registered by the platform, not self-served.{" "}
          {supportUrl ? (
            <a
              href={supportUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--color-primary)] hover:underline"
            >
              Ask the platform to enrol your CA ↗
            </a>
          ) : (
            <span>Contact the platform team to enrol your CA.</span>
          )}
        </div>
      )}
      {identity.kind === "verified" && identity.verifiedUntil > 0 && (
        <div className="mt-1 text-[10px] text-[var(--color-text-subtle)]">
          Expires {new Date(identity.verifiedUntil * 1000).toLocaleString()}
        </div>
      )}
      {identity.kind === "error" && (
        <div className="mt-1 text-[10px] text-[var(--color-error)]" title={identity.message}>
          {identity.message}
        </div>
      )}
    </SectionShell>
  );
}

function ActionsSection({
  onDisconnect,
  onRefresh,
  explorer,
}: {
  onDisconnect: () => void;
  onRefresh: () => void;
  explorer: string | null;
}) {
  return (
    <SectionShell>
      <div className="flex flex-wrap gap-2 text-xs">
        <button
          type="button"
          onClick={onRefresh}
          className="rounded border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-primary-soft)]"
        >
          Refresh
        </button>
        {explorer && (
          <a
            href={explorer}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-primary-soft)]"
          >
            View on explorer ↗
          </a>
        )}
        <button
          type="button"
          onClick={onDisconnect}
          className="ml-auto rounded border border-[var(--color-border-strong)] bg-[var(--color-warning-soft)] px-2 py-1 text-[var(--color-warning)] hover:opacity-90"
        >
          Disconnect
        </button>
      </div>
    </SectionShell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[var(--color-text-muted)]">{label}</span>
      <div className="min-w-0 truncate text-right">{children}</div>
    </div>
  );
}
