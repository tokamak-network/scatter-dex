import { ethers } from "ethers";
import { PRIVATE_SETTLEMENT_IFACE } from "../core/contracts";
import { toBytes32Hex } from "../zk/commitment";
import type { ClaimProofResult } from "../zk/circuits/claim";
import type { DepositProofResult } from "../zk/circuits/deposit";

/// Hard cap enforced by `PrivateSettlement.claimToPool` —
/// `MAX_CLAIM_TO_POOL_SLICES`. Mirrored client-side so an oversized
/// payload doesn't burn gas to revert on-chain.
export const MAX_CLAIM_TO_POOL_SLICES = 8;

/** One slice's deposit proof + commitment + amount. */
export interface ClaimToPoolSlice {
  proof: DepositProofResult;
  amount: bigint;
}

/** Public claim metadata mirroring the contract's `ClaimToPoolParams`
 *  struct. Callers pre-build it once per claim and reuse across the
 *  EIP-712 signing helper and the contract-call helper. */
export interface ClaimToPoolCallInputs {
  claimsRoot: string;
  claimNullifier: string;
  amount: bigint;
  token: string;
  stealthRecipient: string;
  releaseTime: bigint;
}

/** EIP-712 domain matching the contract's manual implementation
 *  (`PrivateSettlement.sol` Rev 2). Kept here so the frontend signs
 *  exactly what the contract recovers — any drift breaks claimToPool
 *  with `InvalidStealthSignature`. */
export const CLAIM_TO_POOL_DOMAIN_NAME = "PrivateSettlement";
export const CLAIM_TO_POOL_DOMAIN_VERSION = "1";

/// EIP-712 typehash for `ClaimToPoolAuth(bytes32 claimNullifier,
/// uint256 amount,address token,bytes32 slicesHash)`. Used only as a
/// reference for tests / debugging; ethers' `signTypedData` derives
/// the typehash itself from the `types` map below.
export const CLAIM_TO_POOL_AUTH_TYPES: Record<string, ethers.TypedDataField[]> = {
  ClaimToPoolAuth: [
    { name: "claimNullifier", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "token", type: "address" },
    { name: "slicesHash", type: "bytes32" },
  ],
};

/** Compute the slicesHash that the contract verifies against —
 *  `keccak256(abi.encode(slices))` in Solidity, mirrored with
 *  ethers' AbiCoder. The slice tuple type MUST match the Solidity
 *  `ClaimToPoolSlice` field order: (uint256[2], uint256[2][2],
 *  uint256[2], uint256, uint256). Diverging here makes every claim
 *  fail with InvalidStealthSignature. */
export function computeClaimToPoolSlicesHash(slices: ClaimToPoolSlice[]): string {
  const tuples = slices.map((s) => {
    const { a, b, c } = s.proof.proof;
    return [a, b, c, s.proof.commitment, s.amount];
  });
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "tuple(uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC, uint256 commitment, uint256 amount)[]",
    ],
    [tuples],
  );
  return ethers.keccak256(encoded);
}

/** Build the contract-call params struct from the per-slice deposit
 *  proofs. The frontend assembles slices, signs the auth message,
 *  then calls `callClaimToPool` with both. */
export function buildClaimToPoolSliceParams(slices: ClaimToPoolSlice[]) {
  return slices.map((s) => {
    const { a, b, c } = s.proof.proof;
    return {
      proofA: a,
      proofB: b,
      proofC: c,
      commitment: s.proof.commitment,
      amount: s.amount,
    };
  });
}

/** Sign the EIP-712 `ClaimToPoolAuth` message with the stealth
 *  privkey. Returns a 65-byte hex signature ready for the contract.
 *
 *  Domain `chainId` and `verifyingContract` (= settlement address)
 *  must match the contract's deployment exactly — wrong values give
 *  a sig that recovers to a different address and the contract
 *  rejects with InvalidStealthSignature. */
export async function signClaimToPoolAuth(
  stealthPrivkey: string,
  chainId: bigint,
  settlementAddress: string,
  inputs: ClaimToPoolCallInputs,
  slicesHash: string,
): Promise<string> {
  const wallet = new ethers.Wallet(stealthPrivkey);
  const domain = {
    name: CLAIM_TO_POOL_DOMAIN_NAME,
    version: CLAIM_TO_POOL_DOMAIN_VERSION,
    chainId,
    verifyingContract: settlementAddress,
  };
  const message = {
    claimNullifier: inputs.claimNullifier,
    amount: inputs.amount,
    token: inputs.token,
    slicesHash,
  };
  return wallet.signTypedData(domain, CLAIM_TO_POOL_AUTH_TYPES, message);
}

/** Send `PrivateSettlement.claimToPool(...)`. The frontend's
 *  connected wallet is `signer` — typically the user's MetaMask,
 *  paying gas. The stealth privkey is consumed earlier in
 *  `signClaimToPoolAuth` to produce `stealthSignature` and is not
 *  passed through here. */
export async function callClaimToPool(
  signer: ethers.Signer,
  settlementAddress: string,
  claimProof: ClaimProofResult,
  inputs: ClaimToPoolCallInputs,
  slices: ClaimToPoolSlice[],
  stealthSignature: string,
): Promise<ethers.TransactionResponse> {
  const settlement = new ethers.Contract(settlementAddress, PRIVATE_SETTLEMENT_IFACE, signer);
  const { a, b, c } = claimProof.proof;
  const params = {
    claimProofA: a,
    claimProofB: b,
    claimProofC: c,
    claimsRoot: toBytes32Hex(claimProof.claimsRoot),
    claimNullifier: toBytes32Hex(claimProof.nullifier),
    amount: inputs.amount,
    token: inputs.token,
    stealthRecipient: inputs.stealthRecipient,
    releaseTime: inputs.releaseTime,
  };
  const sliceParams = buildClaimToPoolSliceParams(slices);
  return settlement.claimToPool(params, sliceParams, stealthSignature) as Promise<ethers.TransactionResponse>;
}
