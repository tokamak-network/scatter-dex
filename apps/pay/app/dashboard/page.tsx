"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@zkscatter/sdk/react";
import {
  listRuns,
  type RunCategory,
  type RunRecord,
} from "@zkscatter/sdk/storage";
import { PoolBalanceCard } from "../_components/PoolBalanceCard";
import { useFolderStorage } from "../_lib/folderStorage";

type Tab = "all" | RunCategory;

const TABS: { id: Tab; label: string }[] = [
  { id: "all",        label: "All" },
  { id: "payroll",    label: "Payroll" },
  { id: "grants",     label: "Grants" },
  { id: "bonus",      label: "Bonus" },
  { id: "contractor", label: "Contractor" },
  { id: "other",      label: "Other" },
];

const CATEGORY_BADGE: Record<RunCategory, string> = {
  payroll:    "Payroll",
  grants:     "Grants",
  bonus:      "Bonus",
  contractor: "Contractor",
  other:      "Other",
};

export default function Dashboard() {
  const folder = useFolderStorage();
  const wallet = useWallet();
  const [tab, setTab] = useState<Tab>("all");
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [scope, setScope] = useState<"context" | "all-wallets">("context");

  const refresh = useCallback(async () => {
    if (!folder.ready) {
      setRuns([]);
      setLoaded(true);
      return;
    }
    const filter: { chainId?: number; operatorAddress?: string } = {};
    if (wallet.chainId !== null) filter.chainId = wallet.chainId;
    if (scope === "context" && wallet.account) {
      filter.operatorAddress = wallet.account;
    }
    try {
      setRuns(await listRuns(filter));
    } finally {
      setLoaded(true);
    }
  }, [folder.ready, wallet.chainId, wallet.account, scope]);

  useEffect(() => {
    setLoaded(false);
    void refresh();
  }, [refresh, folder.currentId]);

  const visible = tab === "all" ? runs : runs.filter((r) => r.category === tab);

  const stats = useMemo(() => deriveStats(runs), [runs]);

  return (
    <div className="space-y-10">
      <section className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Payouts</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            One-to-many private payouts. Recipients can&apos;t see each other&apos;s amounts.
          </p>
        </div>
        <Link
          href="/payouts/new"
          className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
        >
          New payout
        </Link>
      </section>

      <PoolBalanceCard />

      <ScopeBar scope={scope} setScope={setScope} wallet={wallet} folder={folder} />

      <section className="grid grid-cols-3 gap-4">
        <Stat
          label="This month"
          value={`${stats.thisMonth.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`}
          sub={`across ${stats.distinctTokens} token${stats.distinctTokens === 1 ? "" : "s"}`}
        />
        <Stat
          label="Pending claims"
          value={`${stats.pendingClaims}`}
          sub={`across ${runs.length} run${runs.length === 1 ? "" : "s"}`}
        />
        <Stat
          label="Saved on gas"
          value={stats.gasSavedHint}
          sub="vs. equivalent N transfers"
        />
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--color-text-muted)]">Recent payouts</h2>
          <div className="flex gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5 text-xs">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`rounded px-2.5 py-1 ${
                  tab === t.id
                    ? "bg-[var(--color-primary)] text-white"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <RunsList
          runs={visible}
          loaded={loaded}
          folderReady={folder.ready}
          tab={tab}
        />
      </section>
    </div>
  );
}

function ScopeBar({
  scope,
  setScope,
  wallet,
  folder,
}: {
  scope: "context" | "all-wallets";
  setScope: (s: "context" | "all-wallets") => void;
  wallet: ReturnType<typeof useWallet>;
  folder: ReturnType<typeof useFolderStorage>;
}) {
  const chainLabel = wallet.chainId !== null ? `chain ${wallet.chainId}` : "no chain";
  const walletLabel = wallet.account ? shortAccount(wallet.account) : "no wallet";
  const folderLabel = folder.folderName ?? "no workspace";

  return (
    <section className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-xs">
      <span className="text-[var(--color-text-muted)]">Scope:</span>
      <span className="font-mono">📁 {folderLabel}</span>
      <span className="text-[var(--color-text-subtle)]">·</span>
      <span className="font-mono">🔗 {chainLabel}</span>
      <span className="text-[var(--color-text-subtle)]">·</span>
      <span className="font-mono">{walletLabel}</span>
      {wallet.account && (
        <button
          onClick={() => setScope(scope === "context" ? "all-wallets" : "context")}
          className="ml-auto rounded border border-[var(--color-border-strong)] px-2 py-0.5 text-[10px] hover:bg-[var(--color-primary-soft)]"
        >
          {scope === "context" ? "Show all wallets in workspace" : "Limit to this wallet"}
        </button>
      )}
    </section>
  );
}

function RunsList({
  runs,
  loaded,
  folderReady,
  tab,
}: {
  runs: RunRecord[];
  loaded: boolean;
  folderReady: boolean;
  tab: Tab;
}) {
  if (!folderReady) {
    return (
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-10 text-center text-sm text-[var(--color-text-muted)]">
        Pick a notes folder from the header to see your payouts.
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-10 text-center text-sm text-[var(--color-text-muted)]">
        Loading runs from your folder…
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-10 text-center text-sm text-[var(--color-text-muted)]">
        {tab === "all"
          ? "No runs in this scope yet. Create a payout or switch to a different workspace / wallet."
          : `No ${tab} runs in this scope yet.`}
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      {runs.map((r) => (
        <RunRow key={r.id} record={r} />
      ))}
    </div>
  );
}

function RunRow({ record }: { record: RunRecord }) {
  const total = record.recipients.length;
  const claimed = record.recipients.filter((r) => r.status === "claimed").length;
  const date = formatIsoDate(record.createdAt);
  const operatorTag = record.operatorAddress
    ? shortAccount(record.operatorAddress)
    : "(unknown wallet)";

  return (
    <Link
      href={`/payouts/${record.id}`}
      className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4 last:border-b-0 hover:bg-[var(--color-primary-soft)]"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{record.label}</span>
          <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
            {CATEGORY_BADGE[record.category]}
          </span>
          <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
            chain {record.chainId}
          </span>
        </div>
        <div className="text-xs text-[var(--color-text-muted)]">
          {date} · {total} recipient{total === 1 ? "" : "s"} · sent by {operatorTag}
        </div>
      </div>
      <div className="text-right">
        <div className="font-mono text-sm">
          {record.totalAmount} {record.tokenSymbol}
        </div>
        <div className="text-xs text-[var(--color-text-muted)]">
          {claimed === total ? (
            <span className="text-[var(--color-success)]">All claimed</span>
          ) : (
            <span>
              {claimed}/{total} claimed
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">{sub}</div>
    </div>
  );
}

interface DashboardStats {
  thisMonth: number;
  distinctTokens: number;
  pendingClaims: number;
  /** When `settleGasPaid` is empty across all runs (e.g. only v1
   *  records or wizard not yet wired to capture gas) we surface a
   *  placeholder rather than a misleading $0. */
  gasSavedHint: string;
}

function deriveStats(runs: RunRecord[]): DashboardStats {
  const now = new Date();
  const thisMonthIso = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  let thisMonth = 0;
  let pendingClaims = 0;
  const tokens = new Set<string>();
  let anyGas = false;
  for (const r of runs) {
    tokens.add(r.tokenSymbol);
    pendingClaims += r.recipients.filter((rec) => rec.status !== "claimed").length;
    if (formatIsoDate(r.createdAt).startsWith(thisMonthIso)) {
      thisMonth += parseAmount(r.totalAmount);
    }
    if (r.settleGasPaid) anyGas = true;
  }
  return {
    thisMonth,
    distinctTokens: tokens.size,
    pendingClaims,
    gasSavedHint: anyGas ? "see runs" : "—",
  };
}

function parseAmount(s: string): number {
  const cleaned = s.replace(/,/g, "").trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function formatIsoDate(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

function shortAccount(addr: string): string {
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

