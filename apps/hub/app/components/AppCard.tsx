import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SURFACE_LABEL, type AppEntry } from "../lib/apps";

export function AppCard({ app }: { app: AppEntry }) {
  return (
    <Link
      href={app.href}
      className="group relative flex flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 transition hover:border-[var(--color-border-strong)] hover:shadow-md"
    >
      <span
        className="absolute left-0 top-0 h-full w-1"
        style={{ background: app.accent }}
        aria-hidden
      />
      <div className="flex items-center justify-between">
        <span
          className="inline-block h-8 w-8 rounded"
          style={{ background: app.accent }}
          aria-hidden
        />
        <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          {app.audience === "operator" ? "For operators" : SURFACE_LABEL[app.surface]}
        </span>
      </div>
      <div className="mt-4 text-2xl font-semibold tracking-tight">
        zkScatter <span style={{ color: app.accent }}>{app.name}</span>
      </div>
      <p className="mt-2 text-base font-medium text-[var(--color-text)]">{app.tagline}</p>
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">{app.persona}</p>
      <ul className="mt-5 space-y-1.5 text-sm text-[var(--color-text-muted)]">
        {app.bullets.map((b) => (
          <li key={b} className="flex gap-2">
            <span className="mt-2 inline-block h-1 w-1 rounded-full bg-[var(--color-text-subtle)]" />
            {b}
          </li>
        ))}
      </ul>
      <div className="mt-6 flex items-center gap-1.5 text-sm font-medium text-[var(--color-text)] group-hover:gap-2.5 transition-all">
        {app.cta}
        <ArrowRight className="h-4 w-4" />
      </div>
    </Link>
  );
}
