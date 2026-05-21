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
  txIndex: number;
  logIndex: number;
  txHash: string;
}

/** Narrow ethers v6's `(EventLog | Log)` union — `queryFilter` against
 *  a typed event filter should only emit matching events, but TS sees
 *  the wider union. Throw on the never-happens path so a malformed
 *  log doesn't silently flow into the replayed set with an empty
 *  address. */
function toRow(e: EventLog | Log, kind: "add" | "remove"): EventRow {
  if (!("args" in e) || e.args?.addr == null) {
    throw new Error(`Unexpected log shape on SanctionsList event (block ${e.blockNumber})`);
  }
  return {
    kind,
    address: e.args.addr as string,
    block: e.blockNumber,
    txIndex: e.transactionIndex,
    logIndex: e.index,
    txHash: e.transactionHash,
  };
}

/** Total-order events by (block, txIndex, logIndex). Two events in
 *  the same block can flip an address back and forth — the contract
 *  emits in execution order, so we need the same total order to
 *  reconstruct the final state correctly. */
function compareEvents(a: EventRow, b: EventRow): number {
  if (a.block !== b.block) return a.block - b.block;
  if (a.txIndex !== b.txIndex) return a.txIndex - b.txIndex;
  return a.logIndex - b.logIndex;
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
        const [addsRes, removesRes] = await Promise.allSettled([
          c.queryFilter(c.filters.AddressSanctioned(), from, head),
          c.queryFilter(c.filters.AddressUnsanctioned(), from, head),
        ]);
        if (cancelled) return;
        // Show partial data if one queryFilter fails — the panel is
        // diagnostic, and a missing half is still more useful than
        // a blank screen with an error.
        const adds = addsRes.status === "fulfilled" ? addsRes.value : [];
        const removes = removesRes.status === "fulfilled" ? removesRes.value : [];
        const rows: EventRow[] = [
          ...adds.map((e) => toRow(e, "add")),
          ...removes.map((e) => toRow(e, "remove")),
        ].sort((a, b) => compareEvents(b, a));
        const partial =
          addsRes.status === "rejected" || removesRes.status === "rejected"
            ? `Partial: ${[
                addsRes.status === "rejected" ? "additions failed" : null,
                removesRes.status === "rejected" ? "removals failed" : null,
              ]
                .filter(Boolean)
                .join(", ")}`
            : null;
        setState({ rows, loading: false, error: partial });
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
        {state.error && (
          <div className="border-b border-[var(--color-border)] bg-[var(--color-warning-soft)] px-4 py-2 text-xs text-[var(--color-warning)]">
            {state.error}
          </div>
        )}
        {state.rows.length === 0 && !state.loading ? (
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
  // Replay events in total order (block, txIndex, logIndex) to
  // derive the current sanctioned set. Two events in the same
  // block can flip an address back and forth — block-only ordering
  // would mis-order them.
  const current = new Set<string>();
  const ordered = [...rows].sort(compareEvents);
  for (const r of ordered) {
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
