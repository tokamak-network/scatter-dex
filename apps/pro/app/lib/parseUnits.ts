/** Parse a decimal token amount string into a base-units bigint
 *  without going through JavaScript's Number type — Number can't
 *  represent integers above 2^53 (so anything above ~9 ETH at
 *  18 decimals already loses precision) and rounds many decimals
 *  it can represent.
 *
 *  Mirrors `ethers.parseUnits` semantics:
 *  - Leading `-` rejected (use a sign-aware caller if needed).
 *  - Whitespace trimmed.
 *  - Exactly one optional `.` allowed.
 *  - Fractional digits beyond `decimals` are rejected to avoid
 *    silent truncation. */
export function parseUnits(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!trimmed) throw new Error("parseUnits: empty amount");
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("parseUnits: invalid number");
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(
      `parseUnits: too many fractional digits (${frac.length} > ${decimals})`,
    );
  }
  const padded = frac.padEnd(decimals, "0");
  // Strip the leading zeros from `whole` to keep BigInt happy with
  // shapes like "0001.5", but preserve "0".
  const wholeClean = whole!.replace(/^0+(?=\d)/, "");
  return BigInt(wholeClean + padded);
}
