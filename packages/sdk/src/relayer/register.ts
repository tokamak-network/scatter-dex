import { ethers } from "ethers";
import { IDENTITY_GATE_IFACE, RELAYER_REGISTRY_IFACE } from "../core/contracts";

export interface RegistrationStatus {
  isVerified: boolean;
  /** Unix seconds the identity verification expires at; `0` when
   *  not verified. */
  verifiedUntil: number;
  alreadyRegistered: boolean;
  minBond: bigint;
  /** `minBond` rendered as ETH for display, so callers don't need
   *  their own ethers dependency to print it. */
  minBondEth: string;
}

/** Read the prerequisite state for relayer registration: identity
 *  verification, prior active-relayer status, and the registry's
 *  current minimum bond. Pure read. */
export async function loadRegistrationStatus(
  registryAddress: string,
  account: string,
  provider: ethers.Provider,
): Promise<RegistrationStatus> {
  const registry = new ethers.Contract(registryAddress, RELAYER_REGISTRY_IFACE, provider);
  const idRegistryAddr = (await registry.identityRegistry()) as string;
  const idRegistry = new ethers.Contract(idRegistryAddr, IDENTITY_GATE_IFACE, provider);

  // Always issue all four reads in parallel — `verifiedUntil` is
  // meaningless when `isVerified` is false, but the wasted call
  // costs less than the extra round-trip a sequential branch
  // would add on the (common) verified path.
  const [isVerified, verifiedUntilRaw, alreadyRegistered, minBond] = await Promise.all([
    idRegistry.isVerified(account) as Promise<boolean>,
    idRegistry.verifiedUntil(account) as Promise<bigint>,
    registry.isActiveRelayer(account) as Promise<boolean>,
    registry.minBond() as Promise<bigint>,
  ]);

  return {
    isVerified,
    verifiedUntil: isVerified ? Number(verifiedUntilRaw) : 0,
    alreadyRegistered,
    minBond,
    minBondEth: ethers.formatEther(minBond),
  };
}

export interface RegisterRelayerParams {
  url: string;
  feeBps: number;
  /** Bond as a decimal-ETH string (e.g. `"0.1"`). Parsed internally
   *  so callers don't need their own ethers dependency. */
  bondEth: string;
}

/** Submit `register(url, fee)` with the given bond as `msg.value`.
 *  Validates the fee range and bond format up front so the user
 *  sees a clean error before a wallet prompt. Returns the
 *  transaction response; caller awaits `.wait()`. */
export async function registerRelayer(
  registryAddress: string,
  params: RegisterRelayerParams,
  signer: ethers.Signer,
): Promise<ethers.TransactionResponse> {
  if (!Number.isInteger(params.feeBps) || params.feeBps < 0 || params.feeBps > 500) {
    throw new Error("FeeTooHigh");
  }
  let bond: bigint;
  try { bond = ethers.parseEther(params.bondEth || "0"); }
  catch { throw new Error("InvalidBond"); }

  const registry = new ethers.Contract(registryAddress, RELAYER_REGISTRY_IFACE, signer);
  return registry.register(params.url, BigInt(params.feeBps), { value: bond }) as Promise<ethers.TransactionResponse>;
}

/** Map known contract revert reasons (raised as plain strings by
 *  the registry's `require()` checks) to user-friendly copy. Falls
 *  back to the raw message when no rule matches so callers don't
 *  swallow unexpected errors. */
export function explainRegisterError(err: unknown, minBond: bigint): string {
  const raw = err instanceof Error ? err.message : String(err);
  const rules: Array<[needle: string, copy: string]> = [
    ["NotVerified", "zk-X509 identity not verified. Register your identity first."],
    ["AlreadyRegistered", "This address is already registered as a relayer."],
    ["InsufficientBond", `Insufficient bond. Minimum: ${ethers.formatEther(minBond)} ETH`],
    ["FeeTooHigh", "Fee too high. Maximum: 500 bps (5%)."],
    ["InvalidBond", "Invalid bond amount. Enter a valid ETH value."],
  ];
  for (const [needle, copy] of rules) if (raw.includes(needle)) return copy;
  return raw;
}
