import { ethers } from "ethers";

/** Minimal shape returned by a contract write — `hash` plus `wait()`. */
export interface WriteTx {
  hash: string;
  wait(): Promise<{ hash?: string } | null>;
}

export interface RunWriteOpts {
  /** Provider used for the gas/fee/nonce preflight. Prefer a *reliable*
   *  endpoint (e.g. the public-RPC fallback) here: when the user's wallet
   *  RPC is throttled, letting ethers run its own preflight through the
   *  wallet is exactly what surfaces as the opaque "could not coalesce
   *  error". Pre-computing the overrides on a reliable provider and
   *  handing them to the wallet means the wallet only has to broadcast.
   *  Defaults to the signer's own provider. */
  estimateProvider?: ethers.Provider | null;
  /** Gas ceiling used when estimation fails for a *transient* reason
   *  (RPC throttle/timeout). A genuine revert is rethrown instead, so the
   *  caller sees the real reason. Default 1_000_000. */
  fallbackGasLimit?: bigint;
}

const DEFAULT_FALLBACK_GAS = 1_000_000n;

/** Submit a contract write with the gas/fee/nonce preflight done up-front
 *  on a reliable provider, so ethers performs no fragile estimate through
 *  the wallet's RPC.
 *
 *  This is the shared fix for the admin "could not coalesce error": the
 *  wallet only ever does `eth_sendTransaction`, and a genuine revert is
 *  surfaced with its real reason (estimateGas throws it) instead of being
 *  wrapped by a throttled-RPC response. */
export async function runWrite(
  contract: ethers.Contract,
  fn: string,
  args: readonly unknown[],
  opts: RunWriteOpts = {},
): Promise<WriteTx> {
  const overrides = await buildWriteOverrides(contract, fn, args, opts);
  const method = contract.getFunction(fn);
  return (await method(...args, overrides)) as WriteTx;
}

/** Pre-resolve `{ gasLimit, fees, nonce }` so the wallet skips its own
 *  preflight. Each piece degrades gracefully; only a real revert throws. */
export async function buildWriteOverrides(
  contract: ethers.Contract,
  fn: string,
  args: readonly unknown[],
  opts: RunWriteOpts = {},
): Promise<ethers.Overrides> {
  const signer = contract.runner as ethers.Signer | null;
  const walletProvider = signer?.provider ?? null;
  const est = opts.estimateProvider ?? walletProvider;

  const overrides: ethers.Overrides = {};
  if (!est) return overrides; // No provider to preflight on — let the wallet fill.

  const data = contract.interface.encodeFunctionData(fn, args as unknown[]);
  const to = await contract.getAddress();
  let from: string | undefined;
  try {
    from = await signer?.getAddress();
  } catch {
    /* leave `from` undefined */
  }

  // The three preflight reads are independent — fire them together so the
  // write isn't gated on three serial round-trips. `estimateGasSafe` is the
  // only one that may reject (a genuine revert), which correctly propagates;
  // the other two never reject (they swallow transient failures).
  const [gasLimit, fees, nonce] = await Promise.all([
    estimateGasSafe(est, { to, from, data }, opts.fallbackGasLimit ?? DEFAULT_FALLBACK_GAS),
    feeOverridesSafe(est),
    from
      ? est.getTransactionCount(from, "pending").catch(() => undefined)
      : Promise.resolve(undefined),
  ]);

  overrides.gasLimit = gasLimit;
  Object.assign(overrides, fees);
  if (nonce !== undefined) overrides.nonce = nonce;

  return overrides;
}

/** estimateGas with a 20% buffer. A genuine revert (`CALL_EXCEPTION`) is
 *  rethrown so the caller gets the real reason; any other (transient)
 *  failure degrades to `fallbackGas` so a throttled RPC never blocks a
 *  legitimate write. */
async function estimateGasSafe(
  provider: ethers.Provider,
  tx: { to: string; from?: string; data: string },
  fallbackGas: bigint,
): Promise<bigint> {
  try {
    const est = await provider.estimateGas(tx);
    return (est * 120n) / 100n;
  } catch (err) {
    // Fail SAFE: only a clearly *transient* RPC failure (throttle / timeout /
    // network) degrades to the fallback gas — that throttled-RPC case is the
    // whole reason runWrite exists. Every other failure (a revert,
    // insufficient funds, an unpredictable-gas estimate, an unknown error) is
    // rethrown so the caller sees the real reason and a doomed transaction
    // never reaches the wallet carrying an arbitrary gas limit.
    if (isTransientRpcError(err)) return fallbackGas;
    throw err;
  }
}

/** Heuristic for transient RPC failures (throttle / timeout / network) worth
 *  surviving with a fallback gas. Deterministic failures — reverts,
 *  insufficient funds, bad args, unpredictable-gas — are intentionally NOT
 *  matched so they propagate to the caller. */
function isTransientRpcError(err: unknown): boolean {
  const code = (err as { code?: string | number })?.code;
  if (code === "TIMEOUT" || code === "SERVER_ERROR" || code === "NETWORK_ERROR") return true;
  if (code === -32005 || code === 429 || code === 503) return true;
  const msg = ((err as Error)?.message ?? "").toLowerCase();
  return /rate.?limit|too many requests|timeout|timed out|temporarily|throttl|503|429/.test(msg);
}

/** Resolve EIP-1559 fees (falling back to legacy `gasPrice`). Returns an
 *  empty object on failure, letting the wallet fill fees as a last
 *  resort. */
async function feeOverridesSafe(provider: ethers.Provider): Promise<ethers.Overrides> {
  try {
    const fee = await provider.getFeeData();
    if (fee.maxFeePerGas != null && fee.maxPriorityFeePerGas != null) {
      return {
        maxFeePerGas: fee.maxFeePerGas,
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
      };
    }
    if (fee.gasPrice != null) return { gasPrice: fee.gasPrice };
  } catch {
    /* fall through to empty overrides */
  }
  return {};
}
