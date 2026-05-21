"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export interface PaletteCommand {
  /** Stable ID — used as React key and for telemetry. */
  id: string;
  /** Display label shown in the list. Should read as an imperative
   *  ("Pause relayer", not "Pause"). */
  label: string;
  /** Optional secondary line — a short hint about what the command
   *  does or its current state ("running", "11/128 sanctioned", etc.). */
  hint?: string;
  /** Extra terms the fuzzy match should consider — e.g. an action
   *  whose label says "Resume" might also match "unpause". */
  keywords?: readonly string[];
  /** Section bucket header in the listing. Commands are rendered in
   *  the order they appear in the input array; the section header is
   *  emitted whenever this value changes between adjacent items. */
  section: string;
  /** Async handler. Errors propagate to the caller's toast — the
   *  palette closes optimistically on Enter so the user sees the
   *  next-action UI immediately. */
  run: () => Promise<void> | void;
}

/**
 * Cmd+K (⌘K / Ctrl+K) action palette for the /runtime page. Operators
 * frequently bounce between 9 sections; the palette cuts the cycle by
 * letting them fuzzy-search a verb and hit Enter — both for cheap
 * navigation ("Jump to Sanctions") and for one-shot mutations
 * ("Pause relayer", "Send test webhook"). Parameterised actions
 * (e.g. "Set fee bps 25") stay in the dedicated section forms — the
 * palette is for muscle-memory primitives, not a CLI.
 */
export function CommandPalette({
  commands,
  open,
  onClose,
}: {
  commands: readonly PaletteCommand[];
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset to a clean state on every open so the previous session's
  // typed query doesn't linger. Focusing in the same effect avoids
  // a layout-flush race against the modal's mount transition.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    inputRef.current?.focus();
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => {
      const hay = [c.label, c.hint ?? "", ...(c.keywords ?? [])]
        .join(" ")
        .toLowerCase();
      // Subsequence match: every char in the query must appear in
      // order somewhere in the haystack. Lets "psr" match "pause
      // relayer" without the operator typing the whole verb.
      let i = 0;
      for (const ch of hay) {
        if (ch === q[i]) i += 1;
        if (i === q.length) return true;
      }
      return false;
    });
  }, [commands, query]);

  // Clamp the active index whenever the filtered list shrinks below
  // it — without this, hitting Enter after a typo would index past
  // the array end and silently no-op.
  useEffect(() => {
    if (active >= filtered.length) setActive(Math.max(0, filtered.length - 1));
  }, [filtered.length, active]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(filtered.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[active];
      if (!cmd) return;
      onClose();
      // Run after close so an error path is free to show its own
      // modal/toast without overlapping the palette overlay.
      void Promise.resolve(cmd.run()).catch((err) => {
        console.error("[palette] command failed", err);
      });
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24"
      onClick={onClose}
      onKeyDown={onKeyDown}
    >
      <div
        className="w-[560px] max-w-[92vw] overflow-hidden rounded-lg border border-[var(--color-border-strong)] bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          placeholder="Run a command — e.g. pause, drain, jump to logs…"
          aria-label="Command query"
          className="w-full border-b border-[var(--color-border)] bg-white px-4 py-3 text-sm outline-none"
        />
        <ul role="listbox" className="max-h-[60vh] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <li className="px-4 py-3 text-xs text-[var(--color-text-muted)]">
              No commands match.
            </li>
          )}
          {filtered.map((c, i) => {
            const prev = i > 0 ? filtered[i - 1] : null;
            const showSection = !prev || prev.section !== c.section;
            const selected = i === active;
            return (
              <Row
                key={c.id}
                cmd={c}
                showSection={showSection}
                selected={selected}
                onHover={() => setActive(i)}
                onClick={() => {
                  onClose();
                  void Promise.resolve(c.run()).catch((err) => {
                    console.error("[palette] command failed", err);
                  });
                }}
              />
            );
          })}
        </ul>
        <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 text-[10px] text-[var(--color-text-subtle)]">
          ↑ ↓ navigate · Enter run · Esc close
        </div>
      </div>
    </div>
  );
}

function Row({
  cmd,
  showSection,
  selected,
  onHover,
  onClick,
}: {
  cmd: PaletteCommand;
  showSection: boolean;
  selected: boolean;
  onHover: () => void;
  onClick: () => void;
}) {
  return (
    <>
      {showSection && (
        <li
          aria-hidden
          className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-subtle)]"
        >
          {cmd.section}
        </li>
      )}
      <li
        role="option"
        aria-selected={selected}
        onMouseEnter={onHover}
        onClick={onClick}
        className={`cursor-pointer px-4 py-2 text-sm ${
          selected ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)]" : ""
        }`}
      >
        <div className="font-medium">{cmd.label}</div>
        {cmd.hint && (
          <div className="text-[11px] text-[var(--color-text-muted)]">{cmd.hint}</div>
        )}
      </li>
    </>
  );
}

/** Mounts a `keydown` listener that flips `open` on ⌘K / Ctrl+K and
 *  exposes a setter for explicit open/close (button trigger, etc.).
 *  Returns the state pair so the host component can pass them
 *  straight into `<CommandPalette>`. */
export function useCommandPalette(): {
  open: boolean;
  setOpen: (v: boolean) => void;
} {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Match both macOS ⌘K and Windows/Linux Ctrl+K. `e.metaKey` is
      // also set on platforms with a meta key (some Linux setups),
      // so checking both still selects only the K binding.
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return { open, setOpen };
}
