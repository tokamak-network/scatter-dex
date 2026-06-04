"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useWallet, shortAddr } from "@zkscatter/sdk/react";
import {
  claimRelayerFees,
  explainFeeVaultError,
  type FeeVaultBalance,
} from "@zkscatter/sdk/relayer";
import { Stat } from "../components/Stat";
import { SectionHeader } from "../components/SectionHeader";
import { OperatorIdentityBar } from "../components/OperatorIdentityBar";
import { WriteResult } from "../components/WriteResult";
import { DEMO_NETWORK } from "../lib/network";
import { formatRelative, formatRelativeFuture, formatTokenAmount } from "../lib/format";
import { adminGet, type AdminAuth, readAdminAuth } from "../lib/adminApi";
import { useChainWrite } from "../lib/useChainWrite";
import { useFeeVault, type FeeVaultState } from "../lib/useFeeVault";

const VAULT = DEMO_NETWORK.contracts.feeVault;

type Auth = AdminAuth | null;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface FeeRow {
  id: number;
  tx_hash: string;
  side: "maker" | "taker" | "scatterDirect";
  token: string;
  amount_wei: string;
  block_number: number | null;
  created_at: number;
}

interface FeeTotalsBody {
  totals: Array<{ token: string; count: number; totalWei: string }>;
}

export default function TreasuryPage() {
  const vault = useFeeVault();
  const ph = vaultPlaceholder(vault);
  const nonZero = ph ? [] : vault.balances.filter((b) => b.balance > 0n);

  return (
    <div className="space-y-10">
      <OperatorIdentityBar />
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Earnings</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Fee revenue accrued to your relayer in the FeeVault contract.
            Claim any time — gas paid by you. Platform fee is deducted on
            claim. (Not to be confused with{" "}
            <code className="font-mono">RelayerRegistry.treasury()</code>,
            which is the platform&apos;s own fee-recipient address.)
          </p>
        </div>
        <Link href="/dashboard" className="text-sm text-[var(--color-primary)] hover:underline">
          ← Dashboard
        </Link>
      </header>

      <PendingFeeChangeBanner vault={vault} />

      <section>
        <SectionHeader title="On-chain" badge="live" />
        <div className="grid grid-cols-3 gap-4">
          <Stat
            label="Claimable now"
            value={ph ? ph.value : `${nonZero.length} ${nonZero.length === 1 ? "token" : "tokens"}`}
            sub={ph ? ph.sub : nonZero.length === 0 ? "Nothing accrued yet" : "Claim row-by-row below"}
          />
          <Stat
            label="Tokens tracked"
            value={ph ? ph.value : String(vault.balances.length)}
            sub={ph ? ph.sub : "From network whitelist"}
          />
          <Stat
            label="Platform fee"
            value={platformFeeValue(vault, ph)}
            sub={platformFeeSub(vault, ph)}
          />
        </div>
      </section>

      <section>
        <SectionHeader title="Per-token balances" badge="live" />
        <BalancesTable vault={vault} placeholder={ph} />
        <p className="mt-2 text-xs text-[var(--color-text-subtle)]">
          Claims call <code className="font-mono">FeeVault.claim(token)</code>.
          Tokens come from the network whitelist; the indexer trail will replace
          this once event scanning ships.
        </p>
      </section>

      <FeeAccrualSection vault={vault} />
    </div>
  );
}

function FeeAccrualSection({ vault }: { vault: FeeVaultState }) {
  const [auth, setAuth] = useState<Auth>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setAuth(readAdminAuth());
    setHydrated(true);
  }, []);

  if (!hydrated) return null;
  if (!auth) {
    return (
      <section>
        <SectionHeader title="Fee accrual" badge="live" hint="Auth required" />
        <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
          Connect your relayer on{" "}
          <Link href="/dashboard" className="text-[var(--color-primary)] underline">
            /dashboard
          </Link>{" "}
          (or{" "}
          <Link href="/runtime" className="text-[var(--color-primary)] underline">
            /runtime
          </Link>
          ) to load fee history. Auth is shared across the tab; on-chain
          claimable balances above don&apos;t need it.
        </div>
      </section>
    );
  }
  return <FeeAccrualLive auth={auth} vault={vault} />;
}

function FeeAccrualLive({
  auth,
  vault,
}: {
  auth: NonNullable<Auth>;
  vault: FeeVaultState;
}) {
  const [totals, setTotals] = useState<FeeTotalsBody | null>(null);
  const [recent, setRecent] = useState<FeeRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const since = Date.now() - THIRTY_DAYS_MS;
      const [t, r] = await Promise.all([
        adminGet<FeeTotalsBody>(auth, "/api/admin/history/fees"),
        adminGet<{ rows: FeeRow[] }>(
          auth,
          `/api/admin/history/fees?detail=1&limit=20&since=${since}`,
        ),
      ]);
      setTotals(t);
      setRecent(r.rows);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [auth]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Map token-list addresses (lowercase) to symbol/decimals so the
  // fee rows can be rendered in human units. The vault page already
  // hydrates this list — reuse it instead of round-tripping a fresh
  // request for token metadata.
  const tokenMeta = new Map<string, { symbol: string; decimals: number }>();
  for (const b of vault.balances) {
    tokenMeta.set(b.token.address.toLowerCase(), {
      symbol: b.token.symbol,
      decimals: b.token.decimals,
    });
  }

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <SectionHeader title="Fee accrual" badge="live" />
        <button
          onClick={refresh}
          disabled={loading}
          className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="rounded-md bg-[var(--color-warning-soft)] px-3 py-2 text-xs text-[var(--color-warning)]">
          Failed to load fee history: {error}
        </div>
      )}

      <div>
        <div className="mb-2 text-xs uppercase tracking-wider text-[var(--color-text-subtle)]">
          Lifetime totals (per token)
        </div>
        {!totals ? (
          <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>
        ) : totals.totals.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            No fees accrued yet — settle some orders and they&apos;ll show up
            here. Distinct from the FeeVault balance above: this is what
            you&apos;ve <em>earned</em>; the vault balance is what is
            currently <em>claimable</em>.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
                <tr>
                  <th className="px-5 py-3 text-left">Token</th>
                  <th
                    className="px-5 py-3 text-right"
                    title="fee_history row count. settleAuth records two rows per settlement (maker + taker); scatterDirectAuth records one."
                  >
                    Fee events
                  </th>
                  <th className="px-5 py-3 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {totals.totals.map((t) => {
                  const meta = tokenMeta.get(t.token);
                  return (
                    <tr key={t.token} className="border-t border-[var(--color-border)]">
                      <td className="px-5 py-3">
                        <div className="font-medium">{meta?.symbol ?? "Unknown"}</div>
                        <div className="font-mono text-xs text-[var(--color-text-muted)]">
                          {shortAddr(t.token)}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-right font-mono">{t.count}</td>
                      <td className="px-5 py-3 text-right font-mono">
                        {meta
                          ? formatTokenAmount(BigInt(t.totalWei), meta.decimals)
                          : `${t.totalWei} (raw)`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 text-xs uppercase tracking-wider text-[var(--color-text-subtle)]">
          Recent fee events (last 30 days)
        </div>
        {!recent ? (
          <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>
        ) : recent.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            No fee events in the last 30 days.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
                <tr>
                  <th className="px-5 py-3 text-left">When</th>
                  <th className="px-5 py-3 text-left">Side</th>
                  <th className="px-5 py-3 text-left">Token</th>
                  <th className="px-5 py-3 text-right">Amount</th>
                  <th className="px-5 py-3 text-left">Tx</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => {
                  const meta = tokenMeta.get(r.token);
                  return (
                    <tr key={r.id} className="border-t border-[var(--color-border)]">
                      <td className="px-5 py-3 text-xs text-[var(--color-text-muted)]">
                        {formatRelative(r.created_at)}
                      </td>
                      <td className="px-5 py-3 text-xs">{r.side}</td>
                      <td className="px-5 py-3 font-mono text-xs">
                        {meta?.symbol ?? shortAddr(r.token)}
                      </td>
                      <td className="px-5 py-3 text-right font-mono text-xs">
                        {meta
                          ? formatTokenAmount(BigInt(r.amount_wei), meta.decimals)
                          : `${r.amount_wei} (raw)`}
                      </td>
                      <td className="px-5 py-3">
                        <Link
                          href={`/orders/detail?tx=${r.tx_hash}`}
                          className="font-mono text-xs text-[var(--color-primary)] hover:underline"
                        >
                          {shortAddr(r.tx_hash)}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}


/** Render bps as a percentage with up to 2 fractional digits, trailing
 *  zeros stripped. `30` → `"0.3%"`, `100` → `"1%"`, `1025` → `"10.25%"`.
 *  Null means the one-shot read hasn't returned yet. Bps values are
 *  bounded by `MAX_PLATFORM_FEE` in the contract, so we don't need
 *  scientific-notation fallbacks. Exported for tests. */
export function formatPlatformFee(bps: number | null): string {
  if (bps === null) return "…";
  if (bps === 0) return "0%";
  const pct = bps / 100;
  return `${pct.toFixed(2).replace(/\.?0+$/, "")}%`;
}

/** Pick the value for the Platform fee stat. Mirrors `vaultPlaceholder`
 *  for the wallet/vault-deployed/balances-read paths so the stat reads
 *  the same as its neighbors when the vault isn't loadable; otherwise
 *  reports any platform-fee-specific RPC error explicitly, and only
 *  falls back to `formatPlatformFee` once the read has actually run. */
function platformFeeValue(state: FeeVaultState, ph: VaultPlaceholder | null): string {
  if (ph) return ph.value;
  if (state.platformFeeError) return "—";
  return formatPlatformFee(state.platformFeeBps);
}

function platformFeeSub(state: FeeVaultState, ph: VaultPlaceholder | null): string {
  if (ph) return ph.sub;
  if (state.platformFeeError) return `Read error: ${state.platformFeeError}`;
  if (state.platformFeeBps === null) return "Reading on-chain…";
  return "Skimmed on every claim()";
}

interface VaultPlaceholder { value: string; sub: string }

function vaultPlaceholder(state: FeeVaultState): VaultPlaceholder | null {
  if (!state.account) return { value: "—", sub: "Connect wallet to load" };
  if (!state.vaultDeployed) return { value: "—", sub: "FeeVault not deployed" };
  if (state.loading) return { value: "…", sub: "Reading vault" };
  if (state.error) return { value: "—", sub: `Read error: ${state.error}` };
  return null;
}

const BALANCE_COLUMNS = 5;

function BalancesTable({
  vault,
  placeholder,
}: {
  vault: FeeVaultState;
  placeholder: VaultPlaceholder | null;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full text-sm">
        <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
          <tr>
            <th className="px-5 py-3 text-left">Token</th>
            <th className="px-5 py-3 text-right">Claimable</th>
            <th className="px-5 py-3 text-right">Platform cut</th>
            <th className="px-5 py-3 text-right">You receive</th>
            <th className="px-5 py-3 text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {placeholder && <EmptyRow message={placeholder.sub} />}
          {!placeholder && vault.balances.length === 0 && (
            <EmptyRow message="No tokens configured on this network yet." />
          )}
          {!placeholder && vault.balances.map((b) => (
            <BalanceRow
              key={b.token.address}
              entry={b}
              platformFeeBps={vault.platformFeeBps}
              onClaimed={vault.refresh}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyRow({ message }: { message: string }) {
  return (
    <tr className="border-t border-[var(--color-border)]">
      <td colSpan={BALANCE_COLUMNS} className="px-5 py-6 text-center text-sm text-[var(--color-text-muted)]">
        {message}
      </td>
    </tr>
  );
}

function BalanceRow({
  entry,
  platformFeeBps,
  onClaimed,
}: {
  entry: FeeVaultBalance;
  platformFeeBps: number | null;
  onClaimed: () => void;
}) {
  const { signer } = useWallet();
  const write = useChainWrite({ explain: explainFeeVaultError, onSuccess: onClaimed });
  const { token, balance } = entry;
  const empty = balance === 0n;
  const submitting = write.phase.kind === "submitting";
  const [copied, setCopied] = useState(false);
  const onCopyAddress = () => {
    // navigator.clipboard is undefined on insecure origins / old browsers,
    // and writeText can reject on denied permissions — guard + catch both.
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(token.address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch((err) => console.error("Failed to copy address:", err));
  };

  // Compute the on-claim split — what the platform skims vs. what
  // hits the relayer's treasury — so the operator sees the actual
  // post-claim outcome instead of having to do the bps math
  // themselves. Falls back to "—" when bps is null (RPC hasn't
  // landed yet) so the row stays readable in the loading state.
  const split = computeClaimSplit(balance, platformFeeBps);

  const onClaim = () => {
    if (!signer || !VAULT) return;
    write.run(() => claimRelayerFees(VAULT, token.address, signer));
  };

  return (
    <tr className="border-t border-[var(--color-border)] align-top">
      <td className="px-5 py-3">
        <div className="font-medium">{token.symbol}</div>
        <button
          type="button"
          onClick={onCopyAddress}
          title={token.address}
          className="font-mono text-[10px] text-[var(--color-text-subtle)] hover:text-[var(--color-primary)] cursor-pointer transition-colors"
        >
          {copied ? "Copied!" : shortAddr(token.address)}
        </button>
      </td>
      <td className="px-5 py-3 text-right font-mono">
        {formatTokenAmount(balance, token.decimals)}
      </td>
      <td className="px-5 py-3 text-right font-mono text-xs text-[var(--color-text-muted)]">
        {split.platform === null ? "—" : `−${formatTokenAmount(split.platform, token.decimals)}`}
      </td>
      <td className="px-5 py-3 text-right font-mono">
        {split.net === null ? "—" : formatTokenAmount(split.net, token.decimals)}
      </td>
      <td className="px-5 py-3 text-right">
        <button
          disabled={empty || submitting || !signer}
          onClick={onClaim}
          className="rounded-lg bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-border)] disabled:text-[var(--color-text-subtle)]"
        >
          {submitting ? "Claiming…" : "Claim"}
        </button>
        <WriteResult phase={write.phase} />
      </td>
    </tr>
  );
}

/** Apply the platform bps to a gross balance and return the
 *  {platform, net} split. Null bps → both null so the row falls
 *  back to "—" instead of pretending it knows the split. The math
 *  is intentionally bigint so values past 2^53 don't lose precision
 *  in the display. */
function computeClaimSplit(
  balance: bigint,
  bps: number | null,
): { platform: bigint | null; net: bigint | null } {
  if (bps === null || !Number.isFinite(bps) || bps < 0 || bps > 10_000) {
    return { platform: null, net: null };
  }
  const platform = (balance * BigInt(bps)) / 10_000n;
  return { platform, net: balance - platform };
}


/** Banner above the On-chain stats that warns the operator about a
 *  scheduled platform-fee change. Renders nothing when no change is
 *  pending so the page stays clean in the common case. Surfaces
 *  current → new bps + the unix-second effective time so the
 *  operator can decide whether to claim before or after the change
 *  lands (claiming after a hike means a smaller net payout).
 *
 *  Effective time is rendered as both a relative ("in 6h") and
 *  absolute timestamp so the operator can plan against their own
 *  timezone without doing the math. */
function PendingFeeChangeBanner({ vault }: { vault: FeeVaultState }) {
  // Gate every time/locale-sensitive computation behind a mount
  // flag so SSR renders a stable placeholder and the client takes
  // over after hydration — without this, `Date.now()` /
  // `toLocaleString()` disagree between server and client and
  // trip React's hydration mismatch warning.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const pending = vault.pendingFeeChange;
  if (!pending) return null;
  const effectiveMs = pending.effectiveAt * 1000;
  const isReady = mounted && effectiveMs <= Date.now();
  const currentBps = vault.platformFeeBps;
  const delta =
    currentBps !== null
      ? pending.bps > currentBps
        ? "increase"
        : pending.bps < currentBps
          ? "decrease"
          : "unchanged"
      : null;
  const tone =
    delta === "increase"
      ? "bg-[var(--color-warning-soft)] border-[var(--color-warning)] text-[var(--color-warning)]"
      : delta === "decrease"
        ? "bg-[var(--color-success-soft)] border-[var(--color-success)] text-[var(--color-success)]"
        : "bg-[var(--color-bg)] border-[var(--color-border-strong)] text-[var(--color-text)]";
  return (
    <section className={`rounded-xl border-l-4 px-5 py-4 ${tone}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="text-sm font-semibold uppercase tracking-wide">
            Platform fee {isReady ? "change is ready to apply" : "change scheduled"}
          </div>
          <p className="mt-1 text-xs">
            {currentBps !== null && (
              <>
                Current: <strong className="font-mono">{(currentBps / 100).toFixed(2)}%</strong>{" "}
                →{" "}
              </>
            )}
            New: <strong className="font-mono">{(pending.bps / 100).toFixed(2)}%</strong>
            {delta === "increase" && " (your net per claim will drop)"}
            {delta === "decrease" && " (your net per claim will rise)"}
          </p>
        </div>
        <div className="text-right text-xs">
          <div className="font-mono text-sm font-semibold">
            {!mounted
              ? "…"
              : isReady
                ? "Ready now"
                : formatRelativeFuture(effectiveMs)}
          </div>
          <div className="text-[var(--color-text-muted)]">
            {mounted ? new Date(effectiveMs).toLocaleString() : "…"}
          </div>
        </div>
      </div>
      {delta === "increase" && !isReady && (
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          Tip: claim any pending balances before the cutover to keep
          today&apos;s rate. Once the change applies, all future
          claims (including currently-accrued balances) use the new
          rate.
        </p>
      )}
    </section>
  );
}
