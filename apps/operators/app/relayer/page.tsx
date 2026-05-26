"use client";

/**
 *  `/relayer?address=<addr>` — public read-only profile for any
 *  registered relayer. Migrated from `/relayer/[address]` so the
 *  Operators bundle's `output: "export"` config can build without
 *  needing a `generateStaticParams()` over an unbounded address
 *  space — see the convention note in `next.config.ts`.
 *
 *  Reads the on-chain row via `loadOperatorRow` and probes the
 *  target's `/api/info` + `/api/relayer/stats` for live counters,
 *  so visitors can inspect a peer's fee, bond, success rate, and
 *  live endpoint without needing admin auth on that peer. Lives in
 *  the operators app (rather than a separate marketing site) so
 *  the leaderboard row's link target sits one click away.
 *
 *  Anonymous visitors work — no "you" highlight, no edit
 *  affordances; owners discover their own row from `/dashboard`
 *  instead.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { useWallet } from "@zkscatter/sdk/react";
import {
  loadOperatorRow,
  RelayerClient,
  unwrapEthersError,
  type OperatorRow,
  type RelayerApiInfo,
  type RelayerStatsResponse,
} from "@zkscatter/sdk/relayer";
import { Stat } from "../components/Stat";
import { SectionHeader } from "../components/SectionHeader";
import { DEMO_NETWORK } from "../lib/network";
import { formatIsoDate } from "../lib/format";
import { safeOperatorUrl } from "../lib/operatorDisplay";

const REGISTRY = DEMO_NETWORK.contracts.relayerRegistry;

interface PageState {
  loading: boolean;
  row: OperatorRow | null;
  /** Live `/api/info` payload from the target relayer, captured so
   *  the display name can fall back to `profile.name` / `api.name`
   *  (matching the leaderboard's preference order) when the on-chain
   *  row's `name` field is empty or stale. */
  api: RelayerApiInfo | null;
  stats: RelayerStatsResponse | null;
  online: boolean;
  error: string | null;
  notRegistered: boolean;
}

const INITIAL_STATE: PageState = {
  loading: false,
  row: null,
  api: null,
  stats: null,
  online: false,
  error: null,
  notRegistered: false,
};

/** `useSearchParams()` must live under a Suspense boundary for
 *  `output: "export"` to build / render — Next bails out otherwise
 *  with "useSearchParams() should be wrapped in a suspense
 *  boundary." Split the page into an outer Suspense host + inner
 *  body so the hook stays where the URL state actually needs to be
 *  read. */
export default function RelayerDetailPage() {
  return (
    <Suspense fallback={<Notice tone="info">Loading relayer detail…</Notice>}>
      <RelayerDetailBody />
    </Suspense>
  );
}

function RelayerDetailBody() {
  const search = useSearchParams();
  // Query-string addresses are forwarded as-is to `loadOperatorRow`
  // + the RelayerRegistry — Solidity address args are
  // case-insensitive, so no explicit normalization is needed. The
  // route may be visited with no `address` param (e.g. an internal
  // link without context), in which case we render the
  // "no relayer selected" notice instead of erroring.
  const targetAddress = (search?.get("address") ?? "").trim();
  const { readProvider } = useWallet();
  const registryDeployed = isConfiguredAddress(REGISTRY);
  const [state, setState] = useState<PageState>(INITIAL_STATE);

  useEffect(() => {
    if (!registryDeployed || !targetAddress) {
      setState(INITIAL_STATE);
      return;
    }
    let cancelled = false;
    // Reset to INITIAL_STATE on every target change so an in-flight
    // nav between ?address=A → ?address=B doesn't briefly render
    // A's row/stats under B's URL while the new fetch is in flight.
    setState({ ...INITIAL_STATE, loading: true });
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
        let api: RelayerApiInfo | null = null;
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
          if (infoR.status === "fulfilled") {
            online = true;
            api = infoR.value;
          }
          stats = statsR.status === "fulfilled" ? statsR.value : null;
        }
        if (cancelled) return;
        setState({
          loading: false,
          row,
          api,
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

  const { row, api, stats, online, loading, error, notRegistered } = state;
  const safeUrl = safeOperatorUrl(row?.url);
  // Display-name preference mirrors the leaderboard's `relayerDisplayName`
  // helper: API profile > API top-level name > on-chain row name >
  // fallback. Keeps the detail page in sync with the leaderboard so
  // an operator who edits their off-chain profile sees that name on
  // both surfaces immediately.
  const displayName =
    api?.profile?.name?.trim() ||
    api?.name?.trim() ||
    row?.name?.trim() ||
    (row ? "Relayer" : "Relayer detail");

  return (
    <div className="space-y-10">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{displayName}</h1>
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

      {registryDeployed && !targetAddress && (
        <Notice tone="info">
          No relayer selected. Pick one from{" "}
          <Link href="/leaderboard" className="text-[var(--color-primary)] underline">
            the leaderboard
          </Link>
          .
        </Notice>
      )}

      {registryDeployed && targetAddress && loading && (
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
                    ? `up since ${formatIsoDate(Math.floor(stats.uptimeSince / 1000))}`
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
