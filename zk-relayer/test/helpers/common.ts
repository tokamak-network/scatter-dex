/**
 * Shared helpers for E2E test scripts.
 * Used by e2e-private-flow.ts, e2e-market-order.ts, e2e-cross-relayer.ts.
 */

import { poseidon2, poseidon3, poseidon5, poseidon7, poseidon9 } from "poseidon-lite";
import { TAG_COMMITMENT_V2 } from "../../src/core/tags.js";

export const BN254_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export function poseidonHash(inputs: bigint[]): bigint {
  switch (inputs.length) {
    case 2: return poseidon2(inputs);
    case 3: return poseidon3(inputs);
    case 5: return poseidon5(inputs);
    case 7: return poseidon7(inputs);
    case 9: return poseidon9(inputs);
    default: throw new Error(`poseidonHash: unsupported arity ${inputs.length}`);
  }
}

export function computeCommitmentV2(
  secret: bigint, token: bigint, amount: bigint,
  salt: bigint, pubKeyAx: bigint, pubKeyAy: bigint,
): bigint {
  return poseidonHash([TAG_COMMITMENT_V2, secret, token, amount, salt, pubKeyAx, pubKeyAy]);
}

export function randomFieldElement(): bigint {
  let value: bigint;
  do {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    bytes[0] &= 0x3f;
    value = 0n;
    for (const b of bytes) value = (value << 8n) | BigInt(b);
  } while (value >= BN254_ORDER);
  return value;
}

export function toHex(n: bigint, bytes: number): string {
  return "0x" + n.toString(16).padStart(bytes * 2, "0");
}

export function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
  console.log(`  ✓ ${msg}`);
}

export async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function buildTree(leaves: bigint[], depth: number) {
  const zeros: bigint[] = [0n];
  for (let i = 1; i <= depth; i++) zeros.push(poseidonHash([zeros[i - 1], zeros[i - 1]]));
  const size = 2 ** depth;
  const padded = [...leaves];
  while (padded.length < size) padded.push(zeros[0]);
  const layers: bigint[][] = [padded];
  let current = padded;
  for (let i = 0; i < depth; i++) {
    const next: bigint[] = [];
    for (let j = 0; j < current.length; j += 2) next.push(poseidonHash([current[j], current[j + 1]]));
    layers.push(next);
    current = next;
  }
  return { root: current[0], layers };
}

export function getMerkleProof(layers: bigint[][], idx: number) {
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];
  let index = idx;
  for (let i = 0; i < layers.length - 1; i++) {
    const isRight = index % 2;
    const siblingIndex = isRight ? index - 1 : index + 1;
    pathElements.push(layers[i][siblingIndex] ?? 0n);
    pathIndices.push(isRight);
    index = Math.floor(index / 2);
  }
  return { pathElements, pathIndices };
}

export function formatProof(proof: any) {
  return {
    proofA: [proof.pi_a[0], proof.pi_a[1]],
    proofB: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ],
    proofC: [proof.pi_c[0], proof.pi_c[1]],
  };
}
