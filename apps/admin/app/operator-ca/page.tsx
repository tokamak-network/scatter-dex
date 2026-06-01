"use client";

import { useCallback, useEffect, useState } from "react";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { SectionHeader } from "../components/SectionHeader";
import { Stat } from "../components/Stat";
import { TestOnlyBanner } from "../components/TestOnlyBanner";
import { DEMO_NETWORK } from "../lib/network";
import { useRelayerIdentityRegistry } from "../lib/useRelayerIdentityRegistry";
import { AttestationPanel } from "./_components/AttestationPanel";
import { IssueForm, type IssuedRecord } from "./_components/IssueForm";
import { IssuedList, type LedgerEntry } from "./_components/IssuedList";
import { SignCsrPanel } from "./_components/SignCsrPanel";

const STORAGE_KEY = "zkscatter.admin.operator-ca.issued";

/** Strip the private key before persistence. The PKCS#8 PEM is only
 *  in memory between issuance and the immediate bundle download — it
 *  is never written to localStorage, where XSS or a malicious browser
 *  extension could read it. The re-download from history therefore
 *  cannot re-emit the private key. */
function toLedgerEntry(record: IssuedRecord): LedgerEntry {
  return {
    walletAddress: record.walletAddress,
    commonName: record.commonName,
    organization: record.organization,
    country: record.country,
    validityDays: record.validityDays,
    publicKeyFingerprint: record.publicKeyFingerprint,
    publicKeyPem: record.publicKeyPem,
    request: record.request,
    issuedAt: record.issuedAt,
  };
}

function loadLedger(): LedgerEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LedgerEntry[]) : [];
  } catch {
    return [];
  }
}

function saveLedger(records: LedgerEntry[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function downloadBundle(filename: string, payload: unknown) {
  const bundle = JSON.stringify(payload, null, 2);
  const blob = new Blob([bundle], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function bundleFilename(walletAddress: string, issuedAt: string): string {
  return `operator-${walletAddress.slice(0, 10)}-${issuedAt.slice(0, 10)}.json`;
}

export default function OperatorCaPage() {
  const [records, setRecords] = useState<LedgerEntry[]>([]);

  useEffect(() => {
    setRecords(loadLedger());
  }, []);

  const onIssued = useCallback((record: IssuedRecord) => {
    // Emit the full bundle (incl. private key) for one-shot download
    // while it's still in memory. Persist only the sanitised entry.
    downloadBundle(bundleFilename(record.walletAddress, record.issuedAt), record);
    const entry = toLedgerEntry(record);
    setRecords((prev) => {
      const next = [entry, ...prev];
      saveLedger(next);
      return next;
    });
  }, []);

  const onDownloadHistory = useCallback((entry: LedgerEntry) => {
    downloadBundle(bundleFilename(entry.walletAddress, entry.issuedAt), entry);
  }, []);

  const onRemove = useCallback((walletAddress: string, issuedAt: string) => {
    setRecords((prev) => {
      const next = prev.filter(
        (r) => !(r.walletAddress === walletAddress && r.issuedAt === issuedAt),
      );
      saveLedger(next);
      return next;
    });
  }, []);

  // The attestation registry is read on-chain from
  // RelayerRegistry.identityRegistry() (set on the Identity (relayer) tab),
  // not from a static env var — so this page always reflects the live wiring.
  const { address: identityRegistry, loading: registryLoading } = useRelayerIdentityRegistry();
  const registryConfigured = isConfiguredAddress(identityRegistry ?? "");

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

      <TestOnlyBanner context="Operator keypairs are generated in this browser." />

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
              registryConfigured && identityRegistry
                ? `${identityRegistry.slice(0, 8)}…${identityRegistry.slice(-4)}`
                : registryLoading
                  ? "Loading…"
                  : "Not set"
            }
            sub={
              registryConfigured
                ? "From RelayerRegistry.identityRegistry()"
                : registryLoading
                  ? "Reading on-chain…"
                  : "Set it on the Identity (relayer) tab"
            }
          />
          <Stat
            label="Issued (this device)"
            value={String(records.length)}
            sub="Metadata only — keys not persisted"
          />
        </div>
      </section>

      <section>
        <SectionHeader
          title="Sign operator CSR"
          badge="live"
          hint="CA signs an operator's request → leaf cert; subject is bound to the on-chain approval"
        />
        <SignCsrPanel />
      </section>

      <section>
        <SectionHeader
          title="New certificate (legacy in-browser keygen)"
          badge="live"
          hint="superseded by the operators self-service /operator-cert screen"
        />
        <IssueForm onIssued={onIssued} />
      </section>

      <section>
        <SectionHeader
          title="Recent issuances"
          badge="live"
          hint="metadata only — private key never persisted"
        />
        <IssuedList records={records} onDownload={onDownloadHistory} onRemove={onRemove} />
      </section>

      <section>
        <SectionHeader
          title="On-chain attestation"
          badge={registryConfigured ? "live" : "mock"}
          hint={
            registryLoading
              ? "reading on-chain…"
              : registryConfigured
                ? undefined
                : "set RelayerRegistry.identityRegistry() on the Identity (relayer) tab"
          }
        />
        <AttestationPanel registryAddress={identityRegistry} loading={registryLoading} />
      </section>
    </div>
  );
}
