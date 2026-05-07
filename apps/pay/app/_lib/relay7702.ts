"use client";

/**
 *  Client-side helper for the gasless stealth-transfer flow. Mirrors
 *  the on-chain `StealthTransferAccount.executeBatch` signing surface:
 *  one EIP-7702 authorization tuple delegating the EOA to the
 *  pre-deployed account contract, plus one EIP-712 typed-data
 *  signature over the batch payload. The relayer's
 *  `/api/transfer-7702/relay` endpoint takes both, builds the type-4
 *  tx, and pays gas in native ETH while the batch's last call
 *  reimburses it in tokens.
 */
import { ethers } from "ethers";
import { ERC20_ABI } from "@zkscatter/sdk";

export interface Call {
  target: string;
  /** uint256 as decimal string for JSON wire safety. */
  value: string;
  /** 0x-prefixed calldata hex. */
  data: string;
}

export interface RelayBody {
  stealthAddress: string;
  calls: Call[];
  signature: string;
  authorization: {
    address: string;
    chainId: string;
    nonce: string;
    signature: { r: string; s: string; yParity: 0 | 1 };
  };
}

/**
 *  EIP-712 domain matching `StealthTransferAccount`'s constructor
 *  (`EIP712("StealthTransferAccount", "1")`) under EIP-7702 — the
 *  `verifyingContract` is the EOA itself, since OZ's EIP712 base
 *  rebuilds the domain separator with `address(this)` whenever the
 *  cached `_cachedThis` doesn't match (i.e. always under 7702).
 */
function buildDomain(eoa: string, chainId: bigint) {
  return {
    name: "StealthTransferAccount",
    version: "1",
    chainId,
    verifyingContract: eoa,
  };
}

const BATCH_TYPES: ethers.TypedDataField extends infer F
  ? Record<string, F[]>
  : never = {
  Batch: [
    { name: "nonce", type: "uint256" },
    { name: "calls", type: "Call[]" },
  ],
  Call: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
};

export interface Sign7702Inputs {
  /** Stealth EOA private key — already known to the user via the
   *  inbox row's "Privkey" action. Never touches the network. */
  privkey: string;
  /** Address of the deployed `StealthTransferAccount`. Read from
   *  `NEXT_PUBLIC_PAY_STEALTH_TRANSFER_ACCOUNT` via
   *  `getStealthTransferAccountAddress()` in network.ts. */
  delegateAddress: string;
  /** EOA nonce per `StealthTransferAccount.nonce` (per-EOA storage
   *  slot 0 under 7702). The relayer's first call to a fresh stealth
   *  EOA reads 0; subsequent calls bump. */
  batchNonce: bigint;
  /** Calls forwarded into `executeBatch`. Includes the user-intended
   *  transfer + the relayer fee deduction. */
  calls: Call[];
  /** EOA's tx nonce — the delegation tuple binds against this. For a
   *  fresh stealth EOA receiving claim funds + immediately
   *  delegating, this is typically 0. */
  ethNonce: bigint;
  /** Connected chain id — both signatures bind against it. */
  chainId: bigint;
}

/**
 *  Produce both signatures the relayer endpoint needs. Uses an
 *  in-memory `ethers.Wallet` against the stealth privkey — no
 *  network calls; both signatures are local crypto.
 */
export async function sign7702Batch(input: Sign7702Inputs): Promise<{
  authorization: RelayBody["authorization"];
  signature: string;
}> {
  const wallet = new ethers.Wallet(input.privkey);

  // EIP-7702 authorization tuple. ethers v6.13+ exposes
  // `wallet.authorize(...)` which returns a `SignedAuthorization`
  // with `{ address, chainId, nonce, signature: { r, s, yParity } }`.
  const auth = await wallet.authorize({
    address: input.delegateAddress,
    chainId: input.chainId,
    nonce: input.ethNonce,
  });

  // EIP-712 batch signature. The verifying contract under 7702 is
  // the EOA, not the deployed delegate, so the domain.verifyingContract
  // is `wallet.address`.
  const domain = buildDomain(wallet.address, input.chainId);
  const value = {
    nonce: input.batchNonce,
    calls: input.calls.map((c) => ({
      target: c.target,
      value: BigInt(c.value),
      data: c.data,
    })),
  };
  const signature = await wallet.signTypedData(domain, BATCH_TYPES, value);

  return {
    authorization: {
      address: auth.address,
      chainId: auth.chainId.toString(),
      nonce: auth.nonce.toString(),
      signature: {
        r: auth.signature.r,
        s: auth.signature.s,
        yParity: auth.signature.yParity as 0 | 1,
      },
    },
    signature,
  };
}

/**
 *  POST the relay request and return the broadcast tx hash. The
 *  endpoint returns 202 immediately; the caller polls the receipt
 *  separately if it wants confirmation.
 */
export async function postRelayTransfer(
  relayerUrl: string,
  body: RelayBody,
): Promise<string> {
  const res = await fetch(`${relayerUrl}/api/transfer-7702/relay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    txHash?: string;
    error?: string;
    reason?: string;
  };
  if (!res.ok) {
    const detail = json.reason ?? json.error ?? `HTTP ${res.status}`;
    throw new Error(`POST ${relayerUrl}/api/transfer-7702/relay failed: ${detail}`);
  }
  if (!json.txHash) throw new Error("Relayer response missing txHash");
  return json.txHash;
}

/**
 *  Build the executeBatch `calls` array for a "send tokens, fee in
 *  same token" flow. Two calls — recipient transfer first, then the
 *  relayer fee. The batch is atomic — if either call reverts the
 *  whole tx reverts and no balance moves, so call ordering is for
 *  readability rather than partial-failure semantics. ERC20-only;
 *  native ETH gas recovery would need a different shape (a separate
 *  value-bearing call to the relayer). Caller is responsible for
 *  netting the fee against the user's intended send (`amount`
 *  should already be `userInput - fee` if that's the desired UX).
 */
export function buildErc20TransferCalls(args: {
  token: string;
  recipient: string;
  amount: bigint;
  feeRecipient: string;
  fee: bigint;
}): Call[] {
  const erc20 = new ethers.Interface(ERC20_ABI);
  return [
    {
      target: args.token,
      value: "0",
      data: erc20.encodeFunctionData("transfer", [args.recipient, args.amount]),
    },
    {
      target: args.token,
      value: "0",
      data: erc20.encodeFunctionData("transfer", [args.feeRecipient, args.fee]),
    },
  ];
}
