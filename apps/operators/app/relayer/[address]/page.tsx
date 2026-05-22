"use client";

/**
 *  `/relayer/<address>` — public read-only profile for any registered
 *  relayer. Reuses the leaderboard's data fetch (on-chain row + the
 *  relayer's public `/api/relayer/stats`) so visitors can inspect a
 *  peer's fee, bond, success rate, and live endpoint without needing
 *  admin auth on that peer. Lives in the operators app (rather than a
 *  separate marketing site) so the leaderboard row's link target sits
 *  one click away.
 *
 *  Anonymous visitors: works without a connected wallet. The page
 *  treats every reader as a third party — no "you" highlight, no
 *  edit affordances. Owners discover their own row from
 *  `/dashboard` instead.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { useWallet } from "@zkscatter/sdk/react";
import {
  loadRelayersWithApiInfo,
  unwrapEthersError,
  type RelayerInfo,
} from "@zkscatter/sdk/relayer";
import { Stat } from "../../components/Stat";
import { SectionHeader } from "../../components/SectionHeader";
import { DEMO_NETWORK } from "../../lib/network";
import { formatEther, formatIsoDate } from "../../lib/format";
import { safeOperatorUrl } from "../../lib/operatorDisplay";

const REGISTRY = DEMO_NETWORK.contracts.relayerRegistry;

interface PageState {
  loading: boolean;
  row: RelayerInfo | null;
  error: string | null;
  notFound: boolean;
}

export default function RelayerDetailPage() {
  const params = useParams<{ address: string }>();
  const targetAddress = (params?.address ?? "").toString();
  const { readProvider } = useWallet();
  const registryDeployed = isConfiguredAddress(REGISTRY);
  const [state, setState] = useState<PageState>({
    loading: false,
    row: null,
    error: null,
    notFound: false,
  });

  useEffect(() => {
    if (!registryDeployed || !targetAddress) {
      setState({ loading: false, row: null, error: null, notFound: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null, notFound: false }));
    loadRelayersWithApiInfo(REGISTRY, readProvider, { withStats: true })
      .then((rows) => {
        if (cancelled) return;
        const lc = targetAddress.toLowerCase();
        const hit = rows.find((r) => r.address.toLowerCase() === lc) ?? null;
        setState({
          loading: false,
          row: hit,
          error: null,
          notFound: !hit,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("Failed to load relayer detail", e);
        setState({
          loading: false,
          row: null,
          error: unwrapEthersError(e),
          notFound: false,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [registryDeployed, readProvider, targetAddress]);

  const { row, loading, error, notFound } = state;
  const safeUrl = safeOperatorUrl(row?.url);

  return (
    <div className="space-y-10">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">
            {row?.name?.trim() || (row ? "Relayer" : "Relayer detail")}
          </h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Public profile from{" "}
            <code className="font-mono">RelayerRegistry</code>. No admin auth
            required.
          </p>
        </div>
        <Link
          href="/leaderboard"
          className="text-sm text-[var(--color-primary)] hover:underline"
        >
          ← Leaderboard
        </Link>
      </header>

      {!registryDeployed && (
        <Notice tone="warn">
          RelayerRegistry isn&apos;t deployed on this network — there&apos;s no
          public profile data to show.
        </Notice>
      )}

      {registryDeployed && loading && (
        <Notice tone="info">Loading on-chain row + live stats…</Notice>
      )}

      {registryDeployed && !loading && error && (
        <Notice tone="warn">Failed to load: {error}</Notice>
      )}

      {registryDeployed && !loading && !error && notFound && (
        <Notice tone="warn">
          No relayer registered at this address. Check the leaderboard for the
          current set.
        </Notice>
      )}

      {row && (
        <>
          <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
            <div className="flex flex-wrap items-center gap-3">
              <span
                className={`inline-flex h-2.5 w-2.5 rounded-full ${
                  row.online
                    ? "bg-[var(--color-success)]"
                    : "bg-[var(--color-text-subtle)]"
                }`}
                title={
                  row.online
                    ? "Relayer responded to /api/info"
                    : "Relayer didn't respond — offline or unreachable"
                }
              />
              <span className="font-mono text-sm" title={row.address}>
                {row.address}
              </span>
              {row.exitRequestedAt > 0 && (
                <span className="rounded-full bg-[var(--color-warning-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-warning)]">
                  exiting
                </span>
              )}
            </div>
            <div className="mt-3 text-sm">
              <span className="text-[var(--color-text-muted)]">Endpoint: </span>
              {safeUrl ? (
                <a
                  href={safeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-[var(--color-primary)] hover:underline"
                >
                  {safeUrl}
                </a>
              ) : row.url ? (
                <span
                  className="font-mono text-[var(--color-warning)]"
                  title="URL has an unsupported scheme; not rendered as a link."
                >
                  {row.url}
                </span>
              ) : (
                <span className="text-[var(--color-text-muted)]">
                  not published on-chain
                </span>
              )}
            </div>
          </section>

          <section>
            <SectionHeader title="On-chain" badge="live" />
            <div className="grid grid-cols-3 gap-4">
              <Stat
                label="Fee"
                value={`${(row.fee / 100).toFixed(2)}%`}
                sub={`${row.fee} bps per fill`}
              />
              <Stat
                label="Bond posted"
                value={`${formatEther(row.bond)} ETH`}
                sub={row.active ? "Active" : "Not active"}
              />
              <Stat
                label="Registered"
                value={formatIsoDate(row.registeredAt)}
                sub={
                  row.registeredAt
                    ? `${daysAgo(row.registeredAt)} days ago`
                    : undefined
                }
              />
            </div>
          </section>

          <section>
            <SectionHeader title="Performance" badge="live" />
            <div className="grid grid-cols-3 gap-4">
              <Stat
                label="Settled orders"
                value={
                  row.stats?.settledOrders !== undefined
                    ? String(row.stats.settledOrders)
                    : "—"
                }
                sub={
                  row.stats?.totalOrders !== undefined
                    ? `of ${row.stats.totalOrders} routed`
                    : "stats unavailable"
                }
              />
              <Stat
                label="Success rate"
                value={
                  row.stats?.successRate !== undefined
                    ? `${row.stats.successRate}%`
                    : "—"
                }
                sub={
                  row.stats?.pendingOrders !== undefined
                    ? `${row.stats.pendingOrders} pending`
                    : undefined
                }
              />
              <Stat
                label="Avg settle time"
                value={
                  row.stats?.avgSettleTimeMs != null
                    ? `${Math.round(row.stats.avgSettleTimeMs)} ms`
                    : "—"
                }
                sub={
                  row.stats?.uptimeSince
                    ? `up since ${formatIsoDate(row.stats.uptimeSince)}`
                    : undefined
                }
              />
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "info" | "warn";
  children: React.ReactNode;
}) {
  const cls =
    tone === "warn"
      ? "border-[var(--color-warning)] bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
      : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)]";
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${cls}`}>
      {children}
    </div>
  );
}

function daysAgo(unixSec: number): number {
  const ms = Date.now() - unixSec * 1000;
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}
