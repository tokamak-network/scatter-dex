/** Centralised error explainer for ethers v6 + plain Error throws.
 *  Each admin write panel routes its catch through this so reverts
 *  / RPC errors / validation failures surface with the same copy.
 *  Pulls `shortMessage` (the ethers human-readable summary) when
 *  available; falls back to the raw `message`.
 *
 *  Truncates pathological inputs (multi-line stack traces, JSON-RPC
 *  payloads that ethers occasionally inlines into `message`) so a
 *  single rogue error can't blow out the admin layout. The clamp is
 *  generous enough to keep contract revert reasons intact.
 */
const MAX_LEN = 400;

export function explainError(err: unknown): string {
  const raw = extractMessage(err);
  // Strip newlines/tabs — multi-line stack traces or JSON-formatted
  // RPC errors otherwise wreck the inline error banners. Collapse
  // runs of whitespace so the truncation length matches what the
  // operator actually reads.
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_LEN ? `${oneLine.slice(0, MAX_LEN)}…` : oneLine;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) {
    const sm = (err as { shortMessage?: string }).shortMessage;
    if (typeof sm === "string" && sm.length > 0) return sm;
    return err.message;
  }
  if (typeof err === "string") return err;
  return String(err);
}
