import { ethers } from "ethers";
import { COMMITMENT_POOL_IFACE, ERC20_IFACE } from "../core/contracts";
import type { DepositProofResult } from "../zk/circuits/deposit";

/** Approve `token` for `spender` to pull `amount` units. No-op
 *  when the existing allowance already covers the request. */
export async function ensureAllowance(
  signer: ethers.Signer,
  token: string,
  spender: string,
  amount: bigint,
): Promise<ethers.TransactionResponse | null> {
  const owner = await signer.getAddress();
  const erc20 = new ethers.Contract(token, ERC20_IFACE, signer);
  const current = (await erc20.allowance(owner, spender)) as bigint;
  if (current >= amount) return null;
  return erc20.approve(spender, amount) as Promise<ethers.TransactionResponse>;
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
