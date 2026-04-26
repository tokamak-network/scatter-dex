"use client";

import type { ReactNode } from "react";

interface EmptyStateProps {
  children: ReactNode;
  /** When set, renders a primary action below the message. */
  action?: { label: string; onClick: () => void };
  /** Layout knob — `compact` for inline list slots (vault notes,
   *  open orders), `default` for full-page empty states. */
  size?: "compact" | "default";
}

/** Empty-list fallback. Replaces the inline dashed-border block
 *  pattern that lived in MyPositionPanel and the workbench / orders
 *  pages. Standardises the visual + the optional CTA shape so every
 *  empty state in the app reads the same. */
export function EmptyState({ children, action, size = "compact" }: EmptyStateProps) {
  const padding = size === "compact" ? "p-3 text-xs" : "p-6 text-sm";
  return (
    <div
      className={`rounded-md border border-dashed border-[var(--color-border)] text-center text-[var(--color-text-muted)] ${padding}`}
    >
      <div>{children}</div>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-2 text-xs font-medium text-[var(--color-primary)] hover:underline"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
