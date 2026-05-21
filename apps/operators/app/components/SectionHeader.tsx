/** Section heading with a live/mock/loading badge. The dashboard
 *  pages surface a mix of on-chain and (for now) mock-tagged data
 *  while the indexer is wired up; the badge keeps it unambiguous
 *  which is which without burying the disclaimer in copy. The
 *  `loading` variant tags a section that is mid-fetch — pages like
 *  /admin/identity flip it to `live` once the indexer settles, so
 *  the operator can tell "data not arrived yet" apart from
 *  "intentionally stubbed." Hint text is optional and renders
 *  inline after the badge. */
export type SectionHeaderBadge = "live" | "mock" | "loading";

export function SectionHeader({
  title,
  badge,
  hint,
}: {
  title: string;
  badge: SectionHeaderBadge;
  hint?: string;
}) {
  const badgeClass =
    badge === "live"
      ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
      : badge === "loading"
        ? "bg-[var(--color-bg)] text-[var(--color-text-muted)]"
        : "bg-[var(--color-bg)] text-[var(--color-text-subtle)]";
  const label = badge === "loading" ? "loading…" : badge;
  return (
    <div className="mb-3 flex items-center gap-2">
      <h2 className="text-sm font-semibold text-[var(--color-text-muted)]">{title}</h2>
      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${badgeClass}`}>
        {label}
      </span>
      {hint && <span className="text-xs text-[var(--color-text-subtle)]">· {hint}</span>}
    </div>
  );
}
