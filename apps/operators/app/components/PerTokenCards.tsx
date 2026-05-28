/**
 * Shared per-token Volume/Revenue card pair used by /dashboard and
 * /analytics so the two surfaces stay visually consistent with each
 * other AND with the leaderboard breakdown (same TokenChip palette,
 * same "one amount per row, count in the subtitle" shape).
 */

"use client";

import { formatAmount, tokenInfo } from "../lib/tokenRegistry";
import { netAfterPlatformFee } from "../lib/usePlatformFeeBps";

export interface FeeTotal {
  token: string;
  count: number;
  totalWei: string;
}

export interface VolumeTotal {
  token: string;
  sellFills: number;
  buyFills: number;
  totalSellWei: string;
  totalBuyWei: string;
}

/** Per-token sell-leg notional. The buy leg is the counterparty's
 *  symmetric throughput; surfacing both per row was visually noisy
 *  (two different units in one row) so we collapse to the sell leg
 *  only — what THIS relayer's users brought into settlement. */
export function VolumeCard({ volume }: { volume: { totals: VolumeTotal[] } | null }) {
  if (!volume) return <CardPlaceholder title="Volume" />;
  // Drop tokens that only appeared on the buy leg in this window. A
  // pure-buy token has no sell-leg notional, so rendering it here
  // with amount=0 alongside a settles count > 0 misleads the
  // operator into thinking we routed sell-side flow we didn't.
  // The counterparty's Volume card carries those rows on the other
  // side of the trade.
  const rows = volume.totals
    .filter((r) => safeBig(r.totalSellWei) > 0n)
    .sort((a, b) => {
      const ai = safeBig(a.totalSellWei);
      const bi = safeBig(b.totalSellWei);
      return ai > bi ? -1 : ai < bi ? 1 : 0;
    });
  // sellFills is one row per confirmed on-chain settle for the token —
  // matches what Operations(24h) reports, so the two numbers tie out.
  const settles = rows.reduce((n, r) => n + r.sellFills, 0);
  return (
    <PerTokenCard
      title="Volume"
      subtitle={`sell-leg notional · ${tokenCountLabel(rows.length)}${settles > 0 ? ` · ${settles} settle${settles === 1 ? "" : "s"}` : ""}`}
      emptyMsg="No settlements in this window."
      rows={rows.map((r) => {
        const info = tokenInfo(r.token);
        return {
          key: r.token,
          token: r.token,
          symbol: info.symbol,
          amount: formatAmount(r.totalSellWei, info.decimals),
        };
      })}
    />
  );
}

/** Per-token fee revenue (maker + taker + scatterDirect summed).
 *  Rows show gross with a secondary "net X" line when
 *  `platformFeeBps` is known — that's the share the relayer actually
 *  keeps after `FeeVault.claim()` takes the platform cut. The count
 *  is "fee rows" (per-side accruals), so a same-relayer match
 *  contributes 2 rows. */
export function RevenueCard({
  fees,
  platformFeeBps = null,
}: {
  fees: { totals: FeeTotal[] } | null;
  platformFeeBps?: number | null;
}) {
  if (!fees) return <CardPlaceholder title="Revenue" />;
  const rows = [...fees.totals].sort((a, b) => {
    const ai = safeBig(a.totalWei);
    const bi = safeBig(b.totalWei);
    return ai > bi ? -1 : ai < bi ? 1 : 0;
  });
  const feeRows = rows.reduce((n, r) => n + r.count, 0);
  const cutLabel =
    platformFeeBps !== null && platformFeeBps > 0
      ? ` · net of ${(platformFeeBps / 100).toFixed(2)}% platform fee`
      : "";
  return (
    <PerTokenCard
      title="Revenue"
      subtitle={`fee earned · ${tokenCountLabel(rows.length)}${feeRows > 0 ? ` · ${feeRows} fee row${feeRows === 1 ? "" : "s"}` : ""}${cutLabel}`}
      emptyMsg="No fees in this window."
      rows={rows.map((r) => {
        const info = tokenInfo(r.token);
        const netWei = netAfterPlatformFee(r.totalWei, platformFeeBps);
        return {
          key: r.token,
          token: r.token,
          symbol: info.symbol,
          amount: formatAmount(r.totalWei, info.decimals),
          secondary:
            netWei !== null && platformFeeBps !== null && platformFeeBps > 0
              ? `net ${formatAmount(netWei, info.decimals)}`
              : undefined,
        };
      })}
    />
  );
}

interface PerTokenRow {
  key: string;
  token: string;
  symbol: string;
  amount: string;
  /** Optional second-line label rendered under the primary amount —
   *  used to surface the net-after-platform-fee figure without
   *  taking a whole extra row. */
  secondary?: string;
}

function PerTokenCard({
  title,
  subtitle,
  emptyMsg,
  rows,
}: {
  title: string;
  subtitle: string;
  emptyMsg: string;
  rows: PerTokenRow[];
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide">{title}</h3>
        <span className="text-[10px] text-[var(--color-text-subtle)]">{subtitle}</span>
      </div>
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--color-text-muted)]">{emptyMsg}</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {rows.map((r) => (
            <li
              key={r.key}
              className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] pt-2 first:border-t-0 first:pt-0"
            >
              <div className="flex min-w-0 items-center gap-2">
                <TokenChip symbol={r.symbol} />
                <span
                  className="truncate font-mono text-[10px] text-[var(--color-text-subtle)]"
                  title={r.token}
                >
                  {r.token}
                </span>
              </div>
              <div className="flex shrink-0 flex-col items-end">
                <span className="font-mono text-sm font-semibold">{r.amount}</span>
                {r.secondary && (
                  <span className="font-mono text-[10px] text-[var(--color-text-subtle)]">
                    {r.secondary}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CardPlaceholder({ title }: { title: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <h3 className="text-sm font-semibold uppercase tracking-wide">{title}</h3>
      <p className="mt-4 text-sm text-[var(--color-text-muted)]">Loading…</p>
    </div>
  );
}

/** Same palette as the leaderboard so an operator scanning across
 *  pages tags assets by the same colour every time. Unknown symbols
 *  fall back to neutral slate. */
function TokenChip({ symbol }: { symbol: string }) {
  const palette: Record<string, string> = {
    ETH: "bg-blue-100 text-blue-800 border-blue-300",
    WETH: "bg-blue-100 text-blue-800 border-blue-300",
    USDC: "bg-emerald-100 text-emerald-800 border-emerald-300",
    USDT: "bg-teal-100 text-teal-800 border-teal-300",
    TON: "bg-amber-100 text-amber-800 border-amber-300",
  };
  const cls = palette[symbol.toUpperCase()] ?? "bg-slate-100 text-slate-700 border-slate-300";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cls}`}
    >
      {symbol}
    </span>
  );
}

function tokenCountLabel(n: number): string {
  return `${n} token${n === 1 ? "" : "s"}`;
}

function safeBig(s: string): bigint {
  try { return BigInt(s); } catch { return 0n; }
}
