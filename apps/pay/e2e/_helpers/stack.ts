/**
 * Reachability probes for the local dev stack a "live" Playwright
 * scenario depends on. The full Pay flow (settle / claim /
 * transfer-out) needs three pieces alive at the same time:
 *
 * - **anvil** at `http://127.0.0.1:8545` — the EVM the bridge
 *   broadcasts against.
 * - **zk-relayer** at `http://127.0.0.1:3002` — handles
 *   `/api/info` (relayer discovery) + `/api/authorize-orders`
 *   (settle broadcast).
 * - **Pay** at `http://127.0.0.1:4001` — booted by Playwright's
 *   `webServer` config, so its presence is implicit.
 *
 * Dev.sh (`bash scripts/dev.sh --apps pay --mock`) brings up all
 * three. Tests that need them gate on `isStackReachable` and call
 * `test.skip(!ok, "…")` so the harness still runs without dev.sh —
 * the wallet-less specs and the bridge unit tests stay green on a
 * fresh clone.
 */

const ANVIL_URL = "http://127.0.0.1:8545";
const RELAYER_URL = "http://127.0.0.1:3002";

export interface StackEndpoints {
  rpcUrl: string;
  relayerUrl: string;
}

export const DEV_STACK_ENDPOINTS: StackEndpoints = {
  rpcUrl: ANVIL_URL,
  relayerUrl: RELAYER_URL,
};

/** True when both anvil and the zk-relayer are reachable. Returns
 *  fast — a single GET each, no retries — because the "is dev.sh
 *  up?" question is binary; if it isn't, retries can't fix it.
 *  Network errors / non-2xx / parse failures all collapse to false. */
export async function isStackReachable(): Promise<boolean> {
  const [anvilOk, relayerOk] = await Promise.all([
    isAnvilReachable(ANVIL_URL),
    isRelayerReachable(RELAYER_URL),
  ]);
  return anvilOk && relayerOk;
}

/** Cheap reachability check for anvil: a single `eth_chainId` post.
 *  Exposed standalone so tests that only need the chain (no
 *  relayer) can probe just anvil. */
export async function isAnvilReachable(url: string = ANVIL_URL): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { result?: string };
    return typeof json.result === "string";
  } catch {
    return false;
  }
}

/** Cheap reachability check for the zk-relayer: GET /api/info, the
 *  endpoint Pay's wizard polls at relayer-discovery time. Exposed
 *  standalone so tests that only need relayer presence (no anvil
 *  broadcast yet) can probe just it. */
export async function isRelayerReachable(url: string = RELAYER_URL): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/info`);
    return res.ok;
  } catch {
    return false;
  }
}
