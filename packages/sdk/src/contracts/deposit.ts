import { ethers } from "ethers";
import { COMMITMENT_POOL_IFACE, ERC20_IFACE } from "../core/contracts";
import type { DepositProofResult } from "../zk/circuits/deposit";

/** Approve `token` for `spender` to pull `amount` units.
 *
 *  No-op when the existing allowance already covers the request.
 *  When the existing allowance is non-zero but insufficient, we
 *  reset to 0 first before raising — some widely-used ERC-20s
 *  (notably USDT) revert on non-zero → non-zero allowance changes.
 *
 *  Returns the approval transaction (or `[]` when nothing was
 *  needed). The reset-to-zero path returns both transactions; both
 *  are pending and can be `wait()`-ed in order. */
export async function ensureAllowance(
  signer: ethers.Signer,
  token: string,
  spender: string,
  amount: bigint,
): Promise<ethers.TransactionResponse[]> {
  const owner = await signer.getAddress();
  const erc20 = new ethers.Contract(token, ERC20_IFACE, signer);
  const current = (await erc20.allowance(owner, spender)) as bigint;
  if (current >= amount) return [];

  const txs: ethers.TransactionResponse[] = [];
  if (current > 0n) {
    // Some ERC-20s (USDT, KNC) revert on non-zero → non-zero
    // approve. Reset to 0 first so the second approve always
    // touches a zero starting state.
    txs.push(
      (await erc20.approve(spender, 0n)) as ethers.TransactionResponse,
    );
  }
  txs.push((await erc20.approve(spender, amount)) as ethers.TransactionResponse);
  return txs;
}

/** Send `CommitmentPool.deposit(...)`. Caller is responsible for
 *  the ERC-20 approval (see `ensureAllowance`). Returns the
 *  pending TransactionResponse so callers can show optimistic UI
 *  before `wait()`. */
export async function callDeposit(
  signer: ethers.Signer,
  poolAddress: string,
  result: DepositProofResult,
  token: string,
  amount: bigint,
): Promise<ethers.TransactionResponse> {
  const pool = new ethers.Contract(poolAddress, COMMITMENT_POOL_IFACE, signer);
  const { a, b, c } = result.proof;
  return pool.deposit(a, b, c, result.commitment, token, amount) as Promise<ethers.TransactionResponse>;
}
