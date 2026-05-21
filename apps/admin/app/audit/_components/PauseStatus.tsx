"use client";

import { useEffect, useState } from "react";
import { Contract } from "ethers";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { shortAddr, useWallet } from "@zkscatter/sdk/react";

const PAUSABLE_ABI = ["function paused() external view returns (bool)"];

interface Target {
  label: string;
  address: string;
}

interface Row {
  label: string;
  address: string;
  paused: boolean | null;
  error: string | null;
}

/** Audit snapshot of every pausable contract on this deployment.
 *  A single "paused" entry is a major operational signal — having it
 *  on the audit page lets an incident responder confirm emergency
 *  stops are engaged across the surface in one glance. */
export function PauseStatus({ targets }: { targets: Target[] }) {
  const { readProvider } = useWallet();
  const [rows, setRows] = useState<Row[]>(() =>
    targets.map((t) => ({ label: t.label, address: t.address, paused: null, error: null })),
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      targets.map(async (t): Promise<Row> => {
        if (!isConfiguredAddress(t.address)) {
          return { label: t.label, address: t.address, paused: null, error: "unset" };
        }
        try {
          const c = new Contract(t.address, PAUSABLE_ABI, readProvider);
          const p = (await c.paused()) as boolean;
          return { label: t.label, address: t.address, paused: p, error: null };
        } catch (e) {
          return {
            label: t.label,
            address: t.address,
            paused: null,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    ).then((next) => {
      if (!cancelled) setRows(next);
    });
    return () => {
      cancelled = true;
    };
  }, [targets, readProvider]);

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full text-left text-sm">
        <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
          <tr>
            <th className="px-4 py-2">Contract</th>
            <th className="px-4 py-2">Address</th>
            <th className="px-4 py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-[var(--color-border)]">
              <td className="px-4 py-2 font-medium">{r.label}</td>
              <td className="px-4 py-2 font-mono text-xs text-[var(--color-text-muted)]">
                {isConfiguredAddress(r.address) ? shortAddr(r.address) : "—"}
              </td>
              <td className="px-4 py-2">
                <StatusPill row={r} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ row }: { row: Row }) {
  if (row.error === "unset") {
    return <span className="text-xs text-[var(--color-text-subtle)]">Unconfigured</span>;
  }
  if (row.error) {
    return (
      <span className="text-xs text-[var(--color-danger)]" title={row.error}>
        Read failed
      </span>
    );
  }
  if (row.paused === null) {
    return <span className="text-xs text-[var(--color-text-muted)]">…</span>;
  }
  if (row.paused) {
    return (
      <span className="rounded-full bg-[var(--color-danger-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-danger)]">
        ⏸ Paused
      </span>
    );
  }
  return (
    <span className="rounded-full bg-[var(--color-success-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-success)]">
      ● Active
    </span>
  );
}
