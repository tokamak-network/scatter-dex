"use client";

import { useCallback, useEffect, useState } from "react";
import { Contract, type EventLog, type Log } from "ethers";
import { shortAddr, useWallet } from "@zkscatter/sdk/react";
import { SectionHeader } from "../../components/SectionHeader";

// SanctionsList contains no on-chain enumerator for its `sanctioned`
// mapping. Reconstruct the current set client-side by scanning
// AddressSanctioned + AddressUnsanctioned events, ordering by block
// number, and replaying them in sequence. The result is the set of
// addresses where the most recent event was an "add".
const ABI = [
  "event AddressSanctioned(address indexed addr)",
  "event AddressUnsanctioned(address indexed addr)",
];

// Default lookback. The actual scan window comes from the latest
// block; sanctioned events are sparse so this covers everything for
// most deployments.
const DEFAULT_LOOKBACK_BLOCKS = 100_000n;

interface EventRow {
  kind: "add" | "remove";
  address: string;
  block: number;
  txHash: string;
}

/** Narrow ethers v6's `(EventLog | Log)` union — `queryFilter` against
 *  a typed event filter only emits matching events, so the `args` we
 *  expect always exists, but TS still sees the union. */
function toRow(e: EventLog | Log, kind: "add" | "remove"): EventRow {
  const addr = "args" in e ? ((e.args?.addr as string) ?? "") : "";
  return { kind, address: addr, block: e.blockNumber, txHash: e.transactionHash };
}

interface State {
  rows: EventRow[];
  loading: boolean;
  error: string | null;
}

const EMPTY: State = { rows: [], loading: true, error: null };

export function HistoryView({ address }: { address: string }) {
  const { readProvider } = useWallet();
  const [state, setState] = useState<State>(EMPTY);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ rows: [], loading: true, error: null });

    async function load() {
      try {
        const c = new Contract(address, ABI, readProvider);
        const head = BigInt(await readProvider.getBlockNumber());
        const from = head > DEFAULT_LOOKBACK_BLOCKS ? head - DEFAULT_LOOKBACK_BLOCKS : 0n;
        const [adds, removes] = await Promise.all([
          c.queryFilter(c.filters.AddressSanctioned(), from, head),
          c.queryFilter(c.filters.AddressUnsanctioned(), from, head),
        ]);
        if (cancelled) return;
        const rows: EventRow[] = [
          ...adds.map((e) => toRow(e, "add")),
          ...removes.map((e) => toRow(e, "remove")),
        ].sort((a, b) => b.block - a.block);
        setState({ rows, loading: false, error: null });
      } catch (err) {
        if (cancelled) return;
        setState({
          rows: [],
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [address, readProvider, reloadKey]);

  return (
    <section>
      <SectionHeader
        title="Recent events"
        badge="live"
        hint={`scanning last ${DEFAULT_LOOKBACK_BLOCKS.toString()} blocks`}
      />
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-text-muted)]">
          <span>{state.loading ? "Loading…" : `${state.rows.length} events`}</span>
          <button
            type="button"
            onClick={reload}
            className="text-[var(--color-primary)] hover:underline"
          >
            Refresh
          </button>
        </div>
        {state.error ? (
          <div className="px-4 py-4 text-sm text-[var(--color-danger)]">{state.error}</div>
        ) : state.rows.length === 0 && !state.loading ? (
          <div className="px-4 py-8 text-center text-xs text-[var(--color-text-muted)]">
            No sanction events in the recent block window.
          </div>
        ) : (
          <EventTable rows={state.rows} />
        )}
      </div>
      <CurrentSetSummary rows={state.rows} />
    </section>
  );
}

function EventTable({ rows }: { rows: EventRow[] }) {
  return (
    <table className="w-full text-left text-sm">
      <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
        <tr>
          <th className="px-4 py-2">Kind</th>
          <th className="px-4 py-2">Address</th>
          <th className="px-4 py-2">Block</th>
          <th className="px-4 py-2">Tx</th>
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 200).map((r) => (
          <tr
            key={`${r.block}-${r.txHash}-${r.address}-${r.kind}`}
            className="border-t border-[var(--color-border)]"
          >
            <td className="px-4 py-2">
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                  r.kind === "add"
                    ? "bg-[var(--color-danger-soft)] text-[var(--color-danger)]"
                    : "bg-[var(--color-success-soft)] text-[var(--color-success)]"
                }`}
              >
                {r.kind === "add" ? "Sanctioned" : "Unsanctioned"}
              </span>
            </td>
            <td className="px-4 py-2 font-mono text-xs">{shortAddr(r.address)}</td>
            <td className="px-4 py-2 font-mono text-xs">{r.block}</td>
            <td className="px-4 py-2 font-mono text-xs">{r.txHash.slice(0, 10)}…</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CurrentSetSummary({ rows }: { rows: EventRow[] }) {
  // Replay events in block order to derive the current sanctioned set.
  // `rows` arrives sorted by block desc; reverse for replay.
  const current = new Set<string>();
  for (const r of [...rows].reverse()) {
    const a = r.address.toLowerCase();
    if (r.kind === "add") current.add(a);
    else current.delete(a);
  }
  if (current.size === 0) return null;
  return (
    <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs">
      <div className="font-semibold text-[var(--color-text-muted)]">
        Derived current set ({current.size})
      </div>
      <div className="mt-1 text-[var(--color-text-muted)]">
        Reconstructed from event order; accuracy depends on the scan window covering the
        original add event.
      </div>
    </div>
  );
}
