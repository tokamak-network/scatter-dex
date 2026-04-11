const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Generate a cryptographically random BN254 field element as decimal string. */
export function generateRandomField(): string {
  let value: bigint;
  do {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    bytes[0] &= 0x0f; // cap to ~252 bits to minimize rejection
    value = 0n;
    for (const b of bytes) {
      value = (value << 8n) | BigInt(b);
    }
  } while (value >= FIELD_MODULUS);
  return value.toString();
}
