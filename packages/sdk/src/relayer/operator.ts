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

/** Read the on-chain registry row for `account`. Returns the full
 *  set of operator-scoped state every dashboard / profile / treasury
 *  page needs, plus a derived `status` for UI gating. Pure read. */
export async function loadOperatorRow(
  registryAddress: string,
  account: string,
  provider: ethers.Provider,
): Promise<OperatorRow> {
  const registry = new ethers.Contract(registryAddress, RELAYER_REGISTRY_IFACE, provider);
  const [r, bondToken] = await Promise.all([
    registry.relayers(account),
    registry.bondToken() as Promise<string>,
  ]);
  const active = r.active as boolean;
  const registeredAt = Number(r.registeredAt);
  const exitRequestedAt = Number(r.exitRequestedAt);
  const bond = r.bond as bigint;
  return {
    url: r.url as string,
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
