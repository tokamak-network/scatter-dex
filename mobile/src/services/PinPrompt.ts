/**
 * PinPrompt — Promise-based bridge between non-React services
 * (KeySecurityService, etc.) and the in-tree `<PinPromptHost />` modal.
 *
 * Why an event emitter instead of `useContext`: the auth gate is called
 * from background flows (boot hydration, transaction signing) where we
 * may not be inside a React render tree at the call site. The host
 * component subscribes once at app root and resolves the queued promise
 * when the user finishes — same shape as `Alert.alert(...)` but typed.
 */
import { EventEmitter } from 'events';

export type PinPromptMode =
  | { kind: 'verify'; reason: string }
  | { kind: 'enroll'; reason: string }
  | { kind: 'reset'; reason: string };

export type PinPromptResult =
  | { ok: true; pin: string }
  | { ok: false; reason: 'cancelled' | 'locked_out' | 'unavailable' };

type PendingRequest = {
  mode: PinPromptMode;
  resolve: (r: PinPromptResult) => void;
};

const emitter = new EventEmitter();
// Only PinPromptHost subscribes (one open + one close listener). Cap
// it explicitly so a future regression that forgets cleanup raises a
// loud warning instead of silently leaking listeners.
emitter.setMaxListeners(2);
let pending: PendingRequest | null = null;

export const PinPromptBus = {
  request(mode: PinPromptMode): Promise<PinPromptResult> {
    // Single-flight: if a prompt is already up, queue would be incorrect
    // — gates are serial, so a second request while one is open means a
    // logic bug or a re-entrant call. Reject the new one rather than
    // silently dropping the old.
    if (pending) {
      return Promise.resolve({ ok: false, reason: 'unavailable' });
    }
    return new Promise((resolve) => {
      pending = { mode, resolve };
      try {
        emitter.emit('open', mode);
      } catch {
        // A listener throw must not leave `pending` set — that would
        // wedge every subsequent request on `'unavailable'`.
        pending = null;
        resolve({ ok: false, reason: 'unavailable' });
      }
    });
  },

  resolve(result: PinPromptResult): void {
    if (!pending) return;
    const r = pending.resolve;
    pending = null;
    emitter.emit('close');
    r(result);
  },

  current(): PinPromptMode | null {
    return pending?.mode ?? null;
  },

  on(event: 'open' | 'close', handler: (mode?: PinPromptMode) => void) {
    emitter.on(event, handler);
    return () => { emitter.off(event, handler); };
  },
};
