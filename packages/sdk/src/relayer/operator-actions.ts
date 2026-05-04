import { ethers } from "ethers";
import { RELAYER_REGISTRY_IFACE } from "../core/contracts";
import { MAX_RELAYER_FEE_BPS, NATIVE_BOND_TOKEN } from "./register";

/** Mirrors `RelayerRegistry.EXIT_COOLDOWN`. The contract exposes
 *  it as a public constant; we mirror the value here so callers
 *  can render the cool-down countdown without an extra RPC read.
 *  Keep in sync if governance ever rewrites the constant. */
export const EXIT_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;

export interface UpdateRelayerInfoParams {
  url: string;
  /** On-chain display name. Optional — defaults to empty when omitted. */
  name?: string;
  feeBps: number;
}

/** Submit `updateInfo(url, name, fee)` — operator-self-service edit
 *  of endpoint URL, display name, and per-trade fee. Validates the
 *  fee range up front for the same UX reason `registerRelayer` does. */
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
  return registry.updateInfo(params.url, params.name ?? "", BigInt(params.feeBps)) as Promise<ethers.TransactionResponse>;
}

/** Submit `addBond(bondAmount)`.
 *  - Native mode: top-up paid via `msg.value`.
 *  - ERC20 mode: caller MUST `approve` the registry for at least
 *    `bondEth` first (see `approveBondToken`); this helper just
 *    submits the addBond call.
 *
 *  When `bondToken` is omitted, the helper reads `bondToken()` from
 *  the registry itself — convenient for simple top-up UIs that already
 *  hold the registry address but not its mode.
 *
 *  Rejects zero / negative amounts before a wallet prompt. */
export async function addRelayerBond(
  registryAddress: string,
  bondEth: string,
  signer: ethers.Signer,
  bondToken?: string,
): Promise<ethers.TransactionResponse> {
  let bond: bigint;
  try { bond = ethers.parseEther(bondEth || "0"); }
  catch { throw new Error("InvalidBond"); }
  if (bond <= 0n) throw new Error("InvalidBond");

  const registry = new ethers.Contract(registryAddress, RELAYER_REGISTRY_IFACE, signer);
  const resolvedBondToken = bondToken ?? (await registry.bondToken() as string);
  const isErc20 = resolvedBondToken !== NATIVE_BOND_TOKEN;
  if (isErc20) {
    return registry.addBond(bond) as Promise<ethers.TransactionResponse>;
  }
  return registry.addBond(0n, { value: bond }) as Promise<ethers.TransactionResponse>;
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
