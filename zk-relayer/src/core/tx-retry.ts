/**
 * Safe transaction sender with:
 * - Send-phase retry (TX never left the node → safe to retry)
 * - Wait-phase timeout + receipt recovery (TX in mempool → poll by hash)
 * - Revert detection (on-chain revert → no retry, throw immediately)
 *
 * R-2: TX retry safety for mainnet relayer operation.
 */

import type { ethers } from "ethers";

export interface TxSendResult {
  txHash: string;
  receipt: ethers.TransactionReceipt;
}

export interface SendAndWaitOptions {
  /** Max attempts for the send phase (default: 3). */
  sendRetries?: number;
  /** Base delay in ms for exponential backoff between send retries (default: 1000). */
  sendRetryBaseMs?: number;
  /** Timeout in ms for tx.wait() (default: 120_000 = 2 min). */
  waitTimeoutMs?: number;
  /** Max attempts to poll receipt after wait timeout (default: 3). */
  receiptPollRetries?: number;
  /** Delay between receipt poll attempts in ms (default: 10_000). */
  receiptPollIntervalMs?: number;
  /** Label for logging (e.g. "settlePrivate"). */
  label?: string;
  /** Callback when txHash is known (before receipt). Use to persist hash. Best-effort: errors are logged, not thrown. */
  onTxHash?: (txHash: string) => void;
  /** Callback when receipt is obtained (before revert check). Use to clean up pending TX tracking. Best-effort: errors are logged, not thrown. */
  onReceipt?: (txHash: string, reverted: boolean) => void;
}

const defaults = {
  sendRetries: 3,
  sendRetryBaseMs: 1_000,
  waitTimeoutMs: 120_000,
  receiptPollRetries: 3,
  receiptPollIntervalMs: 10_000,
} as const;

/**
 * Determine if an error is a transient send-phase failure
 * (network issue, RPC timeout) vs a deterministic failure
 * (revert, invalid params) that should NOT be retried.
 */
function isTransientSendError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();

  // Deterministic failures — never retry
  const permanentPatterns = [
    "revert",
    "execution reverted",
    "insufficient funds",
    "nonce too low",
    "replacement fee too low",
    "invalid argument",
    "invalid address",
    "unpredictable_gas_limit",
  ];
  if (permanentPatterns.some((p) => msg.includes(p))) return false;

  // Transient failures — safe to retry (TX never reached mempool)
  const transientPatterns = [
    "timeout",
    "econnrefused",
    "econnreset",
    "enotfound",
    "socket hang up",
    "network error",
    "bad response",
    "missing response",
    "server error",
    "502",
    "503",
    "429",
  ];
  if (transientPatterns.some((p) => msg.includes(p))) return true;

  // Unknown error — don't retry to be safe
  return false;
}

/**
 * Send a contract transaction with safe retry semantics.
 *
 * Phase 1 (send): Retry on transient RPC errors only.
 *   TX hasn't reached the mempool, so resending is safe.
 *
 * Phase 2 (wait): Apply timeout. If timeout fires, the TX IS
 *   in the mempool — do NOT resend. Instead poll for receipt by hash.
 */
export async function sendAndWait(
  sendFn: () => Promise<ethers.TransactionResponse>,
  provider: ethers.Provider,
  opts: SendAndWaitOptions = {},
): Promise<TxSendResult> {
  const {
    sendRetries = defaults.sendRetries,
    sendRetryBaseMs = defaults.sendRetryBaseMs,
    waitTimeoutMs = defaults.waitTimeoutMs,
    receiptPollRetries = defaults.receiptPollRetries,
    receiptPollIntervalMs = defaults.receiptPollIntervalMs,
    label = "tx",
    onTxHash,
    onReceipt,
  } = opts;

  // ── Phase 1: Send with retry ──────────────────────────────
  let tx: ethers.TransactionResponse | undefined;

  for (let attempt = 1; attempt <= sendRetries; attempt++) {
    try {
      tx = await sendFn();
      break;
    } catch (err) {
      if (attempt < sendRetries && isTransientSendError(err)) {
        const delay = sendRetryBaseMs * 2 ** (attempt - 1);
        console.warn(
          `[tx-retry] ${label} send attempt ${attempt}/${sendRetries} failed (transient), ` +
          `retrying in ${delay}ms: ${err instanceof Error ? err.message : err}`,
        );
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }

  if (!tx) throw new Error(`[tx-retry] ${label}: send failed after ${sendRetries} attempts`);

  const txHash = tx.hash;
  console.log(`[tx-retry] ${label} sent: ${txHash}`);

  // Best-effort: DB failure must not abort the TX wait flow
  try { onTxHash?.(txHash); } catch (err) {
    console.warn(`[tx-retry] ${label} onTxHash callback failed (non-fatal):`, err);
  }

  // ── Phase 2: Wait with timeout ────────────────────────────
  let receipt = await waitWithTimeout(tx, waitTimeoutMs);

  if (!receipt) {
    console.warn(
      `[tx-retry] ${label} wait timed out after ${waitTimeoutMs}ms, polling receipt for ${txHash}...`,
    );
    receipt = await pollReceipt(provider, txHash, receiptPollRetries, receiptPollIntervalMs);
  }

  if (!receipt) {
    throw new Error(
      `[tx-retry] ${label}: no receipt after timeout + ${receiptPollRetries} polls (txHash=${txHash}). ` +
      `TX may still be pending — check manually.`,
    );
  }

  // ── Phase 3: Cleanup + revert check ───────────────────────
  // onReceipt fires BEFORE revert throw so pending TX is always cleaned up
  const reverted = receipt.status === 0;
  try { onReceipt?.(receipt.hash, reverted); } catch (err) {
    console.warn(`[tx-retry] ${label} onReceipt callback failed (non-fatal):`, err);
  }

  if (reverted) {
    throw new Error(
      `[tx-retry] ${label} reverted on-chain (txHash=${txHash}). Not retrying.`,
    );
  }

  return { txHash: receipt.hash, receipt };
}

/** tx.wait() with a timeout. Returns null on timeout (TX still pending). */
async function waitWithTimeout(
  tx: ethers.TransactionResponse,
  timeoutMs: number,
): Promise<ethers.TransactionReceipt | null> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });

  const waitPromise = tx.wait().then((r) => r ?? null);
  waitPromise.catch(() => {});

  try {
    return await Promise.race([waitPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Poll provider.getTransactionReceipt() with retries. */
async function pollReceipt(
  provider: ethers.Provider,
  txHash: string,
  retries: number,
  intervalMs: number,
): Promise<ethers.TransactionReceipt | null> {
  for (let i = 0; i < retries; i++) {
    if (i > 0) await sleep(intervalMs);
    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt) return receipt;
    } catch (err) {
      console.warn(
        `[tx-retry] receipt poll ${i + 1}/${retries} failed: ` +
        `${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { isTransientSendError as _isTransientSendError };
