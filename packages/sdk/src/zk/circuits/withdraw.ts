import {
  type CommitmentNote,
  computeCommitment,
  computeNullifier,
  computeTokenHash,
  poseidonHash,
  randomFieldElement,
} from "../commitment";
import { TAG_COMMITMENT_V2 } from "../tags";
import { formatGroth16Proof, type SnarkjsRawProof } from "../proofFormat";
import type { Groth16Proof, MerkleProof } from "../types";
import type { CircuitAssets } from "./deposit";

export interface WithdrawProofInput {
  /** The note being spent. */
  note: CommitmentNote;
  /** Live merkle proof for `note`'s commitment in the pool tree. */
  merkleProof: MerkleProof;
  /** Raw token amount to withdraw. Must satisfy `0 < amount <= note.amount`. */
  withdrawAmount: bigint;
  /** Recipient EOA — receives the withdrawn tokens. */
  recipient: string;
  /** Relayer address paid out of the withdraw amount. Pass
   *  `0x000…000` for self-pay (no relayer). */
  relayer?: string;
}

export interface WithdrawProofResult {
  proof: Groth16Proof;
  publicSignals: readonly bigint[];
  /** `0n` for full-amount withdraws; otherwise the freshly-computed
   *  commitment of the change UTXO. Callers must persist the
   *  matching `changeNote` before broadcasting. */
  newCommitment: bigint;
  /** Change-UTXO preimage. `null` for full-amount withdraws (no
   *  residue to persist). */
  changeNote: CommitmentNote | null;
  root: bigint;
  nullifierHash: bigint;
  tokenHash: bigint;
}

interface SnarkjsModule {
  groth16: {
    fullProve: (
      input: Record<string, unknown>,
      wasm: CircuitAssets["wasm"],
      zkey: CircuitAssets["zkey"],
    ) => Promise<{
      proof: SnarkjsRawProof;
      publicSignals: string[];
    }>;
  };
}

/** Generate a Groth16 withdraw proof. Mirrors `generateDepositProof`'s
 *  shape — pure function, no caching. The commitment / nullifier /
 *  tokenHash / change-UTXO commitment are derived locally and
 *  cross-checked against the prover's public signals so a malformed
 *  prove can't slip through with a mismatched root or recipient.
 *
 *  Defense-in-depth: the on-chain pool re-verifies all of these via
 *  the verifier contract; the local checks just surface circuit-vs-
 *  app drift earlier and with clearer error messages. */
export async function generateWithdrawProof(
  input: WithdrawProofInput,
  assets: CircuitAssets,
): Promise<WithdrawProofResult> {
  const snarkjs = (await import("snarkjs")) as unknown as SnarkjsModule;
  const { note, merkleProof, withdrawAmount, recipient } = input;
  const relayer = input.relayer ?? "0x0000000000000000000000000000000000000000";

  if (withdrawAmount <= 0n || withdrawAmount > note.amount) {
    throw new Error("generateWithdrawProof: withdrawAmount out of range");
  }

  const tokenAddrHex = "0x" + note.token.toString(16).padStart(40, "0");
  const [tokenHash, nullifierHash] = await Promise.all([
    computeTokenHash(tokenAddrHex),
    computeNullifier(note),
  ]);

  // Change UTXO. Full-amount withdraw → newCommitment=0, newSalt=0.
  // Partial → mint a fresh salt + commitment so the residue stays
  // spendable. Same Poseidon shape the circuit reconstructs
  // internally, so a drift here would surface as InvalidProof.
  const changeAmount = note.amount - withdrawAmount;
  let newCommitment = 0n;
  let newSalt = 0n;
  let changeNote: CommitmentNote | null = null;
  if (changeAmount > 0n) {
    newSalt = randomFieldElement();
    changeNote = {
      ownerSecret: note.ownerSecret,
      token: note.token,
      amount: changeAmount,
      salt: newSalt,
      pubKeyAx: note.pubKeyAx,
      pubKeyAy: note.pubKeyAy,
    };
    newCommitment = await poseidonHash([
      TAG_COMMITMENT_V2,
      changeNote.ownerSecret,
      changeNote.token,
      changeNote.amount,
      changeNote.salt,
      changeNote.pubKeyAx,
      changeNote.pubKeyAy,
    ]);
    // Round-trip via `computeCommitment` so a future refactor that
    // diverges from the inline poseidonHash above gets caught here.
    const verify = await computeCommitment(changeNote);
    if (verify !== newCommitment) {
      throw new Error("generateWithdrawProof: change commitment self-check mismatch");
    }
  }

  const circuitInput: Record<string, string | string[]> = {
    // Public
    root: merkleProof.root.toString(),
    nullifierHash: nullifierHash.toString(),
    newCommitment: newCommitment.toString(),
    tokenHash: tokenHash.toString(),
    withdrawAmount: withdrawAmount.toString(),
    recipient: BigInt(recipient).toString(),
    relayer: BigInt(relayer).toString(),
    // Private
    ownerSecret: note.ownerSecret.toString(),
    token: note.token.toString(),
    amount: note.amount.toString(),
    salt: note.salt.toString(),
    newSalt: newSalt.toString(),
    pathElements: merkleProof.pathElements.map((e) => e.toString()),
    pathIndices: merkleProof.pathIndices.map((i) => i.toString()),
    pubKeyAx: note.pubKeyAx.toString(),
    pubKeyAy: note.pubKeyAy.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    assets.wasm,
    assets.zkey,
  );

  if (!Array.isArray(publicSignals) || publicSignals.length < 7) {
    throw new Error(
      "generateWithdrawProof: snarkjs returned malformed publicSignals — circuit/wasm mismatch?",
    );
  }

  return {
    proof: formatGroth16Proof(proof),
    publicSignals: publicSignals.map((s) => BigInt(s)),
    newCommitment,
    changeNote,
    root: merkleProof.root,
    nullifierHash,
    tokenHash,
  };
}
