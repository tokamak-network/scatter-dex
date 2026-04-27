"use client";

import Link from "next/link";
import { useState } from "react";

type Window = "24h" | "7d" | "30d" | "all";
type Metric = "settlements" | "successRate" | "volume";

interface Row {
  rank: number;
  address: string;
  name: string;
  online: boolean;
  feeBps: number;
  settlements: number;
  successRate: number;
  volumeUsd: string;
  isMe?: boolean;
}

const ROWS: Record<Window, Row[]> = {
  "24h": [
    { rank: 1, address: "0x12…ab", name: "ZeroDelay",      online: true,  feeBps: 25, settlements: 412, successRate: 99.2, volumeUsd: "1.4M" },
    { rank: 2, address: "0xA1…f4", name: "Acme Relayer",   online: true,  feeBps: 30, settlements: 384, successRate: 98.7, volumeUsd: "1.2M", isMe: true },
    { rank: 3, address: "0x88…c2", name: "PrivateRoute",   online: true,  feeBps: 35, settlements: 321, successRate: 97.0, volumeUsd: "0.9M" },
    { rank: 4, address: "0x4f…91", name: "BlockNova",      online: true,  feeBps: 30, settlements: 280, successRate: 96.4, volumeUsd: "0.8M" },
    { rank: 5, address: "0xb1…e7", name: "QuietBook",      online: false, feeBps: 40, settlements: 102, successRate: 92.1, volumeUsd: "0.3M" },
  ],
  "7d": [
    { rank: 1, address: "0x12…ab", name: "ZeroDelay",      online: true,  feeBps: 25, settlements: 2812, successRate: 99.0, volumeUsd: "9.6M" },
    { rank: 2, address: "0x88…c2", name: "PrivateRoute",   online: true,  feeBps: 35, settlements: 2410, successRate: 97.8, volumeUsd: "7.1M" },
    { rank: 3, address: "0xA1…f4", name: "Acme Relayer",   online: true,  feeBps: 30, settlements: 2104, successRate: 98.2, volumeUsd: "6.8M", isMe: true },
    { rank: 4, address: "0x4f…91", name: "BlockNova",      online: true,  feeBps: 30, settlements: 1980, successRate: 96.1, volumeUsd: "5.4M" },
    { rank: 5, address: "0xb1…e7", name: "QuietBook",      online: false, feeBps: 40, settlements: 712,  successRate: 91.8, volumeUsd: "2.0M" },
  ],
  "30d": [
    { rank: 1, address: "0x88…c2", name: "PrivateRoute",   online: true,  feeBps: 35, settlements: 10240, successRate: 97.6, volumeUsd: "31.2M" },
    { rank: 2, address: "0x12…ab", name: "ZeroDelay",      online: true,  feeBps: 25, settlements: 9812,  successRate: 98.9, volumeUsd: "29.4M" },
    { rank: 3, address: "0xA1…f4", name: "Acme Relayer",   online: true,  feeBps: 30, settlements: 8104,  successRate: 98.0, volumeUsd: "24.1M", isMe: true },
    { rank: 4, address: "0x4f…91", name: "BlockNova",      online: true,  feeBps: 30, settlements: 7980,  successRate: 95.8, volumeUsd: "21.0M" },
    { rank: 5, address: "0xb1…e7", name: "QuietBook",      online: false, feeBps: 40, settlements: 3120,  successRate: 90.5, volumeUsd: "8.4M"  },
  ],
  "all": [
    { rank: 1, address: "0x12…ab", name: "ZeroDelay",      online: true,  feeBps: 25, settlements: 81204, successRate: 98.5, volumeUsd: "240M" },
    { rank: 2, address: "0x88…c2", name: "PrivateRoute",   online: true,  feeBps: 35, settlements: 72100, successRate: 97.2, volumeUsd: "210M" },
    { rank: 3, address: "0xA1…f4", name: "Acme Relayer",   online: true,  feeBps: 30, settlements: 51020, successRate: 97.9, volumeUsd: "162M", isMe: true },
    { rank: 4, address: "0x4f…91", name: "BlockNova",      online: true,  feeBps: 30, settlements: 48010, successRate: 95.4, volumeUsd: "140M" },
    { rank: 5, address: "0xb1…e7", name: "QuietBook",      online: false, feeBps: 40, settlements: 19000, successRate: 89.8, volumeUsd: "52M"  },
  ],
};

const WINDOWS: { key: Window; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "7d",  label: "7d"  },
  { key: "30d", label: "30d" },
  { key: "all", label: "All" },
];

const METRICS: { key: Metric; label: string }[] = [
  { key: "settlements", label: "Settlements" },
  { key: "successRate", label: "Success rate" },
  { key: "volume",      label: "Volume" },
];

export default function LeaderboardPage() {
  const [window, setWindow] = useState<Window>("7d");
  const [metric, setMetric] = useState<Metric>("settlements");
  const rows = ROWS[window];
  const me = rows.find((r) => r.isMe);

  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Leaderboard</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Network-wide relayer ranking. Your relayer is highlighted. Sourced
            from the shared orderbook indexer.
          </p>
        </div>
        <Link href="/dashboard" className="text-sm text-[var(--color-primary)] hover:underline">
          ← Dashboard
        </Link>
      </header>

      <section className="grid grid-cols-3 gap-4">
        <Stat label="Your rank" value={me ? `#${me.rank}` : "—"} sub={`Window: ${window}`} />
        <Stat label="Active relayers" value={String(rows.length)} sub="Network" />
        <Stat label="Median fee" value="30 bps" sub="0.30%" />
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Toggle items={METRICS} value={metric} onChange={setMetric} />
        <span className="ml-2 text-xs text-[var(--color-text-subtle)]">·</span>
        <Toggle items={WINDOWS} value={window} onChange={setWindow} />
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
            <tr>
              <th className="px-5 py-3 text-left">#</th>
              <th className="px-5 py-3 text-left">Relayer</th>
              <th className="px-5 py-3 text-left">Address</th>
              <th className="px-5 py-3 text-right">Fee</th>
              <th className="px-5 py-3 text-right">Settlements</th>
              <th className="px-5 py-3 text-right">Success</th>
              <th className="px-5 py-3 text-right">Volume</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.address}
                className={`border-t border-[var(--color-border)] ${r.isMe ? "bg-[var(--color-primary-soft)]" : ""}`}
              >
                <td className="px-5 py-3 font-semibold">{r.rank}</td>
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${r.online ? "bg-[var(--color-success)]" : "bg-[var(--color-text-subtle)]"}`} />
                    <span className="font-medium">{r.name}</span>
                    {r.isMe && (
                      <span className="rounded-full bg-[var(--color-primary)] px-2 py-0.5 text-[10px] font-medium text-white">
                        you
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-5 py-3 font-mono text-xs text-[var(--color-text-muted)]">{r.address}</td>
                <td className="px-5 py-3 text-right">{(r.feeBps / 100).toFixed(2)}%</td>
                <td className="px-5 py-3 text-right font-mono">{r.settlements.toLocaleString()}</td>
                <td className="px-5 py-3 text-right font-mono">{r.successRate.toFixed(1)}%</td>
                <td className="px-5 py-3 text-right font-mono">${r.volumeUsd}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-[var(--color-text-subtle)]">
        Ranking served from the shared indexer. Wired through SDK{" "}
        <code className="font-mono">loadActiveRelayers()</code> + indexer in v1.1.
      </p>
    </div>
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

function Toggle<T extends string>({
  items, value, onChange,
}: {
  items: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => onChange(it.key)}
          className={
            value === it.key
              ? "rounded-full bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-white"
              : "rounded-full px-3 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          }
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
