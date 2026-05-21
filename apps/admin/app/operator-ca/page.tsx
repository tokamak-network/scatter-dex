"use client";

import { useCallback, useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { Stat } from "../components/Stat";
import { DEMO_NETWORK, IDENTITY_REGISTRY_ADDRESS } from "../lib/network";
import { AttestationPanel } from "./_components/AttestationPanel";
import { IssueForm, type IssuedRecord } from "./_components/IssueForm";
import { IssuedList } from "./_components/IssuedList";

const STORAGE_KEY = "zkscatter.admin.operator-ca.issued";

function loadIssued(): IssuedRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as IssuedRecord[]) : [];
  } catch {
    return [];
  }
}

function saveIssued(records: IssuedRecord[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function downloadBundle(record: IssuedRecord) {
  const bundle = JSON.stringify(record, null, 2);
  const blob = new Blob([bundle], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `operator-${record.walletAddress.slice(0, 10)}-${record.issuedAt.slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function OperatorCaPage() {
  const [records, setRecords] = useState<IssuedRecord[]>([]);

  useEffect(() => {
    setRecords(loadIssued());
  }, []);

  const onIssued = useCallback((record: IssuedRecord) => {
    setRecords((prev) => {
      const next = [record, ...prev];
      saveIssued(next);
      return next;
    });
    downloadBundle(record);
  }, []);

  const onRemove = useCallback((walletAddress: string, issuedAt: string) => {
    setRecords((prev) => {
      const next = prev.filter(
        (r) => !(r.walletAddress === walletAddress && r.issuedAt === issuedAt),
      );
      saveIssued(next);
      return next;
    });
  }, []);

  const registryConfigured = IDENTITY_REGISTRY_ADDRESS.length > 0;

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-2xl font-semibold">Operator CA — X.509 issuance</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
          Generate an operator keypair, build a certificate request bound to their EVM
          wallet, hand off the cert bundle, and attest the operator into the on-chain
          IdentityRegistry that <code className="font-mono">RelayerRegistry.identityRegistry()</code> trusts.
        </p>
      </header>

      <section>
        <SectionHeader title="Active deployment" badge="live" />
        <div className="grid grid-cols-3 gap-4">
          <Stat
            label="Network"
            value={DEMO_NETWORK.name ?? "—"}
            sub={`Chain ID ${DEMO_NETWORK.chainId}`}
          />
          <Stat
            label="IdentityRegistry"
            value={
              registryConfigured
                ? `${IDENTITY_REGISTRY_ADDRESS.slice(0, 8)}…${IDENTITY_REGISTRY_ADDRESS.slice(-4)}`
                : "Not configured"
            }
            sub={
              registryConfigured
                ? "On-chain attestation enabled"
                : "Set NEXT_PUBLIC_IDENTITY_REGISTRY_ADDRESS"
            }
          />
          <Stat
            label="Issued (this device)"
            value={String(records.length)}
            sub="Stored in browser localStorage"
          />
        </div>
      </section>

      <section>
        <SectionHeader title="New certificate" badge="live" />
        <IssueForm onIssued={onIssued} />
      </section>

      <section>
        <SectionHeader title="Recent issuances" badge="mock" hint="local-only ledger" />
        <IssuedList records={records} onDownload={downloadBundle} onRemove={onRemove} />
      </section>

      <section>
        <SectionHeader
          title="On-chain attestation"
          badge={registryConfigured ? "live" : "mock"}
          hint={registryConfigured ? undefined : "set NEXT_PUBLIC_IDENTITY_REGISTRY_ADDRESS"}
        />
        <AttestationPanel />
      </section>
    </div>
  );
}
