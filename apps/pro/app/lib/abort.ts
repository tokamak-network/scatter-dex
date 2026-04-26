/** Was the error a cancellation (AbortSignal triggered)? Checks by
 *  exception type / name rather than message string — message text
 *  isn't a stable contract across DOMException implementations. */
export function isAbortError(e: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (typeof DOMException !== "undefined" && e instanceof DOMException) {
    return e.name === "AbortError";
  }
  return (e as Error)?.name === "AbortError";
}

/** Sleep that honors an AbortSignal — rejects with AbortError when
 *  the signal fires, instead of resolving and letting the caller
 *  silently mutate state after a cancel.
 *
 *  Listener is registered before scheduling the timer so an abort
 *  landing in the gap can't leave the promise hanging. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
  });
}
