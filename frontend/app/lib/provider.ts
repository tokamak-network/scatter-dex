import { ethers } from "ethers";
import { RPC_URL } from "./config";

/** Shared read-only provider singleton — reuse instead of creating new instances per component. */
let _provider: ethers.JsonRpcProvider | undefined;

export function getReadProvider(): ethers.JsonRpcProvider {
  if (typeof window === "undefined") {
    // SSR: return a fresh instance (not cached) to avoid holding connections during build
    return new ethers.JsonRpcProvider(RPC_URL);
  }
  if (!_provider) _provider = new ethers.JsonRpcProvider(RPC_URL);
  return _provider;
}
