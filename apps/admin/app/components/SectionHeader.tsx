export function SectionHeader({
  title,
  badge,
  hint,
}: {
  title: string;
  badge: "live" | "mock" | "planned";
  hint?: string;
}) {
  const badgeClass =
    badge === "live"
      ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
      : badge === "planned"
        ? "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
        : "bg-[var(--color-bg)] text-[var(--color-text-subtle)]";
  return (
    <div className="mb-3 flex items-center gap-2">
      <h2 className="text-sm font-semibold text-[var(--color-text-muted)]">{title}</h2>
      <span
        className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${badgeClass}`}
      >
        {badge}
      </span>
      {hint && <span className="text-xs text-[var(--color-text-subtle)]">· {hint}</span>}
    </div>
  );
}
