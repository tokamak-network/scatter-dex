"use client";

import { isConfiguredAddress } from "@zkscatter/sdk";
import {
  callCancel,
  callDeposit,
  ensureAllowance,
} from "@zkscatter/sdk/contracts";
import {
  RelayerClient,
  type AuthorizeOrderBody,
  type AuthorizeOrderStatus,
} from "@zkscatter/sdk/relayer";
import type {
  CancelProofResult,
  DepositProofResult,
  Groth16Proof,
} from "@zkscatter/sdk/zk";
import { DEMO_NETWORK } from "./network";

// Pull the signer type from `callCancel`'s signature so apps/pro
// doesn't need a direct `ethers` import — keeps the dep surface
// minimal and TypeScript happy when only @zkscatter/sdk is on the
// resolution path.
type Signer = Parameters<typeof callCancel>[0];

/** Throw a clear "switch network" error when the signer's wallet is
 *  on a different chain than the configured network. Without this,
 *  ERC-20 / contract calls return `0x` on the wrong chain and the
 *  user sees an opaque `could not decode result data` from ethers.
 *  Callers let the error propagate to the toast so the user knows
 *  exactly what to do. */
async function assertChainMatch(signer: Signer): Promise<void> {
  const provider = signer.provider;
  if (!provider) return; // Can't check; let downstream fail with its own message.
  const net = await provider.getNetwork();
  const walletChainId = Number(net.chainId);
  if (walletChainId !== DEMO_NETWORK.chainId) {
    throw new Error(
      `Wallet is on chain ${walletChainId}; this app is configured for chain ${DEMO_NETWORK.chainId}. Switch networks in your wallet and retry.`,
    );
  }
}

export interface DispatchResultSimulated {
  kind: "simulated";
  reason: "not_configured" | "no_signer" | "no_relayer";
}
export interface DispatchResultOnChain {
  kind: "onchain";
  txHash: string;
}
export interface DispatchResultRelayer {
  kind: "relayer";
  status: AuthorizeOrderStatus;
}
export type DispatchResult =
  | DispatchResultSimulated
  | DispatchResultOnChain
  | DispatchResultRelayer;

/** Dispatch a cancel proof to `PrivateSettlement.cancelPrivate(...)`
 *  when both the contract is configured AND a signer is available;
 *  otherwise return a simulated result. The caller must already have
 *  awaited the proof generation; this layer only owns the contract
 *  call. */
export async function dispatchCancel(
  signer: Signer | null,
  proof: CancelProofResult,
): Promise<DispatchResult> {
  const addr = DEMO_NETWORK.contracts.privateSettlement;
  if (!isConfiguredAddress(addr)) return { kind: "simulated", reason: "not_configured" };
  if (!signer) return { kind: "simulated", reason: "no_signer" };

  await assertChainMatch(signer);
  const tx = await callCancel(signer, addr, proof);
  return { kind: "onchain", txHash: tx.hash };
}

/** Approve + deposit into `CommitmentPool`. Same simulate-vs-onchain
 *  policy as `dispatchCancel`: falls back to simulated when the pool
 *  isn't configured for the active network, or when no signer is
 *  attached. The caller passes the post-prove `DepositProofResult`
 *  plus the ERC-20 token + amount that backs the commitment. */
export async function dispatchDeposit(
  signer: Signer | null,
  proof: DepositProofResult,
  tokenAddress: string,
  amount: bigint,
): Promise<DispatchResult> {
  const pool = DEMO_NETWORK.contracts.commitmentPool;
  if (!isConfiguredAddress(pool)) return { kind: "simulated", reason: "not_configured" };
  // Guard the token address too — `LAUNCH_TOKENS` always lists
  // ETH/USDC/USDT/TON, and a partial env overlay can leave USDT/TON
  // pointing at `ZERO_ADDRESS`. Calling `ensureAllowance` on
  // 0x000…000 would hard-revert against an EOA; surface that as the
  // same `not_configured` simulated path the pool guard uses.
  if (!isConfiguredAddress(tokenAddress)) {
    return { kind: "simulated", reason: "not_configured" };
  }
  if (!signer) return { kind: "simulated", reason: "no_signer" };

  // Verify the wallet's chain matches the configured network before
  // any contract read — otherwise `ensureAllowance` reads a non-
  // existent contract and ethers throws "could not decode result
  // data" with no actionable context for the user.
  await assertChainMatch(signer);

  // Approve first (no-op when allowance already covers `amount`).
  // Wait on each approval tx so the deposit can't race ahead of the
  // allowance update — `ensureAllowance` returns pending responses
  // and the user-visible `submitting` phase is brief enough that
  // serialising the approvals is fine.
  const approvals = await ensureAllowance(signer, tokenAddress, pool, amount);
  for (const tx of approvals) {
    await tx.wait();
  }
  const tx = await callDeposit(signer, pool, proof, tokenAddress, amount);
  return { kind: "onchain", txHash: tx.hash };
}

/** Named order of authorize.circom's public signals. Consensus-
 *  critical: index 0 is the circuit output (`pubKeyBind`), 1–14 are
 *  the public inputs in declaration order. Drift between this list
 *  and the circuit silently corrupts every body the relayer rejects.
 *  Update both — and re-run the local end-to-end test — when adding
 *  or reordering signals. */
const AUTHORIZE_PUBLIC_SIGNAL_NAMES = [
  "pubKeyBind",
  "commitmentRoot",
  "nullifier",
  "nonceNullifier",
  "newCommitment",
  "sellToken",
  "buyToken",
  "sellAmount",
  "buyAmount",
  "maxFee",
  "expiry",
  "claimsRoot",
  "totalLocked",
  "relayer",
  "orderHash",
] as const;
type AuthorizePublicSignalName = (typeof AUTHORIZE_PUBLIC_SIGNAL_NAMES)[number];

/** Build the wire-format `AuthorizeOrderBody` from the raw prover
 *  output + the EdDSA pubkey used in the proof. The relayer
 *  re-verifies every public signal so the body needs nothing beyond
 *  `proof` + `publicSignals` + the named pubkey. */
export function buildAuthorizeOrderBody(
  proof: { proof: Groth16Proof; publicSignals: readonly bigint[] },
  pubKey: readonly [bigint, bigint],
  tier: number,
): AuthorizeOrderBody {
  // Catch circuit/client drift up front — a 14-signal output vs the
  // 15-name list would otherwise produce a body with an `undefined`
  // field that only the relayer rejects, well after the 1–2 s prove
  // has been paid for.
  if (proof.publicSignals.length !== AUTHORIZE_PUBLIC_SIGNAL_NAMES.length) {
    throw new Error(
      `buildAuthorizeOrderBody: publicSignals length ${proof.publicSignals.length} ≠ expected ${AUTHORIZE_PUBLIC_SIGNAL_NAMES.length} (circuit/client drift)`,
    );
  }
  const ps = proof.publicSignals.map((b) => b.toString());
  const named = AUTHORIZE_PUBLIC_SIGNAL_NAMES.reduce<Record<AuthorizePublicSignalName, string>>(
    (acc, name, i) => {
      acc[name] = ps[i]!;
      return acc;
    },
    {} as Record<AuthorizePublicSignalName, string>,
  );
  const p = proof.proof;
  return {
    proof: {
      a: [p.a[0].toString(), p.a[1].toString()],
      b: [
        [p.b[0][0].toString(), p.b[0][1].toString()],
        [p.b[1][0].toString(), p.b[1][1].toString()],
      ],
      c: [p.c[0].toString(), p.c[1].toString()],
    },
    publicSignals: {
      pubKeyBind: named.pubKeyBind,
      commitmentRoot: named.commitmentRoot,
      nullifier: named.nullifier,
      nonceNullifier: named.nonceNullifier,
      newCommitment: named.newCommitment,
      sellToken: named.sellToken,
      buyToken: named.buyToken,
      sellAmount: named.sellAmount,
      buyAmount: named.buyAmount,
      maxFee: named.maxFee,
      expiry: named.expiry,
      claimsRoot: named.claimsRoot,
      totalLocked: named.totalLocked,
      relayer: named.relayer,
      orderHash: named.orderHash,
    },
    publicSignalsArray: ps,
    tier,
    pubKeyAx: pubKey[0].toString(),
    pubKeyAy: pubKey[1].toString(),
  };
}

/** Submit an authorize proof to the selected relayer's `POST
 *  /api/authorize-orders` endpoint. Falls back to simulated when the
 *  relayer registry is unconfigured or the user hasn't picked one
 *  (e.g. registry has zero relayers). The caller is responsible for
 *  persisting the returned nullifier and polling `pollAuthorizeOrder`
 *  if it wants to track settlement. */
export async function dispatchAuthorize(
  relayerUrl: string | null,
  body: AuthorizeOrderBody,
  signal?: AbortSignal,
): Promise<DispatchResult> {
  if (!isConfiguredAddress(DEMO_NETWORK.contracts.privateSettlement)) {
    return { kind: "simulated", reason: "not_configured" };
  }
  if (!relayerUrl) return { kind: "simulated", reason: "no_relayer" };

  const client = new RelayerClient(relayerUrl);
  const status = await client.submitAuthorizeOrder(body, signal);
  return { kind: "relayer", status };
}
