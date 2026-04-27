/** Read the named error off ethers v6 contract-call exceptions
 *  when the ABI carries the matching error fragment. Falls back to
 *  null so callers can substring-match the message instead. Shared
 *  by every per-contract `explainXxxError` in the relayer module. */
export function callExceptionErrorName(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { revert?: { name?: string } | null; errorName?: string };
  return e.revert?.name ?? e.errorName ?? null;
}
