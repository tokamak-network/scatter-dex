/** Best-effort overwrite of secret material in a Uint8Array.
 *
 *  Useful for keypair / signature buffers that we want to keep
 *  out of GC scan paths once we're done with them. Does **not**
 *  protect against:
 *  - copies the runtime made for V8 small-string interning
 *  - JIT optimization passes that re-materialize the buffer
 *  - same-process attackers with arbitrary read
 *
 *  It's worth the call (cheap, makes core dumps less interesting)
 *  but should not be treated as a strong erasure primitive. */
export function wipeBytes(buf: Uint8Array): void {
  // `fill(0)` lowers to a single memset on V8; no need to loop.
  buf.fill(0);
}
