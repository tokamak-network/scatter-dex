/** Centralised error explainer for ethers v6 + plain Error throws.
 *  Each admin write panel routes its catch through this so reverts
 *  / RPC errors / validation failures surface with the same copy.
 *  Pulls `shortMessage` (the ethers human-readable summary) when
 *  available; falls back to the raw `message`.
 */
export function explainError(err: unknown): string {
  if (err instanceof Error) {
    const sm = (err as { shortMessage?: string }).shortMessage;
    return sm ?? err.message;
  }
  return String(err);
}
