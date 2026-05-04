import { ethers } from "ethers";
import { RELAYER_REGISTRY_IFACE } from "../core/contracts";

/** UI-friendly status derived from the on-chain `relayers()` row.
 *  - `unregistered`: never registered on this registry
 *  - `active`: registered, not in the exit cool-down
 *  - `cooldown`: requested exit, waiting out the 7-day cool-down
 *  - `offline`: registered + exit executed (the row's `active` flag
 *    is false but `registeredAt` is non-zero) */
export type OperatorStatus = "active" | "cooldown" | "offline" | "unregistered";

export interface OperatorRow {
  url: string;
  /** On-chain display name (may be empty for legacy registrations). */
  name: string;
  feeBps: number;
  bond: bigint;
  bondEth: string;
  /** Unix seconds the operator first registered, `0` when never
   *  registered. */
  registeredAt: number;
  /** Unix seconds the operator requested exit, `0` when not in
   *  the cool-down window. */
  exitRequestedAt: number;
  active: boolean;
  status: OperatorStatus;
  /** Bond token address, or `ZeroAddress` for native (msg.value)
   *  mode. Lets bond top-up UIs decide whether an `approve` step is
   *  needed before `addBond`. */
  bondToken: string;
}

function deriveStatus(active: boolean, registeredAt: number, exitRequestedAt: number): OperatorStatus {
  if (registeredAt === 0) return "unregistered";
  if (!active) return "offline";
  return exitRequestedAt > 0 ? "cooldown" : "active";
}

/** Module-level cache for `bondToken` keyed by registry address.
 *  The bond token is fixed at construction (immutable on the
 *  contract), so one read per registry is enough — every subsequent
 *  `loadOperatorRow` reuses the cached value and stays at one RPC. */
const bondTokenCache = new Map<string, string>();

async function resolveBondToken(
  registryAddress: string,
  registry: ethers.Contract,
): Promise<string> {
  const key = registryAddress.toLowerCase();
  const cached = bondTokenCache.get(key);
  if (cached !== undefined) return cached;
  const value = (await registry.bondToken()) as string;
  bondTokenCache.set(key, value);
  return value;
}

/** Read the on-chain registry row for `account`. Returns the full
 *  set of operator-scoped state every dashboard / profile / treasury
 *  page needs, plus a derived `status` for UI gating. Pure read.
 *
 *  Issues one RPC after the first call per registry: the row read.
 *  `bondToken` is fetched once and memoised because it's immutable. */
export async function loadOperatorRow(
  registryAddress: string,
  account: string,
  provider: ethers.Provider,
): Promise<OperatorRow> {
  const registry = new ethers.Contract(registryAddress, RELAYER_REGISTRY_IFACE, provider);
  const cachedBondToken = bondTokenCache.get(registryAddress.toLowerCase());
  // First call per registry: parallelise the bondToken fetch with
  // the row read so we don't pay an extra round-trip. After the
  // first call the cache short-circuits and only the row reads ride.
  const [r, bondToken] = cachedBondToken !== undefined
    ? [await registry.relayers(account), cachedBondToken]
    : await Promise.all([
        registry.relayers(account),
        resolveBondToken(registryAddress, registry),
      ]);
  const active = r.active as boolean;
  const registeredAt = Number(r.registeredAt);
  const exitRequestedAt = Number(r.exitRequestedAt);
  const bond = r.bond as bigint;
  return {
    url: r.url as string,
    name: (r.name as string) ?? "",
    feeBps: Number(r.fee),
    bond,
    bondEth: ethers.formatEther(bond),
    registeredAt,
    exitRequestedAt,
    active,
    status: deriveStatus(active, registeredAt, exitRequestedAt),
    bondToken,
  };
}
