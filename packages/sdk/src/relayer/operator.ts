import { ethers } from "ethers";
import { RELAYER_REGISTRY_IFACE } from "../core/contracts";

/** UI-friendly status derived from the on-chain `relayers()` row.
 *  - `unregistered`: never registered on this registry
 *  - `active`: registered, not in the exit cool-down
 *  - `cooldown`: requested exit, waiting out the exit cool-down
 *  - `offline`: registered + exit executed (the row's `active` flag
 *    is false but `registeredAt` is non-zero) */
export type OperatorStatus = "active" | "cooldown" | "offline" | "unregistered";

export interface OperatorRow {
  /** Stable on-chain id — index of this wallet in `relayerList`. -1 when
   *  the wallet has never registered (status "unregistered"). */
  id: number;
  /** The wallet address this row belongs to (== the account passed to
   *  loadOperatorRow). */
  address: string;
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
  const [r, bondToken, count] = cachedBondToken !== undefined
    ? [await registry.relayers(account), cachedBondToken, await registry.getRelayerCount() as bigint]
    : await Promise.all([
        registry.relayers(account),
        resolveBondToken(registryAddress, registry),
        registry.getRelayerCount() as Promise<bigint>,
      ]);
  // Resolve the stable on-chain id (relayerList index). Scan linearly;
  // the list is small in practice and getRelayerCount+relayerList(i) are
  // cheap view calls. -1 when this wallet has never registered.
  const n = Number(count);
  const listAddrs = await Promise.all(
    Array.from({ length: n }, (_, i) => registry.relayerList(i) as Promise<string>),
  );
  const id = listAddrs.findIndex((a) => a.toLowerCase() === account.toLowerCase());
  const active = r.active as boolean;
  const registeredAt = Number(r.registeredAt);
  const exitRequestedAt = Number(r.exitRequestedAt);
  const bond = r.bond as bigint;
  return {
    id,
    address: account,
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

/** Details of an admin-initiated removal (`adminRemoveRelayer`). */
export interface ForceRemoval {
  /** The reason the admin recorded with the removal (may be empty). */
  reason: string;
  /** Unix seconds the bond becomes withdrawable
   *  (`exitRequestedAt + EXIT_COOLDOWN`), straight from the event. */
  exitAfter: number;
}

/** Whether `relayer` was removed by an admin (vs a voluntary exit).
 *  Returns the most recent `RelayerForceRemoved` event's details, or
 *  `null` when the relayer exited on their own (no such event).
 *
 *  An admin removal sets the same `exitRequestedAt` cool-down as a self
 *  `requestExit`, so a forced relayer's row is indistinguishable from a
 *  voluntary exit by state alone — the event is the only signal. Only
 *  meaningful while the operator is in the `cooldown` status; call it
 *  there, not on every row read.
 *
 *  Uses `queryFilter` (not `contract.on`) — event subscriptions stop
 *  firing on anvil, and this is a one-shot read anyway. */
export async function loadForceRemoval(
  registryAddress: string,
  relayer: string,
  provider: ethers.Provider,
  fromBlock?: ethers.BlockTag,
): Promise<ForceRemoval | null> {
  const registry = new ethers.Contract(registryAddress, RELAYER_REGISTRY_IFACE, provider);
  const logs = await registry.queryFilter(
    registry.filters.RelayerForceRemoved(relayer),
    fromBlock,
  );
  // ethers v6 returns `(EventLog | Log)[]`; keep only decoded EventLogs —
  // a bare `Log` (ABI mismatch / corrupt RPC response) has no `args` and
  // would blow up on `latest.args` below.
  const decoded = logs.filter(
    (l): l is ethers.EventLog => "args" in l && l.args != null,
  );
  if (decoded.length === 0) return null;
  // A relayer can be re-registered then removed again; the last event
  // describes the current removal.
  const latest = decoded[decoded.length - 1]!;
  return {
    reason: latest.args.reason as string,
    exitAfter: Number(latest.args.exitAfter),
  };
}
