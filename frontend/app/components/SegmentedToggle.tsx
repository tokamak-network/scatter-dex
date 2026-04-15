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
  /** Screen-reader label for the toggle group (e.g. "Metric", "Time window"). */
  ariaLabel?: string;
}

/**
 * Pill-style group of mutually-exclusive buttons. Used by the leaderboard
 * (metric + window toggles) and the per-relayer Trade Stats card (window
 * toggle). Kept generic (`K extends string`) so each callsite can pass
 * its own discriminated union and keep type safety on `value`/`onChange`.
 *
 * Exposes role="group" + aria-pressed for screen readers, and explicit
 * type="button" so the component is safe to drop inside a <form> without
 * accidentally submitting.
 */
export default function SegmentedToggle<K extends string>({ items, value, onChange, size = "md", ariaLabel }: Props<K>) {
  const padding = size === "sm" ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-xs";
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex rounded-lg bg-surface-container border border-outline-variant/15 overflow-hidden"
    >
      {items.map((it) => {
        const selected = value === it.key;
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onChange(it.key)}
            title={it.help}
            aria-pressed={selected}
            className={`${padding} transition-colors ${
              selected
                ? "bg-primary text-on-primary font-semibold"
                : "text-on-surface-variant hover:bg-surface-bright/40"
            }`}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
