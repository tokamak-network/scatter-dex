"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { shortAddr, useMounted, useWallet } from "@zkscatter/sdk/react";
import { formatTokenLabel } from "@zkscatter/sdk";
import {
  listRunsSummary,
  type RunCategory,
  type RunsIndexEntry,
} from "@zkscatter/sdk/storage";
import { PoolBalanceCard } from "../_components/PoolBalanceCard";
import { WorkspaceBar } from "../_components/WorkspaceBar";
import { useFolderStorage } from "../_lib/folderStorage";
import { formatRelativeAgo, parseAmount } from "../_lib/format";
import {
  clearWizardDraft,
  loadAllWizardDrafts,
  type WizardDraft,
} from "@zkscatter/sdk/storage";

type Tab = "all" | RunCategory;
type SortKey = "date" | "total" | "recipients" | "claimed";
type SortDir = "asc" | "desc";

/** Default direction per column: dates / amounts read descending
 *  ("newest / largest first"); claim progress reads ascending so the
 *  unfinished work bubbles up. Operators that want the inverse flip
 *  with one more click. */
const DEFAULT_SORT_DIR: Record<SortKey, SortDir> = {
  date: "desc",
  total: "desc",
  recipients: "desc",
  claimed: "asc",
};

/** Compare for the sort key. `total` reuses `parseAmount` (same
 *  helper the wizard's Recipients step uses) so a record whose
 *  `totalAmount` was hand-edited to a `1_000` / whitespace-padded
 *  form sorts the same way it would total. NaN falls back to 0 so
 *  malformed entries land at the bottom of asc / top of desc rather
 *  than throwing off the comparator. */
function sortRuns(runs: RunsIndexEntry[], by: SortKey, dir: SortDir): RunsIndexEntry[] {
  const keyOf = (r: RunsIndexEntry): number => {
    switch (by) {
      case "date":
        return r.createdAt;
      case "total": {
        const n = parseAmount(r.totalAmount);
        return Number.isFinite(n) ? n : 0;
      }
      case "recipients":
        return r.totalRecipients;
      case "claimed":
        return r.totalRecipients > 0 ? r.claimedRecipients / r.totalRecipients : 0;
    }
  };
  // Stable sort: ties fall back to createdAt desc so two runs with the
  // same total / recipient count keep a predictable order.
  const out = [...runs];
  const m = dir === "asc" ? 1 : -1;
  out.sort((a, b) => {
    const diff = keyOf(a) - keyOf(b);
    if (diff !== 0) return diff * m;
    return b.createdAt - a.createdAt;
  });
  return out;
}

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
  const mounted = useMounted();
  const [tab, setTab] = useState<Tab>("all");
  const [runs, setRuns] = useState<RunsIndexEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [scope, setScope] = useState<"context" | "all-wallets">("context");
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Race guard: workspace switch + scope toggle + wallet change can
  // all trigger a fresh fetch. A slower earlier call resolving after
  // a newer one would overwrite `runs` with stale data, so we only
  // commit results from the latest request.
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);

    if (!folder.ready) {
      setRuns([]);
      setLoaded(true);
      return () => {
        cancelled = true;
      };
    }

    const filter: { chainId?: number; operatorAddress?: string } = {};
    if (wallet.chainId !== null) filter.chainId = wallet.chainId;
    if (scope === "context" && wallet.account) {
      filter.operatorAddress = wallet.account;
    }

    // The dashboard only needs the summary fields (label, counts,
    // amount, etc.) — `listRunsSummary` reads the cached
    // `zkscatter-runs-index.json` in a single I/O instead of
    // re-parsing every per-run file. The full record is still
    // available via `loadRun(id)` on the detail page.
    listRunsSummary(filter)
      .then((next) => {
        if (cancelled) return;
        setRuns(next);
      })
      .catch((e) => {
        if (cancelled) return;
        setRuns([]);
        setError(e instanceof Error ? e.message : "Failed to load runs");
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [folder.ready, folder.currentId, wallet.chainId, wallet.account, scope]);

  // Tab + search compose: tab narrows by category, search narrows
  // further by label / token symbol / id (substring, case-insensitive).
  // Stats derive from the unfiltered `runs` so the headline KPIs reflect
  // the whole scope, not whatever the operator happens to be looking at.
  const byTab = useMemo(
    () => (tab === "all" ? runs : runs.filter((r) => r.category === tab)),
    [runs, tab],
  );
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return byTab;
    return byTab.filter(
      (r) =>
        r.label.toLowerCase().includes(q) ||
        r.tokenSymbol.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q) ||
        // notesPreview is the truncated, whitespace-collapsed first
        // ~160 chars of the run's note. Long memos still match by
        // their first sentence — operators put the searchable label
        // ("Approved by CFO ref INV-2026-…") at the top anyway.
        (r.notesPreview ?? "").toLowerCase().includes(q),
    );
  }, [byTab, search]);
  const visible = useMemo(
    () => sortRuns(filtered, sortBy, sortDir),
    [filtered, sortBy, sortDir],
  );

  const onSort = (key: SortKey) => {
    if (key === sortBy) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(key);
      setSortDir(DEFAULT_SORT_DIR[key]);
    }
  };

  const stats = useMemo(() => deriveStats(runs, mounted), [runs, mounted]);

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

      <WorkspaceBar />

      <PoolBalanceCard />

      <ScopeBar scope={scope} setScope={setScope} wallet={wallet} folder={folder} />

      {/* items-start so the multi-token "This month" card sizes to its
          own content instead of stretching the sibling stat cards to
          match its height. */}
      <section className="grid grid-cols-3 items-start gap-4">
        <Stat
          label="This month"
          value={mounted ? <ThisMonthValue stats={stats} /> : "—"}
          sub={mounted ? formatThisMonthSub(stats) : "loading…"}
        />
        <Stat
          label="Pending claims"
          value={`${stats.pendingClaims}`}
          sub={`across ${runs.length} run${runs.length === 1 ? "" : "s"}`}
        />
        <Stat
          label={`Stale unclaimed (${STALE_THRESHOLD_DAYS}d+)`}
          value={`${stats.staleUnclaimed}`}
          sub={
            stats.staleUnclaimed === 0
              ? "no follow-ups needed"
              : `from ${stats.staleRunIds.length} run${
                  stats.staleRunIds.length === 1 ? "" : "s"
                } — consider resending`
          }
        />
      </section>

      {error && (
        <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
          Couldn&apos;t read your runs folder: {error}
        </div>
      )}

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-text-muted)]">Recent payouts</h2>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by label, token, id, or note…"
                aria-label="Search payouts"
                className="w-64 rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-1.5 text-xs"
              />
            </div>
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
        </div>
        <RunsList
          runs={visible}
          loaded={loaded}
          folderReady={folder.ready}
          tab={tab}
          searching={search.trim().length > 0}
          totalRuns={byTab.length}
          onClearSearch={() => setSearch("")}
          sortBy={sortBy}
          sortDir={sortDir}
          onSort={onSort}
        />
      </section>

      <DraftsSection wallet={wallet} />
    </div>
  );
}

/** Surface workspace-folder wizard drafts so the operator can resume
 *  an in-progress payout without guessing whether one exists. */
function DraftsSection({ wallet }: { wallet: ReturnType<typeof useWallet> }) {
  const mounted = useMounted();
  const folder = useFolderStorage();
  const [drafts, setDrafts] = useState<WizardDraft[]>([]);

  const refresh = useCallback(() => {
    if (!folder.ready) return;
    void loadAllWizardDrafts(wallet.account ?? null).then(setDrafts);
  }, [folder.ready, wallet.account]);

  useEffect(() => {
    if (!mounted) return;
    refresh();
    // Refresh on tab focus so a draft saved in another tab shows up
    // without a manual reload.
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [mounted, refresh]);

  if (!mounted) return null;
  if (drafts.length === 0) return null;

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold text-[var(--color-text-muted)]">
        Drafts ({drafts.length})
      </h2>
      <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)]">
        {drafts.map((d) => (
          <div
            key={`${d.operatorAddress}:${d.label}`}
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
          >
            <div>
              <div className="font-medium">{d.label || "(untitled)"}</div>
              <div className="text-xs text-[var(--color-text-muted)]">
                {d.templateId} · {d.token} · step {d.step}/5 · saved{" "}
                {formatRelativeAgo(d.savedAt)}
              </div>
            </div>
            <div className="flex gap-2">
              <Link
                href={`/payouts/new?label=${encodeURIComponent(d.label)}`}
                className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--color-primary-hover)]"
              >
                Continue →
              </Link>
              <button
                type="button"
                onClick={() => {
                  if (!window.confirm(`Discard draft "${d.label || "(untitled)"}"?`)) return;
                  void clearWizardDraft(d.operatorAddress, d.label).then(refresh);
                }}
                className="rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-xs hover:bg-[var(--color-warning-soft)]"
              >
                Discard
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
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
  const walletLabel = shortAddr(wallet.account) || "no wallet";
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
  searching,
  totalRuns,
  onClearSearch,
  sortBy,
  sortDir,
  onSort,
}: {
  runs: RunsIndexEntry[];
  loaded: boolean;
  folderReady: boolean;
  tab: Tab;
  searching: boolean;
  totalRuns: number;
  onClearSearch: () => void;
  sortBy: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
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
    if (searching && totalRuns > 0) {
      return (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-10 text-center text-sm text-[var(--color-text-muted)]">
          No runs match this search across {totalRuns} payout{totalRuns === 1 ? "" : "s"}.{" "}
          <button
            onClick={onClearSearch}
            className="text-[var(--color-primary)] underline-offset-2 hover:underline"
          >
            Clear search
          </button>
        </div>
      );
    }
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
      <SortHeader sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
      {runs.map((r) => (
        <RunRow key={r.id} entry={r} />
      ))}
    </div>
  );
}

function SortHeader({
  sortBy,
  sortDir,
  onSort,
}: {
  sortBy: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const arrow = (key: SortKey) => (sortBy === key ? (sortDir === "asc" ? "↑" : "↓") : "");
  const cls = (key: SortKey) =>
    `text-[10px] uppercase tracking-wider ${
      sortBy === key
        ? "text-[var(--color-text)] font-semibold"
        : "text-[var(--color-text-subtle)] hover:text-[var(--color-text-muted)]"
    }`;
  return (
    <div
      data-print="hide"
      className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-2 text-xs"
    >
      <button onClick={() => onSort("date")} className={cls("date")}>
        Date / label {arrow("date")}
      </button>
      <div className="flex items-center gap-6">
        <button onClick={() => onSort("recipients")} className={cls("recipients")}>
          Recipients {arrow("recipients")}
        </button>
        <button onClick={() => onSort("total")} className={cls("total")}>
          Total {arrow("total")}
        </button>
        <button onClick={() => onSort("claimed")} className={cls("claimed")}>
          Claimed {arrow("claimed")}
        </button>
      </div>
    </div>
  );
}

function RunRow({ entry }: { entry: RunsIndexEntry }) {
  const total = entry.totalRecipients;
  const claimed = entry.claimedRecipients;
  const unclaimed = total - claimed;
  // `entry.createdAt` is unix seconds (per `formatIsoDate(unixSec)`),
  // so compute age in seconds — `Date.now() - createdAt` would mix
  // ms and seconds and mark every run stale.
  const ageSec = Math.floor(Date.now() / 1000) - entry.createdAt;
  const isStale = unclaimed > 0 && ageSec >= STALE_THRESHOLD_DAYS * 86400;
  const date = formatIsoDate(entry.createdAt);
  const operatorTag = entry.operatorAddress
    ? shortAddr(entry.operatorAddress)
    : "(unknown wallet)";

  return (
    <Link
      href={`/payouts/detail?id=${entry.id}`}
      className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4 last:border-b-0 hover:bg-[var(--color-primary-soft)]"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{entry.label}</span>
          {entry.hasNotes && (
            <span
              title="This run has an internal note"
              aria-label="Has note"
              className="text-xs"
            >
              📝
            </span>
          )}
          <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
            {CATEGORY_BADGE[entry.category]}
          </span>
          <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
            chain {entry.chainId}
          </span>
        </div>
        <div className="text-xs text-[var(--color-text-muted)]">
          {date} · {total} recipient{total === 1 ? "" : "s"} · sent by {operatorTag}
        </div>
      </div>
      <div className="text-right">
        <div className="font-mono text-sm">
          {entry.totalAmount} {formatTokenLabel(entry.tokenSymbol)}
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
        {isStale && (
          <div
            title={`${unclaimed} recipient${
              unclaimed === 1 ? "" : "s"
            } haven't claimed in ${STALE_THRESHOLD_DAYS}+ days — consider resending the claim link.`}
            className="mt-1 inline-block rounded-full bg-[var(--color-warning-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-warning)]"
          >
            {unclaimed} stale ({STALE_THRESHOLD_DAYS}d+)
          </div>
        )}
      </div>
    </Link>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">{sub}</div>
    </div>
  );
}

interface DashboardStats {
  /** Per-token totals for the current month — keyed by symbol so a
   *  multi-token operator (USDC + TON) doesn't see an arithmetically
   *  meaningless mixed-unit sum. */
  thisMonthByToken: Record<string, number>;
  distinctTokens: number;
  pendingClaims: number;
  /** Recipients on runs older than `STALE_THRESHOLD_DAYS` whose
   *  claim hasn't landed. The count the operator can act on
   *  (resend, follow up) — distinct from `pendingClaims`, which
   *  also includes recipients whose links were just sent and
   *  haven't had a chance to be opened yet. */
  staleUnclaimed: number;
  /** Run ids contributing to `staleUnclaimed`, capped at a few so
   *  the action banner can name them without becoming a wall. */
  staleRunIds: string[];
}

const STALE_THRESHOLD_DAYS = 7;
const STALE_RUN_LIST_CAP = 3;

function deriveStats(runs: RunsIndexEntry[], mounted: boolean): DashboardStats {
  const thisMonthByToken: Record<string, number> = {};
  let pendingClaims = 0;
  let staleUnclaimed = 0;
  const staleRunIds: string[] = [];
  const tokens = new Set<string>();
  // `Date.now()` runs only after hydration so SSR doesn't see a
  // current-month filter the client would compute differently.
  const now = mounted ? new Date() : null;
  // `createdAt` is unix seconds; comparing against `Date.now()` (ms)
  // here would mark every run stale by a factor of 1000.
  const nowSec = now ? Math.floor(now.getTime() / 1000) : 0;
  const staleCutoffSec = STALE_THRESHOLD_DAYS * 86400;
  const thisMonthIso = now
    ? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
    : null;
  for (const r of runs) {
    tokens.add(r.tokenSymbol);
    const unclaimed = r.totalRecipients - r.claimedRecipients;
    pendingClaims += unclaimed;
    if (now && unclaimed > 0 && nowSec - r.createdAt >= staleCutoffSec) {
      staleUnclaimed += unclaimed;
      if (staleRunIds.length < STALE_RUN_LIST_CAP) staleRunIds.push(r.id);
    }
    if (thisMonthIso && formatIsoDate(r.createdAt).startsWith(thisMonthIso)) {
      // parseAmount returns NaN on a malformed total; treat that as
      // 0 so a single bad record doesn't poison the running sum
      // into NaN and blank out the headline.
      const n = parseAmount(r.totalAmount);
      thisMonthByToken[r.tokenSymbol] =
        (thisMonthByToken[r.tokenSymbol] ?? 0) + (Number.isFinite(n) ? n : 0);
    }
  }
  return {
    thisMonthByToken,
    distinctTokens: tokens.size,
    pendingClaims,
    staleUnclaimed,
    staleRunIds,
  };
}

/** "This month" volume — every token transacted this month, each on its
 *  own line (highest total first). Mixed units can't be summed into one
 *  number, so we list them rather than collapse to a single token. */
function ThisMonthValue({ stats }: { stats: DashboardStats }) {
  const entries = Object.entries(stats.thisMonthByToken).sort(
    (a, b) => b[1] - a[1],
  );
  if (entries.length === 0) return <>0</>;
  if (entries.length === 1) {
    const [symbol, total] = entries[0]!;
    return (
      <>
        {formatAmount(total)} {formatTokenLabel(symbol)}
      </>
    );
  }
  // Multiple tokens: stack them at a smaller size so they all fit the
  // card instead of hiding all but the top one.
  return (
    <div className="space-y-0.5 text-lg leading-tight">
      {entries.map(([symbol, total]) => (
        <div key={symbol}>
          {formatAmount(total)}{" "}
          <span className="text-sm font-normal text-[var(--color-text-muted)]">
            {formatTokenLabel(symbol)}
          </span>
        </div>
      ))}
    </div>
  );
}

function formatThisMonthSub(stats: DashboardStats): string {
  const count = Object.keys(stats.thisMonthByToken).length;
  if (count === 0) return "no runs this month";
  return `this month · ${count} token${count === 1 ? "" : "s"}`;
}

function formatAmount(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatIsoDate(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

