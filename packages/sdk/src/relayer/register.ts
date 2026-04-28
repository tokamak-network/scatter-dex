import { ethers } from "ethers";
import { ERC20_ABI, IDENTITY_GATE_IFACE, RELAYER_REGISTRY_IFACE } from "../core/contracts";
import { callExceptionErrorName } from "./errors";

/** Sentinel for native (msg.value) bond mode — `bondToken()` returns
 *  the zero address on registries deployed in native mode (e.g. on
 *  Tokamak L2 where TON is the native gas token). */
export const NATIVE_BOND_TOKEN = ethers.ZeroAddress;

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
  /** `minBond` rendered as a decimal string for display (assumes 18
   *  decimals, which holds for both native ETH/TON and standard ERC20
   *  TON). Callers can re-format with explicit decimals when needed. */
  minBondEth: string;
  /** ERC20 bond token address, or `NATIVE_BOND_TOKEN` (zero address)
   *  when the registry is in native mode. */
  bondToken: string;
  /** Convenience: true iff `bondToken !== NATIVE_BOND_TOKEN`. */
  isErc20Bond: boolean;
  /** ERC20 allowance the operator has already granted the registry,
   *  in token base units. `0n` in native mode (no approval needed). */
  bondAllowance: bigint;
}

/** Read the prerequisite state for relayer registration: identity
 *  verification, prior active-relayer status, the registry's current
 *  minimum bond, and (in ERC20 mode) the operator's existing allowance. */
export async function loadRegistrationStatus(
  registryAddress: string,
  account: string,
  provider: ethers.Provider,
): Promise<RegistrationStatus> {
  const registry = new ethers.Contract(registryAddress, RELAYER_REGISTRY_IFACE, provider);
  const idRegistryAddr = (await registry.identityRegistry()) as string;
  const idRegistry = new ethers.Contract(idRegistryAddr, IDENTITY_GATE_IFACE, provider);

  // Always issue all five reads in parallel — `verifiedUntil` is
  // meaningless when `isVerified` is false, but the wasted call
  // costs less than the extra round-trip a sequential branch
  // would add on the (common) verified path.
  const [isVerified, verifiedUntilRaw, alreadyRegistered, minBond, bondToken] = await Promise.all([
    idRegistry.isVerified(account) as Promise<boolean>,
    idRegistry.verifiedUntil(account) as Promise<bigint>,
    registry.isActiveRelayer(account) as Promise<boolean>,
    registry.minBond() as Promise<bigint>,
    registry.bondToken() as Promise<string>,
  ]);

  const isErc20Bond = bondToken !== NATIVE_BOND_TOKEN;
  const bondAllowance = isErc20Bond
    ? (await new ethers.Contract(bondToken, ERC20_ABI, provider).allowance(account, registryAddress) as bigint)
    : 0n;

  return {
    isVerified,
    verifiedUntil: isVerified ? Number(verifiedUntilRaw) : 0,
    alreadyRegistered,
    minBond,
    minBondEth: ethers.formatEther(minBond),
    bondToken,
    isErc20Bond,
    bondAllowance,
  };
}

export interface RegisterRelayerParams {
  url: string;
  feeBps: number;
  /** Bond as a decimal string (e.g. `"0.1"`). 18 decimals assumed
   *  (matches native ETH/TON and standard ERC20 TON). Parsed internally
   *  so callers don't need their own ethers dependency. */
  bondEth: string;
  /** Required when the registry is in ERC20 mode. Use the value from
   *  `RegistrationStatus.bondToken`. Pass `NATIVE_BOND_TOKEN` (or omit)
   *  for native mode. */
  bondToken?: string;
}

/** Submit `register(url, fee, bondAmount)`.
 *  - Native mode (`bondToken` omitted or zero): bond paid via `msg.value`.
 *  - ERC20 mode: caller MUST `approve` the registry for at least
 *    `bondAmount` first (see `approveBondToken`); this helper just
 *    submits the register call.
 *
 *  Validates fee range and bond format up front so the user sees a
 *  clean error before a wallet prompt. Returns the transaction
 *  response; caller awaits `.wait()`. */
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

  const isErc20 = !!params.bondToken && params.bondToken !== NATIVE_BOND_TOKEN;
  const registry = new ethers.Contract(registryAddress, RELAYER_REGISTRY_IFACE, signer);
  if (isErc20) {
    return registry.register(params.url, BigInt(params.feeBps), bond) as Promise<ethers.TransactionResponse>;
  }
  // Native: bondAmount param MUST be 0; bond comes from msg.value.
  return registry.register(params.url, BigInt(params.feeBps), 0n, { value: bond }) as Promise<ethers.TransactionResponse>;
}

/** True when the registry is in ERC20 mode AND the operator's
 *  current allowance is below the desired bond amount, i.e. an
 *  `approve` is required before `register` / `addBond` can succeed.
 *  Returns false in native mode regardless of the input. */
export function needsBondApproval(status: RegistrationStatus, bondEth: string): boolean {
  if (!status.isErc20Bond) return false;
  let needed: bigint;
  try { needed = ethers.parseEther(bondEth || "0"); }
  catch { return false; }
  return status.bondAllowance < needed;
}

/** Submit `ERC20.approve(registry, amount)` so the operator can
 *  subsequently `register` or `addBond` in ERC20 mode. Native-mode
 *  registries never need this. Returns the transaction response;
 *  caller awaits `.wait()` before submitting the register call. */
export async function approveBondToken(
  bondToken: string,
  registryAddress: string,
  bondEth: string,
  signer: ethers.Signer,
): Promise<ethers.TransactionResponse> {
  let amount: bigint;
  try { amount = ethers.parseEther(bondEth || "0"); }
  catch { throw new Error("InvalidBond"); }
  const token = new ethers.Contract(bondToken, ERC20_ABI, signer);
  return token.approve(registryAddress, amount) as Promise<ethers.TransactionResponse>;
}

/** Static error-code → copy table. Hoisted to module scope so it
 *  isn't reallocated on every `explainRegistryError` call.
 *  `InsufficientBond` is handled separately because it interpolates
 *  the per-call `minBond`. Covers every revert custom error the
 *  registry can raise across register / updateInfo / addBond /
 *  requestExit / executeExit, plus the local validation strings
 *  the SDK helpers throw for invalid input. */
const STATIC_REGISTRY_ERROR_COPY: Record<string, string> = {
  NotVerified: "zk-X509 identity not verified. Register your identity first.",
  AlreadyRegistered: "This address is already registered as a relayer.",
  NotRegistered: "This address is not registered as a relayer.",
  RelayerNotActive: "Relayer is not active. Re-register before performing this action.",
  AlreadyExiting: "An exit is already in progress. Wait for the cool-down to complete.",
  ExitNotRequested: "Request an exit before executing it.",
  CooldownNotPassed: "Exit cool-down has not finished yet. Wait until the timer ends.",
  BondTransferFailed: "Bond transfer failed during exit. Try again, or check that your address can receive the bond token.",
  FeeTooHigh: `Fee too high. Maximum: ${MAX_RELAYER_FEE_BPS} bps (${MAX_RELAYER_FEE_BPS / 100}%).`,
  InvalidFee: `Fee must be an integer between 0 and ${MAX_RELAYER_FEE_BPS} bps.`,
  InvalidBond: "Invalid bond amount. Enter a valid value.",
  WrongPaymentMode: "Wrong payment mode for this registry. Approve and pass the bond as an ERC20 amount, or send native value (one or the other, not both).",
};

const REGISTRY_ERROR_CODES = Object.keys(STATIC_REGISTRY_ERROR_COPY).concat(["InsufficientBond"]);

function copyForRegistryError(code: string, minBond: bigint): string | null {
  if (code === "InsufficientBond") {
    return `Insufficient bond. Minimum: ${ethers.formatEther(minBond)} ETH`;
  }
  return STATIC_REGISTRY_ERROR_COPY[code] ?? null;
}

/** Map known registry custom errors (decoded by ethers from the
 *  ABI fragments on `RELAYER_REGISTRY_ABI`) and local validation
 *  errors thrown from any registry write helper to user-friendly
 *  copy. Falls back to the raw message when no rule matches so
 *  callers don't swallow unexpected errors. `minBond` is only used
 *  when the error is `InsufficientBond`; pass `0n` if unknown. */
export function explainRegistryError(err: unknown, minBond: bigint): string {
  const named = callExceptionErrorName(err);
  if (named) {
    const copy = copyForRegistryError(named, minBond);
    if (copy) return copy;
  }

  const raw = err instanceof Error ? err.message : String(err);
  for (const code of REGISTRY_ERROR_CODES) {
    if (raw.includes(code)) {
      const copy = copyForRegistryError(code, minBond);
      if (copy) return copy;
    }
  }
  return raw;
}
