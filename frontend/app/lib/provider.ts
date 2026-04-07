import { ethers } from "ethers";
import { RPC_URL } from "./config";

/** Shared read-only provider singleton — reuse instead of creating new instances per component. */
let _provider: ethers.JsonRpcProvider | undefined;

export function getReadProvider(): ethers.JsonRpcProvider {
  if (!_provider) _provider = new ethers.JsonRpcProvider(RPC_URL);
  return _provider;
}
