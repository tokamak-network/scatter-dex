import { ethers } from "ethers";
import { COMMITMENT_POOL_ABI, ERC20_ABI } from "../core/contracts";
import type { Groth16Proof } from "../zk/types";
import type { DepositProofResult } from "../zk/circuits/deposit";

/** Convert a `Groth16Proof` (bigint tuples) to the
 *  `(uint256[2], uint256[2][2], uint256[2])` shape every Solidity
 *  verifier expects. The SDK's proof shape already has the G2
 *  limb-order swap baked in (`formatGroth16Proof`), so this is a
 *  pure structural conversion. */
function unpackProof(p: Groth16Proof): {
  a: [bigint, bigint];
  b: [[bigint, bigint], [bigint, bigint]];
  c: [bigint, bigint];
} {
  return {
    a: [p.a[0], p.a[1]],
    b: [
      [p.b[0][0], p.b[0][1]],
      [p.b[1][0], p.b[1][1]],
    ],
    c: [p.c[0], p.c[1]],
  };
}

/** Approve `token` for the `CommitmentPool` to pull `amount` units.
 *  No-op when the existing allowance is already ≥ `amount` so a
 *  user who already approved doesn't pay another tx. */
export async function ensureAllowance(
  signer: ethers.Signer,
  token: string,
  spender: string,
  amount: bigint,
): Promise<ethers.TransactionResponse | null> {
  const owner = await signer.getAddress();
  const erc20 = new ethers.Contract(token, ERC20_ABI, signer);
  const current = (await erc20.allowance(owner, spender)) as bigint;
  if (current >= amount) return null;
  return erc20.approve(spender, amount) as Promise<ethers.TransactionResponse>;
}

/** Build and send the `CommitmentPool.deposit(...)` transaction.
 *
 *  Caller is responsible for ensuring `signer`'s account has the
 *  ERC-20 approval already (see `ensureAllowance`). Returns the
 *  pending `TransactionResponse`; awaiting `.wait()` is the
 *  caller's choice so a UI can show the optimistic state. */
export async function callDeposit(
  signer: ethers.Signer,
  poolAddress: string,
  result: DepositProofResult,
  token: string,
  amount: bigint,
): Promise<ethers.TransactionResponse> {
  const pool = new ethers.Contract(poolAddress, COMMITMENT_POOL_ABI, signer);
  const p = unpackProof(result.proof);
  return pool.deposit(p.a, p.b, p.c, result.commitment, token, amount) as Promise<ethers.TransactionResponse>;
}
