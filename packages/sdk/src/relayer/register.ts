import { ethers } from "ethers";
import { IDENTITY_GATE_IFACE, RELAYER_REGISTRY_IFACE } from "../core/contracts";

/** Maximum per-trade fee a relayer may register, in basis points.
 *  Mirrors `RelayerRegistry.MAX_FEE` (50 bps) — kept in sync here so
 *  the SDK can reject invalid input before a wallet prompt and so
 *  consumer apps don't redeclare the magic number. */
export const MAX_RELAYER_FEE_BPS = 500;

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
  if (!Number.isInteger(params.feeBps) || params.feeBps < 0) {
    throw new Error("InvalidFee");
  }
  if (params.feeBps > MAX_RELAYER_FEE_BPS) {
    throw new Error("FeeTooHigh");
  }
  let bond: bigint;
  try { bond = ethers.parseEther(params.bondEth || "0"); }
  catch { throw new Error("InvalidBond"); }

  const registry = new ethers.Contract(registryAddress, RELAYER_REGISTRY_IFACE, signer);
  return registry.register(params.url, BigInt(params.feeBps), { value: bond }) as Promise<ethers.TransactionResponse>;
}

/** Read the named error off ethers v6 contract-call exceptions
 *  when the ABI carries the matching error fragment. Falls back to
 *  null so callers can substring-match the message instead. */
function callExceptionErrorName(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { revert?: { name?: string } | null; errorName?: string };
  return e.revert?.name ?? e.errorName ?? null;
}

/** Static error-code → copy table. Hoisted to module scope so it
 *  isn't reallocated on every `explainRegisterError` call.
 *  `InsufficientBond` is handled separately because it interpolates
 *  the per-call `minBond`. */
const STATIC_REGISTER_ERROR_COPY: Record<string, string> = {
  NotVerified: "zk-X509 identity not verified. Register your identity first.",
  AlreadyRegistered: "This address is already registered as a relayer.",
  FeeTooHigh: `Fee too high. Maximum: ${MAX_RELAYER_FEE_BPS} bps (${MAX_RELAYER_FEE_BPS / 100}%).`,
  InvalidFee: `Fee must be an integer between 0 and ${MAX_RELAYER_FEE_BPS} bps.`,
  InvalidBond: "Invalid bond amount. Enter a valid ETH value.",
};

const REGISTER_ERROR_CODES = [
  "NotVerified",
  "AlreadyRegistered",
  "InsufficientBond",
  "FeeTooHigh",
  "InvalidFee",
  "InvalidBond",
] as const;

function copyForRegisterError(code: string, minBond: bigint): string | null {
  if (code === "InsufficientBond") {
    return `Insufficient bond. Minimum: ${ethers.formatEther(minBond)} ETH`;
  }
  return STATIC_REGISTER_ERROR_COPY[code] ?? null;
}

/** Map known contract custom errors (decoded by ethers from the
 *  ABI fragments on `RELAYER_REGISTRY_ABI`) and local validation
 *  errors thrown from `registerRelayer` to user-friendly copy.
 *  Falls back to the raw message when no rule matches so callers
 *  don't swallow unexpected errors. */
export function explainRegisterError(err: unknown, minBond: bigint): string {
  const named = callExceptionErrorName(err);
  if (named) {
    const copy = copyForRegisterError(named, minBond);
    if (copy) return copy;
  }

  const raw = err instanceof Error ? err.message : String(err);
  for (const code of REGISTER_ERROR_CODES) {
    if (raw.includes(code)) {
      const copy = copyForRegisterError(code, minBond);
      if (copy) return copy;
    }
  }
  return raw;
}
