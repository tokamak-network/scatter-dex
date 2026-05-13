"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { APP_BY_ID, type AppEntry } from "../lib/apps";

type Goal = "trade" | "pay" | "distribute" | "explore";
type Platform = "web" | "mobile" | "either";

function recommend(goal: Goal | null, platform: Platform | null): AppEntry {
  if (platform === "mobile") return APP_BY_ID.mobile;
  if (goal === "trade") return APP_BY_ID.pro;
  if (goal === "pay") return APP_BY_ID.pay;
  if (goal === "distribute") return APP_BY_ID.drop;
  // goal === "explore" — pro is the broadest web entry; mobile-or-either
  // visitors get the all-in-one Mobile app.
  return platform === "web" ? APP_BY_ID.pro : APP_BY_ID.mobile;
}

export function Recommender({ className = "" }: { className?: string }) {
  const [goal, setGoal] = useState<Goal | null>(null);
  const [platform, setPlatform] = useState<Platform | null>(null);
  const ready = goal !== null && platform !== null;
  const pick = ready ? recommend(goal, platform) : null;

  return (
    <div className={`space-y-8 ${className}`}>
      <Question
        label="What are you trying to do?"
        value={goal}
        onChange={setGoal}
        options={[
          { v: "trade", label: "Trade" },
          { v: "pay", label: "Pay people" },
          { v: "distribute", label: "Distribute tokens" },
          { v: "explore", label: "Just explore" },
        ]}
      />
      <Question
        label="Web or mobile?"
        value={platform}
        onChange={setPlatform}
        options={[
          { v: "web", label: "Web" },
          { v: "mobile", label: "Mobile" },
          { v: "either", label: "Either" },
        ]}
      />
      {pick && (
        <div
          className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
          style={{ borderLeftWidth: 4, borderLeftColor: pick.accent }}
        >
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-subtle)]">
            We recommend
          </div>
          <div className="mt-1 text-2xl font-semibold tracking-tight">
            zkScatter <span style={{ color: pick.accent }}>{pick.name}</span>
          </div>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">{pick.persona}</p>
          {pick.comingSoon ? (
            // Recommendation stands but the CTA is non-clickable —
            // pointing the user at a hosting-disabled target would
            // 404. Matches `AppCard.tsx`'s comingSoon treatment.
            // No `aria-disabled` since this is a static label, not
            // a disabled control — the attribute is ignored on a
            // plain `<span>` without an interactive role.
            <span
              className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-2 text-sm font-medium text-[var(--color-text-muted)]"
            >
              Coming soon
            </span>
          ) : (
            <Link
              href={pick.href}
              className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
            >
              {pick.cta}
              <ArrowRight className="h-4 w-4" />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function Question<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T | null;
  onChange: (v: T) => void;
  options: { v: T; label: string }[];
}) {
  return (
    <div>
      <div className="text-sm font-medium">{label}</div>
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((o) => {
          const active = value === o.v;
          return (
            <button
              key={o.v}
              onClick={() => onChange(o.v)}
              className={
                "rounded-full border px-4 py-1.5 text-sm transition " +
                (active
                  ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white"
                  : "border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)]")
              }
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
