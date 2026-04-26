import { ethers } from "ethers";

/** Build a read-only JsonRpcProvider for a chain's RPC.
 *
 *  No singleton/cache here — caller decides lifetime. The React wallet
 *  hook caches one per `NetworkConfig` so React renders share an
 *  instance, but Node scripts and tests usually want fresh providers.
 *
 *  Use `getReadProvider` when you only need to read chain state
 *  (balances, events, view calls). Signing requires a wallet
 *  connection — see `useWallet` in `@zkscatter/sdk/react`. */
export function getReadProvider(rpcUrl: string): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(rpcUrl);
}
