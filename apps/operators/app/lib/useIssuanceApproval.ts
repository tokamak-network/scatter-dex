"use client";

import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import { isConfiguredAddress, ISSUANCE_APPROVAL_REGISTRY_ABI } from "@zkscatter/sdk";
import { useTimedRefresh, useWallet } from "@zkscatter/sdk/react";
import { DEMO_NETWORK } from "./network";

/** What the operators app needs to know about a wallet's issuance
 *  approval state to gate the "Open Relayer-CA portal" CTA.
 *  Stay closed: the hook never returns the admin's KYC metadata
 *  beyond what the connected operator already implicitly knows (CN
 *  is typically their own org email; O / C are the values they
 *  submitted offline). */
export interface IssuanceApprovalState {
  status:
    | "idle"           // no wallet connected, or registry not configured
    | "checking"       // RPC in flight
    | "not-approved"   // admin hasn't approved this wallet
    | "approved"       // approved + non-expired + non-revoked
    | "revoked"        // admin revoked (with reason)
    | "expired"        // approval auto-expired
    | "error";         // RPC failed
  approval?: {
    commonName: string;
    organization: string;
    country: string;
    validityDays: number;
    approvedBy: string;
    approvedAt: number; // unix sec
    expiresAt: number;  // unix sec, 0 = no expiry
  };
  revokeReason?: string;
  message?: string;
}

// ABI shared with the admin console (`/admin/issuance`) — see
// `ISSUANCE_APPROVAL_REGISTRY_ABI` in @zkscatter/sdk. The hook only
// calls `approvals(address)` but importing the full fragment keeps
// the struct shape in one place; the contract instance below ignores
// the write fragments we don't use.

interface RawApproval {
  commonName: string;
  organization: string;
  country: string;
  validityDays: bigint;
  approvedBy: string;
  approvedAt: bigint;
  expiresAt: bigint;
  revoked: boolean;
  revokeReason: string;
  revokedAt: bigint;
}

/** Pure classifier: turn the raw struct + optional now() into one
 *  of the user-facing states. Extracted so unit tests can exercise
 *  every branch (revoked, expired, approved boundary) without
 *  standing up a contract / RPC. */
export function classifyApproval(
  raw: RawApproval,
  nowSec: number,
): IssuanceApprovalState {
  // approvedAt == 0 ⇒ no row for this wallet (the mapping returns
  // the zero-struct on miss).
  if (raw.approvedAt === 0n) {
    return { status: "not-approved" };
  }
  const approval = {
    commonName: raw.commonName,
    organization: raw.organization,
    country: raw.country,
    validityDays: Number(raw.validityDays),
    approvedBy: raw.approvedBy,
    approvedAt: Number(raw.approvedAt),
    expiresAt: Number(raw.expiresAt),
  };
  if (raw.revoked) {
    return {
      status: "revoked",
      approval,
      revokeReason: raw.revokeReason || "(no reason supplied)",
    };
  }
  // Mirror the contract's expiry semantics exactly: the contract
  // accepts `expiresAt > block.timestamp` on write and considers
  // `block.timestamp >= expiresAt` expired on read. We compare with
  // the same `>=` so a non-zero, non-future expiry flips the UI
  // to "expired" at the same instant the chain rejects use.
  if (approval.expiresAt !== 0 && nowSec >= approval.expiresAt) {
    return { status: "expired", approval };
  }
  return { status: "approved", approval };
}

/** Hook return shape — adds `refetch` so the CTA's Refresh button
 *  can re-poll the registry without the user having to remount the
 *  page. */
export interface UseIssuanceApprovalResult extends IssuanceApprovalState {
  /** Re-read approvals(wallet) from chain. No-op when wallet /
   *  registry / provider isn't set (mirrors the effect's gates). */
  refetch: () => void;
}

/** Read `IssuanceApprovalRegistry.approvals(wallet)` for the
 *  connected operator and classify the result into a state the
 *  UI can render directly. Re-fires when the account changes, or
 *  when the caller invokes the returned `refetch()`.
 *
 *  Returns `status: idle` when:
 *  - no wallet is connected
 *  - the registry address isn't configured for this network
 *    (NEXT_PUBLIC_ISSUANCE_APPROVAL_REGISTRY_ADDRESS unset)
 *
 *  The CTA UI treats `idle` as "do nothing" — falls back to the
 *  pre-#846 behaviour (generic verifier link, no personalised
 *  message). */
export function useIssuanceApproval(): UseIssuanceApprovalResult {
  const { account, readProvider } = useWallet();
  const registry = DEMO_NETWORK.contracts.issuanceApprovalRegistry;
  const [state, setState] = useState<IssuanceApprovalState>({ status: "idle" });
  // Bumping `tick` re-fires the effect — primitive caller-driven
  // refetch handle.
  const [tick, setTick] = useState(0);
  const refetch = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!account || !readProvider || !registry || !isConfiguredAddress(registry)) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "checking" });
    const c = new ethers.Contract(registry, ISSUANCE_APPROVAL_REGISTRY_ABI, readProvider);
    (c.approvals(account) as Promise<RawApproval>)
      .then((raw) => {
        if (cancelled) return;
        setState(classifyApproval(raw, Math.floor(Date.now() / 1000)));
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("[useIssuanceApproval] approvals read failed", err);
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "RPC failed",
        });
      });
    return () => { cancelled = true; };
  }, [account, readProvider, registry, tick]);

  // Live-refresh while waiting on the admin's decision. Once the
  // wallet is approved we stop polling — re-approval is rare and
  // would be caught by tab-focus visibility anyway. Stays disabled
  // in `idle` (nothing configured / no wallet) so we don't poll a
  // no-op forever.
  //
  // `checking` is deliberately EXCLUDED: a read is already in
  // flight. If the RPC takes longer than `intervalMs` the next
  // tick would re-arm setState({checking}) and the previous
  // promise's `cancelled` flag would discard its result — a slow
  // RPC ends up in an infinite cancel/retry loop and the status
  // never resolves. The effect re-fires anyway whenever the read
  // settles (state transitions out of `checking`), at which point
  // the right `livePoll` value picks back up.
  const livePoll =
    state.status === "not-approved" ||
    state.status === "revoked" ||
    state.status === "expired" ||
    state.status === "error";
  useTimedRefresh({
    refresh: refetch,
    intervalMs: 10_000,
    enabled: livePoll,
  });

  return { ...state, refetch };
}
