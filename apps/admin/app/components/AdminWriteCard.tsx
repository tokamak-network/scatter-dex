"use client";

import { type ReactNode } from "react";
import { useAdminWrite, WriteStatus } from "../lib/useAdminWrite";

interface Props {
  title: string;
  description?: string;
  /** Label for the submit button when ready. */
  submitLabel: string;
  /** Optional second action (e.g. "Cancel" / "Remove"). */
  secondaryLabel?: string;
  /** When true, disable the submit button regardless of phase. */
  disabled?: boolean;
  secondaryDisabled?: boolean;
  /** Thunk that submits the primary write. */
  onSubmit: () => Promise<{ hash: string; wait(): Promise<{ hash?: string } | null> }>;
  /** Optional secondary thunk (e.g. cancel a scheduled change). */
  onSecondary?: () => Promise<{ hash: string; wait(): Promise<{ hash?: string } | null> }>;
  /** Called after a confirmed tx so the parent can refresh reads. */
  onSuccess?: () => void;
  /** Inputs + read-out for this admin action. */
  children: ReactNode;
}

/** Container card for a single admin write action. Standardises:
 *   - section header + description
 *   - connect-wallet prompt when no account
 *   - submit button with submitting/idle states
 *   - optional secondary action (cancel-style)
 *   - status banner on confirm / error
 *  Callers focus on the inputs + thunks; everything else is shared. */
export function AdminWriteCard({
  title,
  description,
  submitLabel,
  secondaryLabel,
  disabled,
  secondaryDisabled,
  onSubmit,
  onSecondary,
  onSuccess,
  children,
}: Props) {
  const { phase, account, connect, run } = useAdminWrite(onSuccess);
  const busy = phase.kind === "submitting";

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && (
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">{description}</p>
        )}
      </div>
      <div className="space-y-3">{children}</div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {!account ? (
          <button
            type="button"
            onClick={() => void connect()}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg)]"
          >
            Connect admin wallet
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => void run(onSubmit)}
              className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Submitting…" : submitLabel}
            </button>
            {secondaryLabel && onSecondary && (
              <button
                type="button"
                disabled={secondaryDisabled || busy}
                onClick={() => void run(onSecondary)}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg)] disabled:opacity-50"
              >
                {secondaryLabel}
              </button>
            )}
          </>
        )}
      </div>
      <WriteStatus phase={phase} />
    </div>
  );
}
