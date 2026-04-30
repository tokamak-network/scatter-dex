/**
 * EIP-5792 `wallet_sendCalls` helper.
 *
 * Unlike raw EIP-7702, 5792 is the RPC that wallets (MetaMask 12+,
 * Coinbase Wallet, Rabby, Rainbow, Ambire, Safe) expose to dApps for
 * atomic batching. The wallet decides *how* to execute the batch —
 * typically via 7702 under the hood — but the app never constructs
 * the SetCode tx or an executor address itself.
 *
 * Usage:
 *   const caps = await fetchCapabilities(provider, account);
 *   if (supportsAtomicBatch(caps, chainId)) {
 *     const result = await sendCalls(provider, { from, chainId, calls });
 *     const receipt = await waitForCallsReceipt(provider, result.id);
 *   } else {
 *     // Fall back to sequential sends.
 *   }
 */
import { ethers } from "ethers";

/** Shape of `wallet_sendCalls` call entries (EIP-5792 v1.0). */
export interface SendCallsCall {
  to: string;
  /** Hex-encoded wei value; omit or `"0x0"` for non-payable calls. */
  value?: string;
  /** Hex-encoded calldata. */
  data?: string;
}

export interface SendCallsParams {
  /** Envelope version — EIP-5792 currently defines "1.0" only. */
  version: "1.0";
  from: string;
  /** Hex-encoded chainId (e.g. `"0x1"`). */
  chainId: string;
  calls: SendCallsCall[];
  /** Atomicity / paymaster / auth capabilities. Optional. */
  capabilities?: Record<string, unknown>;
}

/** The `id` returned by `wallet_sendCalls` used to poll for the receipt. */
export interface SendCallsResult {
  id: string;
}

/** `wallet_getCallsStatus` response (EIP-5792 v1.0). */
export interface CallsStatus {
  /**
   * Batch state per EIP-5792:
   *   "pending"   — still in flight
   *   "completed" — all included txs mined (individual `receipts[i].status`
   *                 still has to be checked for on-chain revert)
   * Wallets may add extra states in future revisions; we treat any
   * non-"pending" value other than "completed" as an error.
   */
  status: "pending" | "completed";
  receipts?: Array<{
    logs: Array<{ address: string; data: string; topics: string[] }>;
    status: string;                 // "0x0" | "0x1"
    blockHash: string;
    blockNumber: string;
    gasUsed: string;
    transactionHash: string;
  }>;
}

/**
 * Thrown only when the wallet does not implement the EIP-5792 RPC
 * surface (method-not-found). Capability-level support — whether the
 * wallet declares `atomicBatch` for a given chain — is surfaced via
 * `supportsAtomicBatch()` returning `false`; callers gate on that
 * boolean BEFORE calling `sendCalls`, so they should never see this
 * error for the capability-absent case.
 *
 * In either case the caller should fall back to sending the steps
 * sequentially.
 */
export class Eip5792Unsupported extends Error {
  constructor(cause: unknown) {
    super("Wallet does not implement EIP-5792 wallet_sendCalls.", { cause });
    this.name = "Eip5792Unsupported";
  }
}

function providerSend<T = unknown>(
  provider: ethers.BrowserProvider | ethers.JsonRpcApiProvider,
  method: string,
  params: unknown[],
): Promise<T> {
  // `send` is present on BrowserProvider and JsonRpcApiProvider. Cast
  // kept narrow so non-JSON-RPC providers surface a real type error
  // instead of a runtime undefined-method crash.
  return (provider as ethers.JsonRpcApiProvider).send(method, params) as Promise<T>;
}

function isMethodNotFound(err: unknown): boolean {
  // JSON-RPC spec reserves -32601 for "method not found"; any wallet
  // that follows the spec surfaces that code even when the outer
  // message varies. Check it first so we don't rely on wording.
  const code = (err as { code?: unknown })?.code;
  if (code === -32601) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return [
    "method not found",
    "method not supported",
    "unsupported method",
    "does not exist / is not available",
  ].some((needle) => msg.includes(needle));
}

/**
 * Returns the capabilities the wallet advertises for the given account.
 * Shape mirrors EIP-5792:
 *   { "0x7a69": { atomicBatch: { supported: true }, paymasterService: { ... } } }
 * Null when the wallet doesn't implement `wallet_getCapabilities`.
 */
export async function fetchCapabilities(
  provider: ethers.BrowserProvider | ethers.JsonRpcApiProvider,
  account: string,
): Promise<Record<string, Record<string, { supported?: boolean }>> | null> {
  try {
    return await providerSend(provider, "wallet_getCapabilities", [account]);
  } catch (err) {
    if (isMethodNotFound(err)) return null;
    throw err;
  }
}

/** True when the wallet declares atomic-batch support for `chainId`. */
export function supportsAtomicBatch(
  caps: Record<string, Record<string, { supported?: boolean }>> | null,
  chainId: bigint | number,
): boolean {
  if (!caps) return false;
  return !!caps[ethers.toQuantity(chainId)]?.atomicBatch?.supported;
}

/**
 * Submit a batch via `wallet_sendCalls`. Throws `Eip5792Unsupported`
 * when the wallet doesn't implement the RPC; callers should catch
 * that and drop back to sequential sends.
 */
export async function sendCalls(
  provider: ethers.BrowserProvider | ethers.JsonRpcApiProvider,
  params: Omit<SendCallsParams, "chainId" | "version"> & { chainId: bigint | number },
): Promise<SendCallsResult> {
  // EIP-5792 v1.0 envelope; some wallets require the explicit version.
  const rpcParams: SendCallsParams = {
    version: "1.0",
    from: params.from,
    chainId: ethers.toQuantity(params.chainId),
    calls: params.calls,
    ...(params.capabilities ? { capabilities: params.capabilities } : {}),
  };

  try {
    return await providerSend<SendCallsResult>(provider, "wallet_sendCalls", [rpcParams]);
  } catch (err) {
    if (isMethodNotFound(err)) throw new Eip5792Unsupported(err);
    throw err;
  }
}

/**
 * Poll `wallet_getCallsStatus` until the batch finalizes.
 *
 * `timeoutMs` bounds the wait so a never-confirming batch can't hang the
 * UI indefinitely; on timeout the promise rejects and the caller can
 * decide whether to retry or surface the error.
 */
export async function waitForCallsReceipt(
  provider: ethers.BrowserProvider | ethers.JsonRpcApiProvider,
  id: string,
  { timeoutMs = 180_000, pollIntervalMs = 1500 }: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<CallsStatus> {
  const start = Date.now();
  // Simple poll — wallets typically finalize within a couple of blocks
  // on local anvil, 10-30s on public chains. Per EIP-5792 the batch
  // state is a string: "pending" while in flight, "completed" once
  // every included tx is mined. Individual per-tx success/revert is
  // reported via `receipts[i].status` ("0x0"/"0x1") and is the
  // caller's responsibility to check.
  for (;;) {
    const status = await providerSend<CallsStatus>(provider, "wallet_getCallsStatus", [id]);
    if (status.status === "completed") return status;
    if (status.status !== "pending") {
      // Future-proofing: surface any state the spec adds later so
      // callers don't silently treat it as success.
      throw new Error(`wallet_getCallsStatus returned unexpected state "${status.status}" (id=${id})`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`wallet_getCallsStatus timed out after ${timeoutMs}ms (id=${id})`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}
