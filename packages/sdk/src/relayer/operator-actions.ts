import { ethers } from "ethers";
import { RELAYER_REGISTRY_IFACE } from "../core/contracts";
import { MAX_RELAYER_FEE_BPS } from "./register";

/** Mirrors `RelayerRegistry.EXIT_COOLDOWN`. The contract exposes
 *  it as a public constant; we mirror the value here so callers
 *  can render the cool-down countdown without an extra RPC read.
 *  Keep in sync if governance ever rewrites the constant. */
export const EXIT_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;

export interface UpdateRelayerInfoParams {
  url: string;
  feeBps: number;
}

/** Submit `updateInfo(url, fee)` — operator-self-service edit of
 *  endpoint URL + per-trade fee. Validates the fee range up front
 *  for the same UX reason `registerRelayer` does. */
export async function updateRelayerInfo(
  registryAddress: string,
  params: UpdateRelayerInfoParams,
  signer: ethers.Signer,
): Promise<ethers.TransactionResponse> {
  if (!Number.isInteger(params.feeBps) || params.feeBps < 0) {
    throw new Error("InvalidFee");
  }
  if (params.feeBps > MAX_RELAYER_FEE_BPS) {
    throw new Error("FeeTooHigh");
  }
  const registry = new ethers.Contract(registryAddress, RELAYER_REGISTRY_IFACE, signer);
  return registry.updateInfo(params.url, BigInt(params.feeBps)) as Promise<ethers.TransactionResponse>;
}

/** Submit `addBond()` with the given top-up as `msg.value`.
 *  Rejects zero / negative amounts before a wallet prompt. */
export async function addRelayerBond(
  registryAddress: string,
  bondEth: string,
  signer: ethers.Signer,
): Promise<ethers.TransactionResponse> {
  let bond: bigint;
  try { bond = ethers.parseEther(bondEth || "0"); }
  catch { throw new Error("InvalidBond"); }
  if (bond <= 0n) throw new Error("InvalidBond");
  const registry = new ethers.Contract(registryAddress, RELAYER_REGISTRY_IFACE, signer);
  return registry.addBond({ value: bond }) as Promise<ethers.TransactionResponse>;
}

/** Submit `requestExit()` — flips the operator into the cool-down
 *  window. New orders stop routing immediately; bond becomes
 *  withdrawable via `executeRelayerExit` after `EXIT_COOLDOWN_SECONDS`. */
export async function requestRelayerExit(
  registryAddress: string,
  signer: ethers.Signer,
): Promise<ethers.TransactionResponse> {
  const registry = new ethers.Contract(registryAddress, RELAYER_REGISTRY_IFACE, signer);
  return registry.requestExit() as Promise<ethers.TransactionResponse>;
}

/** Submit `executeExit()` — finalises the exit and returns the
 *  bond. Will revert with `CooldownNotPassed` until the cool-down
 *  window has elapsed; gate the button on `cooldownReadyAt`. */
export async function executeRelayerExit(
  registryAddress: string,
  signer: ethers.Signer,
): Promise<ethers.TransactionResponse> {
  const registry = new ethers.Contract(registryAddress, RELAYER_REGISTRY_IFACE, signer);
  return registry.executeExit() as Promise<ethers.TransactionResponse>;
}
