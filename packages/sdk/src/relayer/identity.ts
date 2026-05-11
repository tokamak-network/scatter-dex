import { ethers } from "ethers";
import { IDENTITY_GATE_ABI, IDENTITY_GATE_IFACE } from "../core/contracts";

export interface IdentityVerification {
  isVerified: boolean;
  /** Unix seconds the verification expires at; `0` when not verified. */
  verifiedUntil: number;
}

export interface IdentityGateAdminSnapshot {
  /** Contract owner — the only address that can call addRegistry /
   *  removeRegistry. UIs gate admin actions on this. */
  owner: string;
  /** All IdentityRegistry contracts trusted by this gate. The gate
   *  ORs their isVerified() results. */
  registries: string[];
}

/** One-shot admin read for the IdentityGate management UI.
 *  Pure read — no mutation. */
export async function loadIdentityGateAdmin(
  gateAddress: string,
  provider: ethers.Provider,
): Promise<IdentityGateAdminSnapshot> {
  const gate = new ethers.Contract(gateAddress, IDENTITY_GATE_ABI, provider);
  const [owner, registries] = await Promise.all([
    gate.owner() as Promise<string>,
    gate.getRegistries() as Promise<string[]>,
  ]);
  return { owner, registries };
}

/** Read an account's verification status from an arbitrary
 *  IdentityGate contract. zkScatter's Dual-CA architecture deploys
 *  one gate per CA (User CA = privacy-preserving, Relayer CA =
 *  full-disclosure), so callers pass the gate address explicitly
 *  rather than letting the SDK guess one. Pure read. */
export async function loadIdentityVerification(
  gateAddress: string,
  account: string,
  provider: ethers.Provider,
): Promise<IdentityVerification> {
  const gate = new ethers.Contract(gateAddress, IDENTITY_GATE_IFACE, provider);
  // Issue both reads in parallel — `verifiedUntil` is meaningless
  // when `isVerified` is false, but the wasted call costs less
  // than the extra round-trip a sequential branch would add on
  // the (common) verified path.
  const [isVerified, verifiedUntilRaw] = await Promise.all([
    gate.isVerified(account) as Promise<boolean>,
    gate.verifiedUntil(account) as Promise<bigint>,
  ]);
  return {
    isVerified,
    verifiedUntil: isVerified ? Number(verifiedUntilRaw) : 0,
  };
}
