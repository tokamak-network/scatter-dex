"use client";

/**
 * `/cross-relayer` — peer-stats and trade-offer history for a relayer
 * that runs inside a shared orderbook. Lived inside `/runtime` until
 * #788's follow-up promoted it to its own route because:
 *   - It's a read-only surface (no admin writes), so co-locating it
 *     with pause/drain/sanctions inflated the runtime page's scope.
 *   - Operators routinely want to leave this page open as a network-
 *     health dashboard while they work elsewhere; a dedicated route
 *     makes that bookmarkable.
 *
 * Auth model is unchanged — same sessionStorage admin token as the
 * rest of the admin pages, surfaced via `AdminConnectBar`.
 */

import { useCallback, useEffect, useState } from "react";
import { OperatorIdentityBar } from "../components/OperatorIdentityBar";
import { AdminConnectBar } from "../components/AdminConnectBar";
import { adminGet, readAdminAuth, type AdminAuth } from "../lib/adminApi";
import { Panel, ErrorLine, useAdmin, shortHex } from "../lib/adminUi";
import { formatRelative } from "../lib/format";

type Auth = AdminAuth | null;

interface PeerStatRow {
  peer: string;
  sent: number;
  received: number;
  settled: number;
  rejected: number;
  errored: number;
  lastAt: number | null;
}

interface TradeOfferRow {
  id: number;
  direction: "sent" | "received";
  peer_relayer: string;
  status: string;
  tx_hash: string | null;
  reason: string | null;
  created_at: number;
}

// UI default for the `peer-stats?since=…` window. The endpoint
// itself supports any `since` (and treats `0` as all-time), but this
// page is for "what happened lately?" so we anchor on 7 days. Bump
// if operators ask for a longer rolling view.
const PEER_STATS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export default function CrossRelayerPage() {
  const [auth, setAuth] = useState<Auth>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setAuth(readAdminAuth());
    setHydrated(true);
  }, []);

  return (
    <div className="space-y-8">
      <OperatorIdentityBar />

      <header>
        <h1 className="text-2xl font-semibold">Cross-relayer</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
          Peer activity and trade-offer history when this relayer runs
          inside a shared orderbook. Empty when running solo (no{" "}
          <code className="font-mono">SHARED_ORDERBOOK_URL</code>{" "}
          configured). Hits the relayer&apos;s{" "}
          <code className="font-mono">/api/admin/peer-stats</code> and{" "}
          <code className="font-mono">/api/admin/trade-offers</code>{" "}
          endpoints with the same sessionStorage token used by Runtime.
        </p>
      </header>

      <AdminConnectBar auth={auth} onAuth={setAuth} />

      {hydrated && auth ? (
        <CrossRelayerPanel auth={auth} />
      ) : (
        <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
          Enter your relayer URL and admin key above to load peer stats
          and recent trade offers.
        </div>
      )}
    </div>
  );
}

function CrossRelayerPanel({ auth }: { auth: NonNullable<Auth> }) {
  const [tick, setTick] = useState(0);
  // Destructure `auth` into primitives so the `useCallback` deps
  // arrays can stay exhaustive without an eslint suppression —
  // `auth` itself is a fresh object reference on every render even
  // when its fields are stable, and depending on it would re-fire
  // the fetch every tick. Pulling `url`/`key` out also makes the
  // intent obvious to a future reader: only these two fields drive
  // the request.
  const { url, key } = auth;

  const peersFetcher = useCallback(
    (signal: AbortSignal) => {
      const since = Date.now() - PEER_STATS_WINDOW_MS;
      return adminGet<{ peers: PeerStatRow[] }>(
        { url, key },
        `/api/admin/peer-stats?since=${since}`,
        signal,
      );
    },
    [url, key],
  );
  const offersFetcher = useCallback(
    (signal: AbortSignal) =>
      adminGet<{ rows: TradeOfferRow[] }>(
        { url, key },
        `/api/admin/trade-offers?limit=20`,
        signal,
      ),
    [url, key],
  );

  const peersState = useAdmin(peersFetcher, [tick]);
  const offersState = useAdmin(offersFetcher, [tick]);

  return (
    <Panel
      title="Activity"
      eyebrow="GET /api/admin/peer-stats · /api/admin/trade-offers"
      action={
        <button
          onClick={() => setTick((n) => n + 1)}
          disabled={peersState.loading || offersState.loading}
          className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          Refresh
        </button>
      }
    >
      {peersState.error && <ErrorLine text={peersState.error} />}
      {offersState.error && <ErrorLine text={offersState.error} />}

      <div>
        <div className="mb-2 text-xs uppercase tracking-wider text-[var(--color-text-subtle)]">
          Peers (last 7 days)
        </div>
        {!peersState.data ? (
          <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>
        ) : peersState.data.peers.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            No cross-relayer activity yet. Either no shared orderbook is
            configured (set <code className="font-mono">SHARED_ORDERBOOK_URL</code>)
            or no peers have matched in the last 7 days.
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
            <table className="w-full text-xs">
              <thead className="bg-[var(--color-bg)] text-[var(--color-text-subtle)]">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Peer</th>
                  <th className="px-3 py-2 text-right font-medium">Sent</th>
                  <th className="px-3 py-2 text-right font-medium">Received</th>
                  <th className="px-3 py-2 text-right font-medium">Settled</th>
                  <th className="px-3 py-2 text-right font-medium">Success%</th>
                  <th className="px-3 py-2 text-right font-medium">Rejected</th>
                  <th className="px-3 py-2 text-right font-medium">Error</th>
                  <th className="px-3 py-2 text-left font-medium">Last</th>
                </tr>
              </thead>
              <tbody>
                {peersState.data.peers.map((p) => {
                  const total = p.sent + p.received;
                  const successPct =
                    total > 0 ? Math.round((p.settled / total) * 100) : 0;
                  return (
                    <tr key={p.peer} className="border-t border-[var(--color-border)]">
                      <td className="px-3 py-2 font-mono">{shortHex(p.peer)}</td>
                      <td className="px-3 py-2 text-right font-mono">{p.sent}</td>
                      <td className="px-3 py-2 text-right font-mono">{p.received}</td>
                      <td className="px-3 py-2 text-right font-mono">{p.settled}</td>
                      <td className="px-3 py-2 text-right font-mono">
                        {total > 0 ? `${successPct}%` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{p.rejected}</td>
                      <td className="px-3 py-2 text-right font-mono">{p.errored}</td>
                      <td className="px-3 py-2 text-[var(--color-text-muted)]">
                        {p.lastAt ? formatRelative(p.lastAt) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-5">
        <div className="mb-2 text-xs uppercase tracking-wider text-[var(--color-text-subtle)]">
          Recent trade offers
        </div>
        {!offersState.data ? (
          <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>
        ) : offersState.data.rows.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            No trade offers recorded.
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
            <table className="w-full text-xs">
              <thead className="bg-[var(--color-bg)] text-[var(--color-text-subtle)]">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">When</th>
                  <th className="px-3 py-2 text-left font-medium">Direction</th>
                  <th className="px-3 py-2 text-left font-medium">Peer</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-left font-medium">Tx / Reason</th>
                </tr>
              </thead>
              <tbody>
                {offersState.data.rows.map((r) => (
                  <tr key={r.id} className="border-t border-[var(--color-border)]">
                    <td className="px-3 py-2 text-[var(--color-text-muted)]">
                      {formatRelative(r.created_at)}
                    </td>
                    <td className="px-3 py-2">{r.direction}</td>
                    <td className="px-3 py-2 font-mono">{shortHex(r.peer_relayer)}</td>
                    <td className="px-3 py-2">
                      <OfferStatusPill status={r.status} />
                    </td>
                    <td className="px-3 py-2 font-mono text-[var(--color-text-muted)]">
                      {r.tx_hash
                        ? shortHex(r.tx_hash)
                        : r.reason
                        ? r.reason
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
}

function OfferStatusPill({ status }: { status: string }) {
  const cls =
    status === "settled"
      ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
      : status === "rejected"
      ? "bg-[var(--color-bg)] text-[var(--color-text-muted)]"
      : "bg-[var(--color-warning-soft)] text-[var(--color-warning)]";
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${cls}`}
    >
      {status}
    </span>
  );
}
