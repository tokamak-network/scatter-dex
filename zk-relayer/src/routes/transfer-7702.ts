/**
 *  Gasless transfer endpoint — submits an EIP-7702 type-4 tx on the
 *  caller's behalf so a stealth EOA with zero native balance can
 *  still move its tokens. The recipient signs two things off-chain:
 *  the EIP-7702 authorization (delegating their EOA to
 *  StealthTransferAccount) and the EIP-712 batch payload that
 *  contract verifies. We pay the on-chain gas in native ETH and
 *  expect a fee-collection call inside `calls` to recover it as
 *  tokens — but the endpoint stays agnostic about the fee math, so
 *  the frontend (or operator policy) decides how much to deduct.
 */

import { Router, Request, Response, RequestHandler } from "express";
import { ethers } from "ethers";
import { z } from "zod";
import type { PrivateSubmitter } from "../core/private-submitter.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("transfer-7702");

const HEX_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX_DATA_RE = /^0x[a-fA-F0-9]*$/;
const HEX_SIG_RE = /^0x[a-fA-F0-9]{130}$/;
const HEX_R_S_RE = /^0x[a-fA-F0-9]{64}$/;
// uint256 as decimal string. ethers' BigNumberish accepts these
// directly; we don't bother with hex here because the JSON wire is
// noisy enough already.
const DECIMAL_INT_RE = /^[0-9]+$/;

// Mirror of `StealthTransferAccount.executeBatch(Call[], bytes)`
// fragments — kept inline because the route is the only consumer.
const ACCOUNT_IFACE = new ethers.Interface([
  "function executeBatch((address target, uint256 value, bytes data)[] calls, bytes signature)",
]);

const callSchema = z.object({
  target: z.string().regex(HEX_ADDRESS_RE),
  value: z.string().regex(DECIMAL_INT_RE),
  data: z.string().regex(HEX_DATA_RE),
});

const authorizationSchema = z.object({
  // The delegate contract — must equal the relayer's configured
  // StealthTransferAccount or we refuse to submit, since otherwise
  // the EOA could be steered into delegating to an arbitrary
  // attacker contract.
  address: z.string().regex(HEX_ADDRESS_RE),
  chainId: z.string().regex(DECIMAL_INT_RE),
  nonce: z.string().regex(DECIMAL_INT_RE),
  // ethers v6 accepts {r, s, yParity} as a SignatureLike. The
  // frontend signs via wallet.authorize(...) which already returns
  // this shape.
  signature: z.object({
    r: z.string().regex(HEX_R_S_RE),
    s: z.string().regex(HEX_R_S_RE),
    yParity: z.union([z.literal(0), z.literal(1)]),
  }),
});

const relayBodySchema = z.object({
  stealthAddress: z.string().regex(HEX_ADDRESS_RE),
  // `.min(1)` rejects the no-op batch — broadcasting one would pay
  // gas to bump the EOA's nonce without moving any tokens, and the
  // contract still emits BatchExecuted. The "burn this nonce" use
  // case in the contract test is fine on-chain; we just don't want
  // the public endpoint to subsidize it for no client benefit.
  calls: z.array(callSchema).min(1).max(16),
  // EIP-712 sig over hashBatch — 65 bytes packed.
  signature: z.string().regex(HEX_SIG_RE),
  authorization: authorizationSchema,
});

export type RelayTransferBody = z.infer<typeof relayBodySchema>;

/** Map a verbose ethers / RPC error message to a small, low-cardinality
 *  client-facing reason. Anything we don't recognise becomes "internal
 *  error" — the full message stays in the server log for the operator. */
function classifyError(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes("insufficient funds")) return "insufficient relayer balance";
  if (lower.includes("nonce too low")) return "nonce too low";
  if (lower.includes("execution reverted") || lower.includes("invalidsignature")) {
    return "execution reverted";
  }
  if (lower.includes("nonce") && lower.includes("high")) return "nonce too high";
  if (lower.includes("replacement") && lower.includes("underpriced")) {
    return "replacement transaction underpriced";
  }
  return "internal error";
}

interface CreateRoutesOpts {
  /** Address of the deployed `StealthTransferAccount`. The endpoint
   *  refuses to submit any authorization that delegates to a
   *  different contract — this is the operator's safety net against
   *  a tampered frontend. */
  stealthTransferAccountAddress: string;
}

export function createTransfer7702Routes(
  submitter: PrivateSubmitter,
  opts: CreateRoutesOpts,
  writeLimiter?: RequestHandler,
): Router {
  const router = Router();

  if (writeLimiter) router.post("/relay", writeLimiter);
  router.post("/relay", async (req: Request, res: Response) => {
    const parsed = relayBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const body = parsed.data;

    // Refuse to relay an authorization for a delegate other than the
    // operator-published StealthTransferAccount. Otherwise a
    // compromised client could trick the relayer into permanently
    // delegating the EOA to an attacker contract that drains funds.
    if (
      body.authorization.address.toLowerCase() !==
      opts.stealthTransferAccountAddress.toLowerCase()
    ) {
      res.status(400).json({
        error: "unauthorized delegate",
        expected: opts.stealthTransferAccountAddress,
        got: body.authorization.address,
      });
      return;
    }

    // Bind authorization chainId to our connected network so a
    // cross-chain auth tuple isn't replayed here.
    const provider = submitter.getProvider();
    const network = await provider.getNetwork();
    if (BigInt(body.authorization.chainId) !== network.chainId) {
      res.status(400).json({
        error: "chainId mismatch",
        expected: network.chainId.toString(),
        got: body.authorization.chainId,
      });
      return;
    }

    let txHash: string;
    try {
      const data = ACCOUNT_IFACE.encodeFunctionData("executeBatch", [
        body.calls.map((c) => [c.target, BigInt(c.value), c.data]),
        body.signature,
      ]);

      const wallet = submitter.getWallet();
      // Funnel through the submitter's nonce-serializing mutex so
      // concurrent POSTs (or overlap with claim/vault txs already
      // gated by the same lock) can't race on the same nonce —
      // ethers' default in-flight nonce tracking is per-Wallet, but
      // sharing one Wallet across endpoints exposes it to drops if
      // two callers hit broadcast at the same instant.
      const tx = await submitter.sendWithTxLock(() =>
        wallet.sendTransaction({
          type: 4,
          to: body.stealthAddress,
          data,
          // Single-element list — only the recipient's EOA delegates;
          // the relayer's own EOA does not need any 7702 hat.
          authorizationList: [
            {
              address: body.authorization.address,
              chainId: BigInt(body.authorization.chainId),
              nonce: BigInt(body.authorization.nonce),
              signature: body.authorization.signature,
            },
          ],
        }),
      );
      txHash = tx.hash;
      log.info("submitted 7702 transfer", {
        stealth: body.stealthAddress,
        txHash,
        callsCount: body.calls.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("7702 transfer broadcast failed", { error: msg });
      // Don't echo the verbatim ethers error to the client: in some
      // failure modes (e.g. "could not detect network", connection
      // errors) the message embeds the RPC URL — which may include
      // an Infura/Alchemy API key. Surface a curated, low-cardinality
      // reason whitelist instead and log the full message
      // server-side for the operator.
      res.status(500).json({ error: "broadcast failed", reason: classifyError(msg) });
      return;
    }

    res.status(202).json({ txHash });
  });

  return router;
}
