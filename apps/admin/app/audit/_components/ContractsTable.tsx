"use client";

import { explorerLink, isConfiguredAddress } from "@zkscatter/sdk";
import { shortAddr } from "@zkscatter/sdk/react";
import { DEMO_NETWORK } from "../../lib/network";

interface Entry {
  label: string;
  address: string;
  scope: string;
  notes?: string;
}

/** In-scope contracts for this deployment, mirroring the table at
 *  the top of `docs/security/AUDIT.md`. Auditors visiting the page
 *  in the browser get one-click links to the verified source on
 *  the chain's explorer alongside the doc itself. */
export function ContractsTable() {
  const c = DEMO_NETWORK.contracts;
  const entries: Entry[] = [
    {
      label: "PrivateSettlement",
      address: c.privateSettlement,
      scope: "in scope",
      notes: "Half-proof + DEX + scatter entry points",
    },
    {
      label: "CommitmentPool",
      address: c.commitmentPool,
      scope: "in scope",
      notes: "Deposit / withdraw / Merkle tree",
    },
    {
      label: "RelayerRegistry",
      address: c.relayerRegistry,
      scope: "in scope",
      notes: "Bond-gated relayer set",
    },
    {
      label: "FeeVault",
      address: c.feeVault ?? "",
      scope: "in scope",
      notes: "Relayer + platform fee accounting",
    },
    {
      label: "IdentityGate",
      address: c.identityGate,
      scope: "in scope",
      notes: "Multi-CA identity proof gating",
    },
    {
      label: "WETH",
      address: c.weth,
      scope: "external",
      notes: "Canonical WETH9; out of scope (assumed audited)",
    },
  ];

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full text-left text-sm">
        <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
          <tr>
            <th className="px-4 py-2">Contract</th>
            <th className="px-4 py-2">Address</th>
            <th className="px-4 py-2">Scope</th>
            <th className="px-4 py-2">Notes</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.label} className="border-t border-[var(--color-border)]">
              <td className="px-4 py-2 font-medium">{e.label}</td>
              <td className="px-4 py-2 font-mono text-xs">
                <AddressCell address={e.address} />
              </td>
              <td className="px-4 py-2 text-xs">
                <span
                  className={`rounded-full px-2 py-0.5 font-medium uppercase ${
                    e.scope === "in scope"
                      ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
                      : "bg-[var(--color-bg)] text-[var(--color-text-subtle)]"
                  }`}
                >
                  {e.scope}
                </span>
              </td>
              <td className="px-4 py-2 text-xs text-[var(--color-text-muted)]">
                {e.notes ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddressCell({ address }: { address: string }) {
  if (!isConfiguredAddress(address)) {
    return <span className="text-[var(--color-text-subtle)]">—</span>;
  }
  const url = explorerLink(DEMO_NETWORK, "address", address);
  if (!url) {
    return <span>{shortAddr(address)}</span>;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[var(--color-primary)] hover:underline"
    >
      {shortAddr(address)} ↗
    </a>
  );
}
