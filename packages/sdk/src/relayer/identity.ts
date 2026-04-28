import { ethers } from "ethers";
import { IDENTITY_GATE_IFACE } from "../core/contracts";

export interface IdentityVerification {
  isVerified: boolean;
  /** Unix seconds the verification expires at; `0` when not verified. */
  verifiedUntil: number;
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
