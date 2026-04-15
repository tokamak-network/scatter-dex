"use client";

interface Item<K extends string> {
  key: K;
  label: string;
  help?: string;
}

interface Props<K extends string> {
  items: ReadonlyArray<Item<K>>;
  value: K;
  onChange: (v: K) => void;
  size?: "sm" | "md";
}

/**
 * Pill-style group of mutually-exclusive buttons. Used by the leaderboard
 * (metric + window toggles) and the per-relayer Trade Stats card (window
 * toggle). Kept generic (`K extends string`) so each callsite can pass
 * its own discriminated union and keep type safety on `value`/`onChange`.
 */
export default function SegmentedToggle<K extends string>({ items, value, onChange, size = "md" }: Props<K>) {
  const padding = size === "sm" ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-xs";
  return (
    <div className="inline-flex rounded-lg bg-surface-container border border-outline-variant/15 overflow-hidden">
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => onChange(it.key)}
          title={it.help}
          className={`${padding} transition-colors ${
            value === it.key
              ? "bg-primary text-on-primary font-semibold"
              : "text-on-surface-variant hover:bg-surface-bright/40"
          }`}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
