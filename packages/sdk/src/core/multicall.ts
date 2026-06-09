import { ethers } from "ethers";

// Multicall3 is deployed at the same deterministic address on every
// EVM chain zkScatter targets (Sepolia, mainnet, …). Local anvil/fork
// chains usually lack it — `multicall()` falls back to individual
// `provider.call()` in that case, so dev never breaks.
// https://www.multicall3.com/
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

export const MULTICALL3_ABI = [
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) external payable returns (tuple(bool success, bytes returnData)[])",
];

export interface MulticallRequest {
  target: string;
  callData: string;
}

export interface MulticallResult {
  success: boolean;
  returnData: string;
}

// Max calls per batch to avoid gas-limit / RPC response-size issues.
const MAX_BATCH_SIZE = 100;

/**
 * Batch multiple read-only contract calls into a single RPC request via
 * Multicall3. Automatically chunks large batches. Falls back to
 * individual calls if Multicall3 is unavailable (e.g. a local chain
 * without the predeploy).
 *
 * All calls use allowFailure=true semantics — a failed sub-call returns
 * `{ success: false }` instead of reverting the whole batch. Callers must
 * check `result.success` per item.
 *
 * Promoted from the legacy `frontend/app/lib/multicall.ts` so every app
 * (and the wallet-backed `InjectedMulticallProvider`) shares one
 * implementation.
 */
export async function multicall(
  provider: ethers.Provider,
  requests: MulticallRequest[],
): Promise<MulticallResult[]> {
  if (requests.length === 0) return [];

  // Single call — no need for multicall overhead.
  if (requests.length === 1) {
    return [await callOne(provider, requests[0]!)];
  }

  const mc = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);

  // Chunk into batches of MAX_BATCH_SIZE, with per-chunk fallback.
  const allResults: MulticallResult[] = [];
  for (let i = 0; i < requests.length; i += MAX_BATCH_SIZE) {
    const chunk = requests.slice(i, i + MAX_BATCH_SIZE);
    try {
      const calls = chunk.map((r) => ({
        target: r.target,
        allowFailure: true,
        callData: r.callData,
      }));
      const results: { success: boolean; returnData: string }[] =
        await mc.aggregate3!.staticCall(calls);
      allResults.push(
        ...results.map((r) => ({ success: r.success, returnData: r.returnData })),
      );
    } catch (err) {
      // Per-chunk fallback — only retries this chunk, not already-successful ones.
      console.warn(
        `[multicall] Chunk ${i / MAX_BATCH_SIZE} failed, falling back to individual calls:`,
        err,
      );
      const fallbackResults = await Promise.all(
        chunk.map((r) => callOne(provider, r)),
      );
      allResults.push(...fallbackResults);
    }
  }
  return allResults;
}

/** Single read with allowFailure semantics — never throws. */
async function callOne(
  provider: ethers.Provider,
  req: MulticallRequest,
): Promise<MulticallResult> {
  try {
    const returnData = await provider.call({ to: req.target, data: req.callData });
    return { success: true, returnData };
  } catch {
    return { success: false, returnData: "0x" };
  }
}

/** Encode a contract function call for multicall batching. */
export function encodeCall(
  iface: ethers.Interface,
  functionName: string,
  args: unknown[],
): string {
  return iface.encodeFunctionData(functionName, args);
}

/** Decode a multicall sub-call result. */
export function decodeResult(
  iface: ethers.Interface,
  functionName: string,
  data: string,
): ethers.Result {
  return iface.decodeFunctionResult(functionName, data);
}
