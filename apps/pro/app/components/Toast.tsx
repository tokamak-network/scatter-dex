"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastKind = "success" | "error" | "info";

export interface ToastInput {
  kind: ToastKind;
  title: string;
  /** Optional secondary line. */
  description?: string;
  /** Optional CTA — clicking dismisses the toast and runs `onClick`. */
  action?: { label: string; onClick: () => void };
  /** Auto-dismiss after this many ms (default 5000). 0 = sticky. */
  durationMs?: number;
}

interface ToastEntry extends ToastInput {
  id: string;
}

interface ToastApi {
  push(t: ToastInput): string;
  dismiss(id: string): void;
}

const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

const DEFAULT_DURATION_MS = 5_000;
/** Cap concurrent toasts. A buggy caller looping `push` should not
 *  pin unbounded memory or render thousands of cards. Oldest drops. */
const MAX_TOASTS = 5;

function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  // Track active timers so dismiss() can clear and unmount doesn't leak.
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setToasts((prev) => (prev.some((x) => x.id === id) ? prev.filter((x) => x.id !== id) : prev));
  }, []);

  const push = useCallback(
    (t: ToastInput) => {
      const id = newId();
      const entry: ToastEntry = { ...t, id };
      setToasts((prev) => {
        const next = [...prev, entry];
        if (next.length <= MAX_TOASTS) return next;
        // Cancel the dropped entries' timers so they don't fire
        // dismiss against a no-longer-present id.
        for (const dropped of next.slice(0, next.length - MAX_TOASTS)) {
          const t = timers.current.get(dropped.id);
          if (t !== undefined) {
            clearTimeout(t);
            timers.current.delete(dropped.id);
          }
        }
        return next.slice(-MAX_TOASTS);
      });
      const ms = t.durationMs ?? DEFAULT_DURATION_MS;
      if (ms > 0) {
        const handle = setTimeout(() => dismiss(id), ms);
        timers.current.set(id, handle);
      }
      return id;
    },
    [dismiss],
  );

  // Capture timer map for cleanup. Reading `.current` inside the
  // returned cleanup is correct because the ref identity is stable.
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const handle of map.values()) clearTimeout(handle);
      map.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2"
      >
        {toasts.map((t) => (
          <ToastCard key={t.id} entry={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

function ToastCard({ entry, onDismiss }: { entry: ToastEntry; onDismiss: () => void }) {
  const accent =
    entry.kind === "success"
      ? "border-[var(--color-success)] bg-[var(--color-success-soft)]"
      : entry.kind === "error"
      ? "border-[var(--color-danger)] bg-white"
      : "border-[var(--color-border-strong)] bg-white";
  const titleColor =
    entry.kind === "success"
      ? "text-[var(--color-success)]"
      : entry.kind === "error"
      ? "text-[var(--color-danger)]"
      : "text-[var(--color-text)]";

  return (
    <div
      role={entry.kind === "error" ? "alert" : "status"}
      className={`pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-md ${accent}`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className={`font-semibold ${titleColor}`}>{entry.title}</div>
          {entry.description && (
            <div className="mt-0.5 break-words text-xs text-[var(--color-text-muted)]">
              {entry.description}
            </div>
          )}
          {entry.action && (
            <button
              onClick={() => {
                entry.action!.onClick();
                onDismiss();
              }}
              className="mt-2 text-xs font-medium text-[var(--color-primary)] hover:underline"
            >
              {entry.action.label}
            </button>
          )}
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="rounded p-0.5 text-[var(--color-text-subtle)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
        >
          ×
        </button>
      </div>
    </div>
  );
}
