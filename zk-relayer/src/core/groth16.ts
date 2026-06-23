/**
 * Shared Groth16 verification helpers for the relayer's off-chain pre-flight
 * checks (authorize orders + claims).
 *
 * Both paths verify a snarkjs proof that arrives in Solidity calldata format —
 * crucially, `pi_b`'s coordinate pairs are reversed for the on-chain verifier's
 * layout and must be swapped back before snarkjs will accept them. Getting that
 * reversal wrong silently rejects every valid proof, so it lives in ONE place
 * (`buildSnarkProof`) instead of being copy-pasted per circuit.
 */

import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

// ESM has no `__dirname` global; derive it from the module URL (same pattern as
// private-submitter.ts) so the vkey paths resolve under both tsx and the
// compiled build.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** snarkjs proof object (Groth16 / bn128). */
export interface SnarkProof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: "groth16";
  curve: "bn128";
}

/**
 * Convert a Solidity-formatted proof (string or bigint components, `pi_b`
 * reversed) into the native snarkjs shape. Accepts `string | bigint` so both
 * the authorize path (decimal strings) and the claim path (bigints) share it.
 */
export function buildSnarkProof(
  a: readonly [unknown, unknown],
  b: readonly [readonly [unknown, unknown], readonly [unknown, unknown]],
  c: readonly [unknown, unknown],
): SnarkProof {
  const s = (x: unknown) => String(x);
  return {
    pi_a: [s(a[0]), s(a[1]), "1"],
    // Un-reverse each pi_b pair: Solidity calldata stores [x1, x0]; snarkjs
    // wants [x0, x1].
    pi_b: [
      [s(b[0][1]), s(b[0][0])],
      [s(b[1][1]), s(b[1][0])],
      ["1", "0"],
    ],
    pi_c: [s(c[0]), s(c[1]), "1"],
    protocol: "groth16",
    curve: "bn128",
  };
}

/**
 * Lazily load and cache a circuit's per-tier verification key from
 * `circuits/build/<circuit>{,_64,_128}_vkey.json`. `cache` is supplied by the
 * caller so each verifier keeps its own tier→vkey map.
 */
export function loadCircuitVkey(
  cache: Map<number, unknown>,
  circuit: string,
  tier: number,
): unknown {
  let vkey = cache.get(tier);
  if (!vkey) {
    const suffix = tier === 16 ? "" : `_${tier}`;
    const vkeyPath = path.join(
      moduleDir,
      `../../../circuits/build/${circuit}${suffix}_vkey.json`,
    );
    vkey = JSON.parse(readFileSync(vkeyPath, "utf8"));
    cache.set(tier, vkey);
  }
  return vkey;
}

/**
 * Verify a Solidity-formatted Groth16 proof against its public signals.
 * Returns the snarkjs boolean; throws only if snarkjs itself does.
 */
export async function verifyGroth16Solidity(
  vkey: unknown,
  publicSignals: string[],
  a: readonly [unknown, unknown],
  b: readonly [readonly [unknown, unknown], readonly [unknown, unknown]],
  c: readonly [unknown, unknown],
): Promise<boolean> {
  const snarkjs = await import("snarkjs");
  return snarkjs.groth16.verify(vkey, publicSignals, buildSnarkProof(a, b, c));
}
