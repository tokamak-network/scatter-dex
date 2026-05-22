"use client";

import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { useWallet } from "@zkscatter/sdk/react";
import { DEMO_NETWORK } from "../lib/network";

/** Header status badge — tells the operator at a glance whether the
 *  currently-connected wallet has admin authority on the platform's
 *  key contracts (RelayerRegistry, IdentityGate, FeeVault). Without
 *  this, every page silently lets you try a write and only fails at
 *  submission time with a generic revert, which makes "did I connect
 *  the right wallet?" a guessing game.
 *
 *  We treat "admin" as: connected wallet equals `owner()` on at
 *  least one of the platform contracts. Some flows only need to be
 *  owner of one contract (e.g. addRegistry needs IdentityGate
 *  owner, addCA needs IdentityRegistry owner). The badge therefore
 *  tags the wallet as Admin when *any* match — page-level UI is
 *  still expected to gate its own writes on the specific role it
 *  needs. */
type AdminCheck = "loading" | "admin" | "not-admin" | "no-wallet" | "error";

const OWNER_ABI = ["function owner() view returns (address)"];

export function AdminBadge() {
  const { account, readProvider } = useWallet();
  const [state, setState] = useState<AdminCheck>("no-wallet");
  const [owners, setOwners] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!account || !readProvider) {
      setState("no-wallet");
      setOwners({});
      return;
    }
    let cancelled = false;
    setState("loading");
    const targets: Array<[string, string]> = [
      ["IdentityGate", DEMO_NETWORK.contracts.identityGate],
      ["RelayerRegistry", DEMO_NETWORK.contracts.relayerRegistry],
      ["FeeVault", DEMO_NETWORK.contracts.feeVault],
    ].filter(([, addr]) => addr && addr !== ethers.ZeroAddress) as Array<
      [string, string]
    >;
    if (targets.length === 0) {
      setState("error");
      return;
    }
    Promise.allSettled(
      targets.map(async ([name, addr]) => {
        const c = new ethers.Contract(addr, OWNER_ABI, readProvider);
        const owner: string = await c.owner();
        return { name, owner };
      }),
    )
      .then((results) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        let isAdmin = false;
        const lc = account.toLowerCase();
        for (const r of results) {
          if (r.status !== "fulfilled") continue;
          map[r.value.name] = r.value.owner;
          if (r.value.owner.toLowerCase() === lc) isAdmin = true;
        }
        setOwners(map);
        setState(isAdmin ? "admin" : "not-admin");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [account, readProvider]);

  const tooltip = buildTooltip(state, account, owners);

  if (state === "no-wallet") {
    return null;
  }

  const cls = badgeCls(state);
  return (
    <span
      title={tooltip}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${cls}`}
    >
      {state === "admin" && <>✓ Admin</>}
      {state === "not-admin" && <>! Not admin</>}
      {state === "loading" && <>checking…</>}
      {state === "error" && <>owner read failed</>}
    </span>
  );
}

function badgeCls(state: AdminCheck): string {
  switch (state) {
    case "admin":
      return "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-success)]";
    case "not-admin":
      return "border-[var(--color-warning)] bg-[var(--color-warning-soft)] text-[var(--color-warning)]";
    case "loading":
      return "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-subtle)]";
    case "error":
      return "border-[var(--color-danger)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]";
    default:
      return "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-subtle)]";
  }
}

function buildTooltip(
  state: AdminCheck,
  account: string | null,
  owners: Record<string, string>,
): string {
  if (state === "no-wallet") return "Connect a wallet to check admin status";
  if (state === "loading") return "Reading owner() from platform contracts…";
  if (state === "error") return "owner() read failed — check RPC config";
  const lines = [
    `Connected: ${account ?? "—"}`,
    ...Object.entries(owners).map(
      ([name, owner]) =>
        `${name}.owner(): ${owner}${
          account && owner.toLowerCase() === account.toLowerCase() ? " ✓" : ""
        }`,
    ),
  ];
  return lines.join("\n");
}
