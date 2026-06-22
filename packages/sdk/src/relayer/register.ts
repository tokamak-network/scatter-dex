import { ethers } from "ethers";
import { ERC20_ABI, IDENTITY_GATE_IFACE, RELAYER_REGISTRY_IFACE } from "../core/contracts";
import { formatTokenAmount } from "../util/format";
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
  /** `minBond` rendered as a decimal string for display, formatted with
   *  the bond token's own `bondTokenDecimals` (so it's correct for ERC20
   *  bonds that don't use 18 decimals, not just native ETH/TON). */
  minBondEth: string;
  /** ERC20 bond token address, or `NATIVE_BOND_TOKEN` (zero address)
   *  when the registry is in native mode. */
  bondToken: string;
  /** Convenience: true iff `bondToken !== NATIVE_BOND_TOKEN`. */
  isErc20Bond: boolean;
  /** Bond token symbol for display — `"ETH"` in native mode, else the
   *  ERC20 token's `symbol()` (e.g. `"TON"`). The admin sets the bond
   *  token on-chain; the UI must surface whatever it actually is rather
   *  than assuming ETH. */
  bondTokenSymbol: string;
  /** Bond token decimals — `18` in native mode, else the ERC20
   *  `decimals()`. Use this to parse/format bond amounts. */
  bondTokenDecimals: number;
  /** ERC20 allowance the operator has already granted the registry,
   *  in token base units. `0n` in native mode (no approval needed). */
  bondAllowance: bigint;
  /** Operator's current balance of the bond token (native ETH balance
   *  in native mode), in token base units. Lets the UI warn before a
   *  wallet prompt when the operator can't cover the bond. */
  bondBalance: bigint;
  /** `bondBalance` rendered with `bondTokenDecimals` for display. */
  bondBalanceFormatted: string;
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

  // Round-trip 1: discover the two satellite addresses in parallel —
  // identity registry (for verification reads) and bond token
  // (decides whether we need an allowance read). Folding `bondToken`
  // into this batch lets the allowance call ride the same round-trip
  // as the verification/registration reads below.
  const [idRegistryAddr, bondToken] = await Promise.all([
    registry.identityRegistry() as Promise<string>,
    registry.bondToken() as Promise<string>,
  ]);
  const idRegistry = new ethers.Contract(idRegistryAddr, IDENTITY_GATE_IFACE, provider);
  const isErc20Bond = bondToken !== NATIVE_BOND_TOKEN;

  // Round-trip 2: all remaining reads in parallel. `verifiedUntil` is
  // meaningless when `isVerified` is false, but the wasted call costs
  // less than the extra round-trip a sequential branch would add on
  // the (common) verified path. In ERC20 mode we also read the token's
  // symbol/decimals (for display) and the operator's allowance +
  // balance (to gate approval and warn on an under-funded wallet). In
  // native mode the bond is ETH: symbol/decimals are fixed and the
  // "balance" is the account's native balance. symbol()/decimals() are
  // wrapped so a non-standard token can't fail the whole status load.
  const erc = isErc20Bond ? new ethers.Contract(bondToken, ERC20_ABI, provider) : null;
  const allowancePromise = erc
    ? (erc.allowance(account, registryAddress) as Promise<bigint>)
    : Promise.resolve(0n);
  const balancePromise = erc
    ? (erc.balanceOf(account) as Promise<bigint>)
    : provider.getBalance(account);
  const symbolPromise = erc
    ? (erc.symbol() as Promise<string>).catch(() => "token")
    : Promise.resolve("ETH");
  const decimalsPromise = erc
    ? (erc.decimals() as Promise<bigint | number>).then(Number).catch(() => 18)
    : Promise.resolve(18);
  const [isVerified, verifiedUntilRaw, alreadyRegistered, minBond, bondAllowance, bondBalance, bondTokenSymbol, bondTokenDecimals] = await Promise.all([
    idRegistry.isVerified(account) as Promise<boolean>,
    idRegistry.verifiedUntil(account) as Promise<bigint>,
    registry.isActiveRelayer(account) as Promise<boolean>,
    registry.minBond() as Promise<bigint>,
    allowancePromise,
    balancePromise,
    symbolPromise,
    decimalsPromise,
  ]);

  return {
    isVerified,
    verifiedUntil: isVerified ? Number(verifiedUntilRaw) : 0,
    alreadyRegistered,
    minBond,
    minBondEth: formatTokenAmount(minBond, bondTokenDecimals),
    bondToken,
    isErc20Bond,
    bondTokenSymbol,
    bondTokenDecimals,
    bondAllowance,
    bondBalance,
    bondBalanceFormatted: formatTokenAmount(bondBalance, bondTokenDecimals),
  };
}

export interface RegisterRelayerParams {
  url: string;
  /** On-chain display name surfaced via `relayers()` and consumed by
   *  Pay/Operators UIs. Optional — defaults to empty when omitted. */
  name?: string;
  feeBps: number;
  /** Bond as a decimal string (e.g. `"0.1"`). Parsed internally with
   *  `bondDecimals` so callers don't need their own ethers dependency. */
  bondEth: string;
  /** Required when the registry is in ERC20 mode. Use the value from
   *  `RegistrationStatus.bondToken`. Pass `NATIVE_BOND_TOKEN` (or omit)
   *  for native mode. */
  bondToken?: string;
  /** Decimals to parse `bondEth` with. Defaults to 18 (native ETH and
   *  standard ERC20 TON); pass `RegistrationStatus.bondTokenDecimals`
   *  for an ERC20 bond token with non-18 decimals. */
  bondDecimals?: number;
}

/** Submit `register(url, name, fee, bondAmount)`.
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
  try { bond = ethers.parseUnits(params.bondEth || "0", params.bondDecimals ?? 18); }
  catch { throw new Error("InvalidBond"); }

  const isErc20 = !!params.bondToken && params.bondToken !== NATIVE_BOND_TOKEN;
  const registry = new ethers.Contract(registryAddress, RELAYER_REGISTRY_IFACE, signer);
  const name = params.name ?? "";
  if (isErc20) {
    return registry.register(params.url, name, BigInt(params.feeBps), bond) as Promise<ethers.TransactionResponse>;
  }
  // Native: bondAmount param MUST be 0; bond comes from msg.value.
  return registry.register(params.url, name, BigInt(params.feeBps), 0n, { value: bond }) as Promise<ethers.TransactionResponse>;
}

/** True when the registry is in ERC20 mode AND the operator's
 *  current allowance is below the desired bond amount, i.e. an
 *  `approve` is required before `register` / `addBond` can succeed.
 *  Returns false in native mode regardless of the input. */
export function needsBondApproval(status: RegistrationStatus, bondEth: string): boolean {
  if (!status.isErc20Bond) return false;
  let needed: bigint;
  try { needed = ethers.parseUnits(bondEth || "0", status.bondTokenDecimals); }
  catch { return false; }
  return status.bondAllowance < needed;
}

/** True when the operator holds enough of the bond token to cover
 *  `bondEth` — i.e. `bondBalance >= parse(bondEth)`. In native mode
 *  `bondBalance` is the account's ETH balance, so this only checks the
 *  bond amount, not the extra gas the register tx needs. Returns true
 *  on an unparseable amount so a transient input state never blocks the
 *  form (the on-chain transfer/`msg.value` still guards the bond). */
export function hasEnoughBondBalance(status: RegistrationStatus, bondEth: string): boolean {
  let needed: bigint;
  try { needed = ethers.parseUnits(bondEth || "0", status.bondTokenDecimals); }
  catch { return true; }
  return status.bondBalance >= needed;
}

/** Read the operator's current ERC20 bond-token allowance to the
 *  registry. Returns `0n` in native mode (no token to query). Useful
 *  for top-up UIs that already know the bond token (e.g. via
 *  `OperatorRow.bondToken`) but only need the live allowance. */
export async function loadBondAllowance(
  registryAddress: string,
  bondToken: string,
  account: string,
  provider: ethers.Provider,
): Promise<bigint> {
  if (bondToken === NATIVE_BOND_TOKEN) return 0n;
  const token = new ethers.Contract(bondToken, ERC20_ABI, provider);
  return token.allowance(account, registryAddress) as Promise<bigint>;
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
  bondDecimals: number = 18,
): Promise<ethers.TransactionResponse> {
  let amount: bigint;
  try { amount = ethers.parseUnits(bondEth || "0", bondDecimals); }
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

/** Bond token metadata used to render the `InsufficientBond` minimum
 *  in the operator's actual bond token rather than assuming ETH. */
export interface BondMeta {
  symbol?: string;
  decimals?: number;
}

function copyForRegistryError(code: string, minBond: bigint, bond?: BondMeta): string | null {
  if (code === "InsufficientBond") {
    const decimals = bond?.decimals ?? 18;
    const symbol = bond?.symbol ?? "ETH";
    return `Insufficient bond. Minimum: ${formatTokenAmount(minBond, decimals)} ${symbol}`;
  }
  return STATIC_REGISTRY_ERROR_COPY[code] ?? null;
}

/** Map known registry custom errors (decoded by ethers from the
 *  ABI fragments on `RELAYER_REGISTRY_ABI`) and local validation
 *  errors thrown from any registry write helper to user-friendly
 *  copy. Falls back to the raw message when no rule matches so
 *  callers don't swallow unexpected errors. `minBond` is only used
 *  when the error is `InsufficientBond`; pass `0n` if unknown. */
export function explainRegistryError(err: unknown, minBond: bigint, bond?: BondMeta): string {
  const named = callExceptionErrorName(err);
  if (named) {
    const copy = copyForRegistryError(named, minBond, bond);
    if (copy) return copy;
  }

  const raw = err instanceof Error ? err.message : String(err);
  for (const code of REGISTRY_ERROR_CODES) {
    if (raw.includes(code)) {
      const copy = copyForRegistryError(code, minBond, bond);
      if (copy) return copy;
    }
  }
  return raw;
}
