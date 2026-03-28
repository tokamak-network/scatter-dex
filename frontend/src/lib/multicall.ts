import { ethers } from "ethers";

// Multicall3 is deployed at the same address on all EVM chains
// https://www.multicall3.com/
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const MULTICALL3_ABI = [
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

// Max calls per batch to avoid gas limit / RPC response size issues
const MAX_BATCH_SIZE = 100;

/**
 * Batch multiple read-only contract calls into a single RPC request via Multicall3.
 * Automatically chunks large batches. Falls back to individual calls if Multicall3 is unavailable.
 *
 * All calls use allowFailure=true semantics — failed calls return { success: false }
 * instead of reverting the entire batch. Callers must check `result.success` per item.
 */
export async function multicall(
  provider: ethers.Provider,
  requests: MulticallRequest[]
): Promise<MulticallResult[]> {
  if (requests.length === 0) return [];

  // Single call — no need for multicall overhead
  if (requests.length === 1) {
    try {
      const result = await provider.call({
        to: requests[0].target,
        data: requests[0].callData,
      });
      return [{ success: true, returnData: result }];
    } catch {
      return [{ success: false, returnData: "0x" }];
    }
  }

  try {
    const mc = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);

    // Chunk into batches of MAX_BATCH_SIZE
    const allResults: MulticallResult[] = [];
    for (let i = 0; i < requests.length; i += MAX_BATCH_SIZE) {
      const chunk = requests.slice(i, i + MAX_BATCH_SIZE);
      const calls = chunk.map((r) => ({
        target: r.target,
        allowFailure: true,
        callData: r.callData,
      }));
      const results: { success: boolean; returnData: string }[] = await mc.aggregate3.staticCall(calls);
      allResults.push(...results.map((r) => ({ success: r.success, returnData: r.returnData })));
    }
    return allResults;
  } catch (err) {
    // Multicall3 unavailable (local testnet) — fall back to individual calls
    console.warn("[multicall] Multicall3 unavailable, falling back to individual calls:", err);
    return Promise.all(
      requests.map(async (r) => {
        try {
          const result = await provider.call({ to: r.target, data: r.callData });
          return { success: true, returnData: result };
        } catch {
          return { success: false, returnData: "0x" };
        }
      })
    );
  }
}

/**
 * Helper to encode a contract function call for multicall batching.
 */
export function encodeCall(iface: ethers.Interface, functionName: string, args: unknown[]): string {
  return iface.encodeFunctionData(functionName, args);
}

/**
 * Helper to decode a multicall result.
 */
export function decodeResult(iface: ethers.Interface, functionName: string, data: string): ethers.Result {
  return iface.decodeFunctionResult(functionName, data);
}
