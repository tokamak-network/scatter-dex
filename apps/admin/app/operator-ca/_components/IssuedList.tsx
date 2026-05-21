"use client";

import { shortAddr } from "@zkscatter/sdk/react";
import type { CertificateRequest } from "../../lib/x509";

/** Sanitised issuance record — what gets persisted to localStorage.
 *  Excludes the PKCS#8 private key, which only exists in memory at
 *  issuance time and is downloaded once with the initial bundle. */
export interface LedgerEntry {
  walletAddress: string;
  commonName: string;
  organization: string;
  country: string;
  validityDays: number;
  publicKeyFingerprint: string;
  publicKeyPem: string;
  request: CertificateRequest;
  issuedAt: string;
}

interface Props {
  records: LedgerEntry[];
  onDownload: (entry: LedgerEntry) => void;
  onRemove: (walletAddress: string, issuedAt: string) => void;
}

function expiresAt(record: LedgerEntry): string {
  const issued = new Date(record.issuedAt).getTime();
  const expiry = new Date(issued + record.validityDays * 86_400_000);
  return expiry.toISOString().slice(0, 10);
}

export function IssuedList({ records, onDownload, onRemove }: Props) {
  if (records.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
        No certificates issued yet. Issued records are kept in this browser's local storage
        (metadata only — private keys are never persisted).
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full text-left text-sm">
        <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
          <tr>
            <th className="px-4 py-3">Operator</th>
            <th className="px-4 py-3">Wallet</th>
            <th className="px-4 py-3">Fingerprint</th>
            <th className="px-4 py-3">Expires</th>
            <th className="px-4 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr
              key={`${r.walletAddress}-${r.issuedAt}`}
              className="border-t border-[var(--color-border)]"
            >
              <td className="px-4 py-3">
                <div className="font-medium">{r.commonName}</div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  {r.organization} · {r.country}
                </div>
              </td>
              <td className="px-4 py-3 font-mono text-xs">{shortAddr(r.walletAddress)}</td>
              <td className="px-4 py-3 font-mono text-[11px] text-[var(--color-text-muted)]">
                {r.publicKeyFingerprint.slice(0, 23)}…
              </td>
              <td className="px-4 py-3 text-xs">{expiresAt(r)}</td>
              <td className="px-4 py-3 text-right text-xs">
                <button
                  type="button"
                  onClick={() => onDownload(r)}
                  className="mr-2 text-[var(--color-primary)] hover:underline"
                  title="Re-download metadata bundle (no private key)"
                >
                  Download
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(r.walletAddress, r.issuedAt)}
                  className="text-[var(--color-danger)] hover:underline"
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
