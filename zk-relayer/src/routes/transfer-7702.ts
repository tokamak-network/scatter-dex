/**
 *  Gasless transfer endpoints — submit an EIP-7702 type-4 tx on the
 *  caller's behalf so an EOA with zero native balance can still move
 *  its tokens. The signer produces two things off-chain: the EIP-7702
 *  authorization (delegating their EOA to StealthTransferAccount) and
 *  the EIP-712 batch payload that contract verifies. The relayer pays
 *  on-chain gas in native ETH and recovers it via a token fee call
 *  included in the batch.
 *
 *  Two routes share the same delegate contract and fee floor:
 *    POST /relay      — stealth-flow callers (Pay inbox); body uses
 *                       `stealthAddress`. Permissive call shapes so
 *                       redeposit/split flows can do non-ERC20 calls
 *                       (e.g. into the Pay vault).
 *    POST /eoa-relay  — general EOA → recipient transfers. Stricter:
 *                       every batch call must be an ERC20.transfer
 *                       against a whitelisted token, so an attacker
 *                       can't smuggle arbitrary calldata through the
 *                       gas sponsorship.
 */

import { Router, Request, Response, RequestHandler } from "express";
import { ethers } from "ethers";
import { z } from "zod";
import type { PrivateSubmitter } from "../core/private-submitter.js";
import { createLogger } from "../core/logger.js";
import { config } from "../config.js";
import { parseTokenList, type TokenEntry } from "../lib/tokens.js";
import { eqAddr } from "../lib/address.js";

const log = createLogger("transfer-7702");

const HEX_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX_DATA_RE = /^0x[a-fA-F0-9]*$/;
const HEX_SIG_RE = /^0x[a-fA-F0-9]{130}$/;
const HEX_R_S_RE = /^0x[a-fA-F0-9]{64}$/;
// uint256 as decimal string. ethers' BigNumberish accepts these
// directly; we don't bother with hex here because the JSON wire is
// noisy enough already.
const DECIMAL_INT_RE = /^[0-9]+$/;

// Mirror of `StealthTransferAccount.executeBatch(Call[], uint256, bytes)`
// fragments — kept inline because the route is the only consumer.
// v2 added the `deadline` parameter so a leaked sig can't sit
// indefinitely on a still-fresh nonce.
const ACCOUNT_IFACE = new ethers.Interface([
  "function executeBatch((address target, uint256 value, bytes data)[] calls, uint256 deadline, bytes signature)",
]);

/** Drop-broadcast safety margin (seconds). If the signed deadline
 *  is closer than this to `now`, the relayer refuses to submit
 *  rather than burn gas on a tx the contract is about to revert. */
const DEADLINE_SAFETY_MARGIN_SEC = 30;

// Used to recognize ERC20.transfer(to, amount) calls inside the batch
// so the endpoint can sum fee credits to the relayer wallet.
const ERC20_TRANSFER_IFACE = new ethers.Interface([
  "function transfer(address to, uint256 amount)",
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
  // Unix-second deadline bound into the EIP-712 sig. The contract
  // reverts ExpiredSignature() when `block.timestamp > deadline`;
  // we pre-flight that here so a stale sig fails fast.
  deadline: z.string().regex(DECIMAL_INT_RE),
  // EIP-712 sig over hashBatch — 65 bytes packed.
  signature: z.string().regex(HEX_SIG_RE),
  authorization: authorizationSchema,
});

export type RelayTransferBody = z.infer<typeof relayBodySchema>;

const eoaRelayBodySchema = z.object({
  // Same wire-shape as `/relay` but renamed so consumers don't have
  // to pretend their address is "stealth". Tracked separately so
  // logs and metrics distinguish the two flows.
  fromEoa: z.string().regex(HEX_ADDRESS_RE),
  calls: z.array(callSchema).min(1).max(16),
  deadline: z.string().regex(DECIMAL_INT_RE),
  signature: z.string().regex(HEX_SIG_RE),
  authorization: authorizationSchema,
});

export type EoaRelayTransferBody = z.infer<typeof eoaRelayBodySchema>;

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
  /** addr:symbol:decimals → resolves a token address to a policy
   *  key when validating in-batch fee. Defaults to parsing
   *  TOKEN_LIST env at construction so production wiring stays a
   *  no-op; tests inject a fixture. */
  tokenEntries?: TokenEntry[];
  /** Symbol → decimal-string flat fee for that token. Same sourcing
   *  story: prod reads `config.gaslessFees`, tests pass an explicit
   *  fixture. */
  gaslessFees?: Record<string, string>;
}

type CallInput = z.infer<typeof callSchema>;
type AuthorizationInput = z.infer<typeof authorizationSchema>;

interface ValidationFailure {
  status: number;
  body: Record<string, unknown>;
}

function fail(status: number, body: Record<string, unknown>): ValidationFailure {
  return { status, body };
}

function sendFailure(res: Response, f: ValidationFailure): void {
  res.status(f.status).json(f.body);
}

/** Reject delegations that don't target the operator-published
 *  StealthTransferAccount. A tampered client otherwise could steer
 *  the EOA into delegating to an attacker contract. */
function validateDelegate(
  authorization: AuthorizationInput,
  expected: string,
): ValidationFailure | null {
  if (!eqAddr(authorization.address, expected)) {
    return fail(400, {
      error: "unauthorized delegate",
      expected,
      got: authorization.address,
    });
  }
  return null;
}

function validateChainId(
  authorization: AuthorizationInput,
  expectedChainId: bigint,
): ValidationFailure | null {
  if (BigInt(authorization.chainId) !== expectedChainId) {
    return fail(400, {
      error: "chainId mismatch",
      expected: expectedChainId.toString(),
      got: authorization.chainId,
    });
  }
  return null;
}

/** Decoded ERC20.transfer(to, amount) — null for calls whose data
 *  isn't a transfer selector. Computed once per request and reused
 *  by both the whitelist gate and the fee gate so the decode work
 *  isn't duplicated. */
type DecodedTransfer = { to: string; amount: bigint } | null;

function decodeTransferCalls(calls: CallInput[]): DecodedTransfer[] {
  return calls.map((c) => {
    try {
      const d = ERC20_TRANSFER_IFACE.decodeFunctionData("transfer", c.data);
      return { to: (d[0] as string).toLowerCase(), amount: BigInt(d[1] as bigint) };
    } catch {
      return null;
    }
  });
}

/** Sum every ERC20.transfer(relayerWallet, amount) by token and
 *  require the total to clear the published fee floor for that
 *  token. Shared between stealth and EOA routes — fee math doesn't
 *  depend on the caller flavor. */
function validateFeePayment(
  calls: CallInput[],
  decoded: DecodedTransfer[],
  relayerWalletAddress: string,
  tokenByAddr: Map<string, TokenEntry>,
  gaslessFees: Record<string, string>,
): ValidationFailure | null {
  const relayerWallet = relayerWalletAddress.toLowerCase();
  const feeByToken = new Map<string, bigint>();
  for (let i = 0; i < calls.length; i++) {
    const d = decoded[i];
    if (!d || d.to !== relayerWallet) continue;
    const tokenAddr = calls[i].target.toLowerCase();
    feeByToken.set(tokenAddr, (feeByToken.get(tokenAddr) ?? 0n) + d.amount);
  }
  let supportedFeePaid = false;
  for (const [tokenAddr, paid] of feeByToken) {
    const entry = tokenByAddr.get(tokenAddr);
    if (!entry) {
      return fail(400, {
        error: "token not supported",
        token: tokenAddr,
        reason: `Relayer does not accept fees in token ${tokenAddr}`,
      });
    }
    const policy = gaslessFees[entry.symbol];
    if (!policy) {
      return fail(400, {
        error: "token not supported",
        token: entry.symbol,
        reason: `Relayer has no published gasless fee for ${entry.symbol}`,
      });
    }
    const policyWei = ethers.parseUnits(policy, entry.decimals);
    if (paid < policyWei) {
      return fail(400, {
        error: "fee below policy",
        token: entry.symbol,
        paid: ethers.formatUnits(paid, entry.decimals),
        required: policy,
      });
    }
    supportedFeePaid = true;
  }
  if (!supportedFeePaid) {
    return fail(400, {
      error: "no fee paid to relayer",
      reason:
        "Batch must include at least one ERC20.transfer to the relayer wallet matching the published fee policy",
    });
  }
  return null;
}

/** EOA-flow only: every call must be an ERC20.transfer against a
 *  whitelisted token. Stricter than the stealth path — general EOAs
 *  can hold arbitrary calldata patterns, and we don't want the
 *  relayer subsidising calls into unknown contracts. */
function validateEoaCallsWhitelist(
  calls: CallInput[],
  decoded: DecodedTransfer[],
  tokenByAddr: Map<string, TokenEntry>,
): ValidationFailure | null {
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    if (BigInt(c.value) !== 0n) {
      return fail(400, {
        error: "non-zero call value",
        index: i,
        reason: "EOA gasless transfers may not attach native ETH value",
      });
    }
    if (!decoded[i]) {
      return fail(400, {
        error: "non-erc20-transfer call",
        index: i,
        reason: "EOA gasless transfers must be ERC20.transfer(to, amount) calls",
      });
    }
    if (!tokenByAddr.has(c.target.toLowerCase())) {
      return fail(400, {
        error: "token not whitelisted",
        index: i,
        token: c.target,
        reason: "Relayer only sponsors transfers of whitelisted tokens",
      });
    }
  }
  return null;
}

interface BroadcastInputs {
  to: string;
  calls: CallInput[];
  /** Decimal-string unix-second deadline. Encoded into the
   *  `executeBatch` call so the contract's own
   *  `block.timestamp > deadline` check can fire. */
  deadline: string;
  signature: string;
  authorization: AuthorizationInput;
}

/** Encode + broadcast the type-4 tx. Shared between routes so the
 *  RPC-error redaction lives in one place. Returns the broadcast tx
 *  hash on success, a ValidationFailure on a classified failure. */
async function broadcastBatch(
  submitter: PrivateSubmitter,
  inputs: BroadcastInputs,
  logTag: string,
): Promise<{ txHash: string } | ValidationFailure> {
  try {
    const data = ACCOUNT_IFACE.encodeFunctionData("executeBatch", [
      inputs.calls.map((c) => [c.target, BigInt(c.value), c.data]),
      BigInt(inputs.deadline),
      inputs.signature,
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
        to: inputs.to,
        data,
        authorizationList: [
          {
            address: inputs.authorization.address,
            chainId: BigInt(inputs.authorization.chainId),
            nonce: BigInt(inputs.authorization.nonce),
            signature: inputs.authorization.signature,
          },
        ],
      }),
    );
    log.info(`submitted ${logTag}`, {
      to: inputs.to,
      txHash: tx.hash,
      callsCount: inputs.calls.length,
    });
    return { txHash: tx.hash };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`${logTag} broadcast failed`, { error: msg });
    // Don't echo the verbatim ethers error to the client: in some
    // failure modes (e.g. "could not detect network", connection
    // errors) the message embeds the RPC URL — which may include
    // an Infura/Alchemy API key. Surface a curated, low-cardinality
    // reason whitelist instead and log the full message
    // server-side for the operator.
    return {
      status: 500,
      body: { error: "broadcast failed", reason: classifyError(msg) },
    };
  }
}

export function createTransfer7702Routes(
  submitter: PrivateSubmitter,
  opts: CreateRoutesOpts,
  writeLimiter?: RequestHandler,
): Router {
  const tokenEntries = opts.tokenEntries ?? parseTokenList(process.env.TOKEN_LIST ?? "");
  const gaslessFees = opts.gaslessFees ?? config.gaslessFees;
  // Index by lowercased address once so per-call lookups stay O(1).
  // Normalise on insert: `parseTokenList` already lowercases, but
  // tests (and any future caller injecting `opts.tokenEntries`
  // directly) may pass checksummed addresses, which would silently
  // miss the `c.target.toLowerCase()` lookup below.
  const tokenByAddr = new Map(tokenEntries.map((t) => [t.addr.toLowerCase(), t] as const));

  // Resolve chainId lazily on first request, then cache. ethers v6
  // `getNetwork()` issues an `eth_chainId` RPC on every call past the
  // first to detect chain drift — irrelevant for a relayer pinned to
  // one upstream — so we read once and re-use the bigint.
  let cachedChainId: bigint | null = null;
  const getChainId = async (): Promise<bigint> => {
    if (cachedChainId === null) {
      const network = await submitter.getProvider().getNetwork();
      cachedChainId = network.chainId;
    }
    return cachedChainId;
  };

  const router = Router();

  async function handleRelay(
    req: Request,
    res: Response,
    schema: typeof relayBodySchema | typeof eoaRelayBodySchema,
    extract: (body: RelayTransferBody | EoaRelayTransferBody) => {
      to: string;
      isEoaPath: boolean;
    },
    logTag: string,
  ): Promise<void> {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const body = parsed.data;

    const delegateFail = validateDelegate(body.authorization, opts.stealthTransferAccountAddress);
    if (delegateFail) return sendFailure(res, delegateFail);

    const expectedChainId = await getChainId();
    const chainFail = validateChainId(body.authorization, expectedChainId);
    if (chainFail) return sendFailure(res, chainFail);

    // Refuse signatures whose deadline has already passed (or is
    // close enough that the tx would land after expiry). The
    // contract enforces the same check on-chain via
    // `ExpiredSignature()`; this just saves the gas + the
    // round-trip when the answer is already known.
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const deadlineSec = BigInt(body.deadline);
    if (nowSec + BigInt(DEADLINE_SAFETY_MARGIN_SEC) > deadlineSec) {
      return sendFailure(
        res,
        fail(400, {
          error: "expired_signature",
          reason: "Signature deadline has passed (or is within the broadcast safety margin).",
          now: nowSec.toString(),
          deadline: body.deadline,
        }),
      );
    }

    const decoded = decodeTransferCalls(body.calls);
    const { to, isEoaPath } = extract(body);

    if (isEoaPath) {
      const whitelistFail = validateEoaCallsWhitelist(body.calls, decoded, tokenByAddr);
      if (whitelistFail) return sendFailure(res, whitelistFail);
    }

    const feeFail = validateFeePayment(
      body.calls,
      decoded,
      submitter.getWallet().address,
      tokenByAddr,
      gaslessFees,
    );
    if (feeFail) return sendFailure(res, feeFail);

    const result = await broadcastBatch(
      submitter,
      {
        to,
        calls: body.calls,
        deadline: body.deadline,
        signature: body.signature,
        authorization: body.authorization,
      },
      logTag,
    );
    if ("status" in result) return sendFailure(res, result);
    res.status(202).json({ txHash: result.txHash });
  }

  if (writeLimiter) router.post("/relay", writeLimiter);
  router.post("/relay", (req, res) =>
    handleRelay(
      req,
      res,
      relayBodySchema,
      (b) => ({ to: (b as RelayTransferBody).stealthAddress, isEoaPath: false }),
      "7702 stealth transfer",
    ),
  );

  if (writeLimiter) router.post("/eoa-relay", writeLimiter);
  router.post("/eoa-relay", (req, res) =>
    handleRelay(
      req,
      res,
      eoaRelayBodySchema,
      (b) => ({ to: (b as EoaRelayTransferBody).fromEoa, isEoaPath: true }),
      "7702 eoa transfer",
    ),
  );

  return router;
}
