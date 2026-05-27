"use client";

/** Horizontal stepper for the /register wizard. Each step carries a
 *  derived `status` (`done` | `active` | `blocked`); the parent
 *  computes those from the form's gating state so the indicator
 *  stays a pure projection of model truth.
 *
 *  Visual: tablet-and-up shows label + status pill; mobile collapses
 *  to a number circle so the row doesn't wrap. */
export type StepStatus = "done" | "active" | "blocked";

export interface StepDef {
  id: 1 | 2 | 3;
  title: string;
  status: StepStatus;
  /** Short caption shown under the title — e.g. "Verified until …" or
   *  "Probing…". Omitted on `blocked` so the row stays tidy. */
  caption?: string;
}

export function Stepper({ steps, current }: { steps: StepDef[]; current: 1 | 2 | 3 }) {
  return (
    <ol
      role="list"
      className="flex items-stretch gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-sm"
    >
      {steps.map((s, i) => (
        <li key={s.id} className="flex flex-1 items-stretch">
          <StepChip step={s} isCurrent={s.id === current} />
          {i < steps.length - 1 && (
            <span
              aria-hidden
              className="mx-1 self-center text-[var(--color-text-subtle)]"
            >
              →
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

function StepChip({ step, isCurrent }: { step: StepDef; isCurrent: boolean }) {
  const styles = chipStyles(step.status, isCurrent);
  return (
    <div
      className={`flex flex-1 items-center gap-3 rounded-lg px-3 py-2 ${styles.wrap}`}
      aria-current={isCurrent ? "step" : undefined}
    >
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${styles.bubble}`}
      >
        {step.status === "done" ? "✓" : step.id}
      </span>
      <div className="min-w-0 flex-1">
        <div className={`text-sm font-medium ${styles.title}`}>{step.title}</div>
        {step.caption && (
          <div className={`truncate text-[10px] ${styles.caption}`}>
            {step.caption}
          </div>
        )}
      </div>
    </div>
  );
}

function chipStyles(status: StepStatus, isCurrent: boolean): {
  wrap: string;
  bubble: string;
  title: string;
  caption: string;
} {
  if (status === "done") {
    return {
      wrap: "border border-[var(--color-success)] bg-[var(--color-success-soft)]",
      bubble: "bg-[var(--color-success)] text-white",
      title: "text-[var(--color-text)]",
      caption: "text-[var(--color-text-muted)]",
    };
  }
  if (status === "active" || isCurrent) {
    return {
      wrap: "border border-[var(--color-primary)] bg-[var(--color-primary-soft)]",
      bubble: "bg-[var(--color-primary)] text-white",
      title: "text-[var(--color-text)]",
      caption: "text-[var(--color-text-muted)]",
    };
  }
  return {
    wrap: "border border-[var(--color-border)] bg-[var(--color-bg)] opacity-70",
    bubble: "bg-[var(--color-surface-muted)] text-[var(--color-text-subtle)] border border-[var(--color-border-strong)]",
    title: "text-[var(--color-text-subtle)]",
    caption: "text-[var(--color-text-subtle)]",
  };
}
