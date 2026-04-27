"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Modal } from "@zkscatter/ui";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** When true, the confirm button uses warning colour to flag a
   *  destructive action (resetting form state, wiping local
   *  identity, etc.). Default false (regular primary button). */
  danger?: boolean;
}

interface UseConfirm {
  /** Open the confirm dialog. Resolves `true` when the user
   *  confirms, `false` on cancel / backdrop / escape. Multiple
   *  parallel calls are not supported — the most recent overrides
   *  the previous prompt. */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  /** Render this somewhere in the consumer's tree (typically once,
   *  at the root of the page). The Modal mounts a portal so its
   *  position in the JSX doesn't matter. */
  dialog: React.ReactNode;
}

/** Modal-backed replacement for `window.confirm()`. Native confirm
 *  is OS-styled, blocks the JS thread, and can't carry brand styling
 *  / danger framing — switch to this for any user-facing confirm
 *  on the Pro app surface. */
export function useConfirm(): UseConfirm {
  const [state, setState] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    // Resolve any in-flight prompt as cancelled — taking on a new
    // confirm while one is already open implies the prior one is
    // moot. Avoids dangling promises.
    resolverRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setState(opts);
    });
  }, []);

  const settle = useCallback((result: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setState(null);
    resolve?.(result);
  }, []);

  // Resolve any in-flight prompt as cancelled if the host
  // component unmounts mid-confirm (e.g. user navigates away).
  // Otherwise the awaiting `await confirm(...)` would hang and
  // any code after it — including `finally` cleanups — never runs.
  useEffect(() => {
    return () => {
      resolverRef.current?.(false);
      resolverRef.current = null;
    };
  }, []);

  const dialog = state ? (
    <Modal open onClose={() => settle(false)} title={state.title}>
      <p className="text-sm text-[var(--color-text-muted)]">{state.message}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={() => settle(false)}>
          {state.cancelLabel ?? "Cancel"}
        </Button>
        <Button
          variant={state.danger ? "danger" : "primary"}
          onClick={() => settle(true)}
        >
          {state.confirmLabel ?? "Confirm"}
        </Button>
      </div>
    </Modal>
  ) : null;

  return { confirm, dialog };
}
