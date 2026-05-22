"use client";

/**
 *  `/relayer/<address>` — public read-only profile for any registered
 *  relayer. Reads the on-chain row directly via `loadOperatorRow` and
 *  probes the target's own `/api/relayer/stats` for live counters, so
 *  visitors can inspect a peer's fee, bond, success rate, and live
 *  endpoint without needing admin auth on that peer. Lives in the
 *  operators app (rather than a separate marketing site) so the
 *  leaderboard row's link target sits one click away.
 *
 *  Anonymous visitors: works without a connected wallet. The page
 *  treats every reader as a third party — no "you" highlight, no
 *  edit affordances. Owners discover their own row from
 *  `/dashboard` instead.
 *
 *  We use `loadOperatorRow` instead of `loadRelayersWithApiInfo` so a
 *  single detail-page view costs one row read + one stats probe,
 *  regardless of how many relayers the registry has. The previous
 *  implementation fanned out across every active relayer's endpoint
 *  on every page load, and would mis-report registered-but-not-active
 *  relayers as "not found" because `getActiveRelayers()` excludes
 *  them.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { useWallet } from "@zkscatter/sdk/react";
import {
  loadOperatorRow,
  RelayerClient,
  unwrapEthersError,
  type OperatorRow,
  type RelayerStatsResponse,
} from "@zkscatter/sdk/relayer";
import { Stat } from "../../components/Stat";
import { SectionHeader } from "../../components/SectionHeader";
import { DEMO_NETWORK } from "../../lib/network";
import { formatIsoDate } from "../../lib/format";
import { safeOperatorUrl } from "../../lib/operatorDisplay";

const REGISTRY = DEMO_NETWORK.contracts.relayerRegistry;

interface PageState {
  loading: boolean;
  row: OperatorRow | null;
  stats: RelayerStatsResponse | null;
  online: boolean;
  error: string | null;
  notRegistered: boolean;
}

const INITIAL_STATE: PageState = {
  loading: false,
  row: null,
  stats: null,
  online: false,
  error: null,
  notRegistered: false,
};

export default function RelayerDetailPage() {
  const params = useParams<{ address: string }>();
  const targetAddress = (params?.address ?? "").toString();
  const { readProvider } = useWallet();
  const registryDeployed = isConfiguredAddress(REGISTRY);
  const [state, setState] = useState<PageState>(INITIAL_STATE);

  useEffect(() => {
    if (!registryDeployed || !targetAddress) {
      setState(INITIAL_STATE);
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null, notRegistered: false }));
    loadOperatorRow(REGISTRY, targetAddress, readProvider)
      .then(async (row) => {
        if (cancelled) return;
        if (row.registeredAt === 0) {
          setState({ ...INITIAL_STATE, notRegistered: true });
          return;
        }
        // Only probe the live endpoints when the on-chain row has a
        // URL — saves a guaranteed-to-fail network call when the
        // operator hasn't published one yet.
        let stats: RelayerStatsResponse | null = null;
        let online = false;
        if (row.url) {
          const client = new RelayerClient(row.url, { timeoutMs: 4000 });
          // Run info + stats in parallel; either can fail
          // independently (older builds return 404 on /api/relayer/stats
          // while /api/info still works).
          const [infoR, statsR] = await Promise.allSettled([
            client.getInfo(),
            client.getStats(),
          ]);
          online = infoR.status === "fulfilled";
          stats = statsR.status === "fulfilled" ? statsR.value : null;
        }
        if (cancelled) return;
        setState({
          loading: false,
          row,
          stats,
          online,
          error: null,
          notRegistered: false,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("Failed to load relayer detail", e);
        setState({
          ...INITIAL_STATE,
          error: unwrapEthersError(e),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [registryDeployed, readProvider, targetAddress]);

  const { row, stats, online, loading, error, notRegistered } = state;
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

      {registryDeployed && !loading && !error && notRegistered && (
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
                  online
                    ? "bg-[var(--color-success)]"
                    : "bg-[var(--color-text-subtle)]"
                }`}
                title={
                  online
                    ? "Relayer responded to /api/info"
                    : "Relayer didn't respond — offline or unreachable"
                }
              />
              <span className="font-mono text-sm" title={targetAddress}>
                {targetAddress}
              </span>
              {row.exitRequestedAt > 0 && (
                <span className="rounded-full bg-[var(--color-warning-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-warning)]">
                  exiting
                </span>
              )}
              {!row.active && row.registeredAt > 0 && row.exitRequestedAt === 0 && (
                <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-subtle)]">
                  inactive
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
                value={`${(row.feeBps / 100).toFixed(2)}%`}
                sub={`${row.feeBps} bps per fill`}
              />
              <Stat
                label="Bond posted"
                value={`${row.bondEth} ETH`}
                sub={row.active ? "Active" : "Not active"}
              />
              <Stat
                label="Registered"
                value={formatIsoDate(row.registeredAt)}
                sub={<DaysAgo unixSec={row.registeredAt} />}
              />
            </div>
          </section>

          <section>
            <SectionHeader title="Performance" badge="live" />
            <div className="grid grid-cols-3 gap-4">
              <Stat
                label="Settled orders"
                value={
                  stats?.settledOrders !== undefined
                    ? String(stats.settledOrders)
                    : "—"
                }
                sub={
                  stats?.totalOrders !== undefined
                    ? `of ${stats.totalOrders} routed`
                    : "stats unavailable"
                }
              />
              <Stat
                label="Success rate"
                value={
                  stats?.successRate !== undefined
                    ? `${stats.successRate}%`
                    : "—"
                }
                sub={
                  stats?.pendingOrders !== undefined
                    ? `${stats.pendingOrders} pending`
                    : undefined
                }
              />
              <Stat
                label="Avg settle time"
                value={
                  stats?.avgSettleTimeMs != null
                    ? `${Math.round(stats.avgSettleTimeMs)} ms`
                    : "—"
                }
                sub={
                  stats?.uptimeSince
                    ? `up since ${formatIsoDate(stats.uptimeSince)}`
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

/** Relative-time sub-label for the "Registered" stat. Computing it
 *  during render against `Date.now()` causes a hydration mismatch
 *  because SSR's clock differs from the client's; we initialise to
 *  `null` (suppressed on first paint) and fill in on mount. */
function DaysAgo({ unixSec }: { unixSec: number }) {
  const [days, setDays] = useState<number | null>(null);
  useEffect(() => {
    if (!unixSec) return;
    const ms = Date.now() - unixSec * 1000;
    setDays(Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000))));
  }, [unixSec]);
  if (days === null) return null;
  return <>{days} days ago</>;
}
