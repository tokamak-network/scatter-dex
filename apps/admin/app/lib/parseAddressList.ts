/** Parse a free-form blob of addresses (comma / whitespace / newline
 *  separated) into a deduped array of 0x-prefixed hex strings. Used
 *  by the SanctionsList batch editor + any future "paste a list"
 *  admin surface. Returns invalid entries separately so the caller
 *  can show row-level errors. */
const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;

export interface ParsedAddressList {
  valid: string[];
  invalid: string[];
}

export function parseAddressList(input: string): ParsedAddressList {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  // Split on any non-hex separator (comma, whitespace, newline, semicolon).
  for (const raw of input.split(/[\s,;]+/)) {
    const tok = raw.trim();
    if (!tok) continue;
    if (!HEX_ADDR.test(tok)) {
      invalid.push(tok);
      continue;
    }
    const lower = tok.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    valid.push(tok);
  }
  return { valid, invalid };
}
