/** Parse a free-form blob of addresses (separated by whitespace,
 *  comma, semicolon, or newline) into a deduped array of lowercase
 *  0x-prefixed hex strings. Used by the SanctionsList batch editor +
 *  any future "paste a list" admin surface. Returns invalid entries
 *  (including the zero address, which contracts treat as a no-op
 *  sentinel) separately so the caller can show row-level errors. */
const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS_LOWER = "0x0000000000000000000000000000000000000000";

export interface ParsedAddressList {
  valid: string[];
  invalid: string[];
}

export function parseAddressList(input: string): ParsedAddressList {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  // Split on any non-hex separator (whitespace, comma, semicolon, newline).
  for (const raw of input.split(/[\s,;]+/)) {
    const tok = raw.trim();
    if (!tok) continue;
    if (!HEX_ADDR.test(tok)) {
      invalid.push(tok);
      continue;
    }
    const lower = tok.toLowerCase();
    // Reject the zero address up-front so the batch summary count
    // matches what the contract will actually act on. SanctionsList
    // skips address(0) inside its batch loop, which would otherwise
    // make the UI claim "N entries added" when the chain sees N-1.
    if (lower === ZERO_ADDRESS_LOWER) {
      invalid.push(tok);
      continue;
    }
    if (seen.has(lower)) continue;
    seen.add(lower);
    valid.push(lower);
  }
  return { valid, invalid };
}
