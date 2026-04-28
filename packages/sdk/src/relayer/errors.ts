/** Read the named error off ethers v6 contract-call exceptions
 *  when the ABI carries the matching error fragment. Falls back to
 *  null so callers can substring-match the message instead. Shared
 *  by every per-contract `explainXxxError` in the relayer module. */
export function callExceptionErrorName(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { revert?: { name?: string } | null; errorName?: string };
  return e.revert?.name ?? e.errorName ?? null;
}

/** Best-effort unwrap of an ethers v6 error to a human-readable
 *  string. v6 surfaces the user-facing summary on `shortMessage`,
 *  the decoded revert reason on `reason`, and the underlying
 *  provider error on `info.error.message`. Fall through these in
 *  priority order before landing on the raw `Error.message` so
 *  callers (read-side error banners, write-side `explainXxxError`)
 *  always have the most descriptive string available. */
export function unwrapEthersError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & {
    shortMessage?: string;
    reason?: string;
    info?: { error?: { message?: string } };
  };
  return e.shortMessage ?? e.reason ?? e.info?.error?.message ?? err.message;
}
