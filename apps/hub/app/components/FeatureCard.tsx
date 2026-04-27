import type { LucideIcon } from "lucide-react";

export function FeatureCard({
  icon: Icon,
  eyebrow,
  title,
  body,
}: {
  icon?: LucideIcon;
  eyebrow?: string;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      {Icon ? <Icon className="h-5 w-5 text-[var(--color-text)]" /> : null}
      {eyebrow ? (
        <div className="font-mono text-xs text-[var(--color-text-subtle)]">
          {eyebrow}
        </div>
      ) : null}
      <div className={`${Icon ? "mt-4" : "mt-2"} text-lg font-semibold`}>
        {title}
      </div>
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">{body}</p>
    </div>
  );
}
