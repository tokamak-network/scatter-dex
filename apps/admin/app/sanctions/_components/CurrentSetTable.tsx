"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Contract } from "ethers";
import { shortAddr, useWallet } from "@zkscatter/sdk/react";
import { SectionHeader } from "../../components/SectionHeader";
import { explainError } from "../../lib/format";
import { useSanctions } from "./SanctionsContext";

const SANCTIONS_ABI = ["function removeSanction(address addr) external"];

const PAGE_SIZE = 50;

export function CurrentSetTable({ address }: { address: string }) {
  const { currentSet, activeAddBlock, loading, refresh } = useSanctions();
  const { signer, account, connect } = useWallet();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Sorted rows depend ONLY on the on-chain data, not on the filter
  // query — splitting the memo avoids re-running the full O(n log n)
  // sort on every keystroke into the filter input.
  const sortedRows = useMemo(() => {
    const all = [...currentSet].map((addr) => ({
      addr,
      addedAtBlock: activeAddBlock.get(addr) ?? null,
    }));
    // Newest entries first — most operational interest is "what did
    // we just add?" rather than "what's been there since deploy".
    all.sort((a, b) => (b.addedAtBlock ?? 0) - (a.addedAtBlock ?? 0));
    return all;
  }, [currentSet, activeAddBlock]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? sortedRows.filter((r) => r.addr.includes(q)) : sortedRows;
  }, [sortedRows, query]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));

  // Clamp the page index when rows shrinks below the current page —
  // happens after a Remove succeeds and refresh() trims the set. Without
  // this, `visible` becomes an empty slice while the footer shows
  // "Page 4 / 3" and the operator thinks the table glitched.
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  // Slice memo so a parent re-render that doesn't change rows/page
  // doesn't re-slice on every tick.
  const visible = useMemo(
    () => rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [rows, page],
  );

  const removeOne = useCallback(
    async (target: string) => {
      if (!signer) return;
      setBusy(target);
      setErr(null);
      try {
        const c = new Contract(address, SANCTIONS_ABI, signer);
        const tx = await c.removeSanction(target);
        await tx.wait();
        refresh();
      } catch (e) {
        setErr(explainError(e));
      } finally {
        setBusy(null);
      }
    },
    [signer, address, refresh],
  );

  const exportCsv = useCallback(() => {
    const header = "address,added_at_block\n";
    const body = rows.map((r) => `${r.addr},${r.addedAtBlock ?? ""}`).join("\n");
    const blob = new Blob([header + body], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sanctions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [rows]);

  return (
    <section>
      <SectionHeader
        title="Self-list entries"
        badge="live"
        hint={
          loading
            ? "scanning…"
            : `${currentSet.size} address${currentSet.size === 1 ? "" : "es"} in scan window`
        }
      />
      <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] px-4 py-3">
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder="Filter by 0x prefix…"
            className="flex-1 min-w-[240px] rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 font-mono text-xs"
          />
          <button
            type="button"
            onClick={exportCsv}
            disabled={rows.length === 0}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface)] disabled:opacity-50"
          >
            Export CSV ({rows.length})
          </button>
        </div>
        {err && (
          <div className="border-b border-[var(--color-border)] bg-[var(--color-danger-soft)] px-4 py-2 text-xs text-[var(--color-danger)]">
            {err}
          </div>
        )}
        {rows.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-[var(--color-text-muted)]">
            {loading
              ? "Loading sanctioned addresses…"
              : currentSet.size === 0
                ? "Self-list is empty in the current scan window."
                : "No entries match the filter."}
          </div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
              <tr>
                <th className="px-4 py-2">Address</th>
                <th className="px-4 py-2">Added (block)</th>
                <th className="px-4 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.addr} className="border-t border-[var(--color-border)]">
                  <td className="px-4 py-2">
                    <div className="font-mono text-xs">{shortAddr(r.addr)}</div>
                    <div className="font-mono text-[10px] text-[var(--color-text-muted)]">
                      {r.addr}
                    </div>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {r.addedAtBlock ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {!account ? (
                      <button
                        type="button"
                        onClick={() => void connect()}
                        className="text-xs text-[var(--color-primary)] hover:underline"
                      >
                        Connect
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={!signer || busy !== null}
                        onClick={() => void removeOne(r.addr)}
                        className="rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] px-2.5 py-1 text-xs font-medium text-[var(--color-success)] hover:bg-[var(--color-success)] hover:text-white disabled:opacity-40"
                      >
                        {busy === r.addr ? "Removing…" : "Remove"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {rows.length > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-text-muted)]">
            <span>
              Page {page + 1} / {pageCount} · {rows.length} entries
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 hover:bg-[var(--color-surface)] disabled:opacity-40"
              >
                Prev
              </button>
              <button
                type="button"
                disabled={page >= pageCount - 1}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 hover:bg-[var(--color-surface)] disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
      <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">
        Set is reconstructed from on-chain events within the configured lookback window
        (see &quot;Recent events&quot; below). Entries added before the window won&apos;t
        appear here — widen the lookback to backfill.
      </p>
    </section>
  );
}
