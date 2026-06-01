"use client";

import { useState } from "react";
import { ethers } from "ethers";
import { ISSUANCE_APPROVAL_REGISTRY_ABI, isConfiguredAddress } from "@zkscatter/sdk";
import { useWallet } from "@zkscatter/sdk/react";
import { DEMO_NETWORK } from "../../lib/network";
import { classifyApproval, type IssuanceApprovalState } from "../../lib/useIssuanceApproval";
import { importCaPkcs12 } from "../../lib/pkcs12";
import { CsrSubjectMismatchError, signOperatorCsr } from "../../lib/leafCert";
import { isValidEvmAddress, normalizeEvmAddress } from "../../lib/x509";

/** Admin CA-signing panel (queue item #4): load the Root CA `.p12`, read the
 *  operator's on-chain approval, and sign their CSR into a leaf certificate.
 *  The authoritative `CSR.subject == approval` check lives in
 *  {@link signOperatorCsr}; this is the operator-side of issuance.
 *
 *  Manual flow for now (paste CSR + upload CA key/cert). Auto-pulling the
 *  pending-CSR queue and posting issued certs back to the orderbook
 *  (`GET /api/cert/csr?status=pending`, `POST /api/cert/issued`) is a
 *  follow-up once that backend lands.
 *
 *  Trust model (PoC): the signing authority here is **possession of the Root
 *  CA `.p12` + passphrase** — there is no separate admin-identity gate. That's
 *  acceptable for a devnet PoC (the CA key never leaves a browser anyway);
 *  production moves signing behind an HSM-backed Issuing CA with SoD/admin auth
 *  (design §12.4). */

function download(filename: string, data: BlobPart, type: string) {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function SignCsrPanel() {
  const { readProvider } = useWallet();
  const registry = DEMO_NETWORK.contracts.issuanceApprovalRegistry;
  const gateConfigured = isConfiguredAddress(registry);

  const [caP12, setCaP12] = useState<ArrayBuffer | null>(null);
  const [caCertDer, setCaCertDer] = useState<ArrayBuffer | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [wallet, setWallet] = useState("");
  const [csrPem, setCsrPem] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approval, setApproval] = useState<IssuanceApprovalState | null>(null);
  const [result, setResult] = useState<{ certPem: string; serialHex: string; notAfter: number } | null>(null);

  const fileToBuffer =
    (setter: (b: ArrayBuffer | null) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (!f) {
        setter(null); // input cleared — drop any stale buffer
        return;
      }
      f.arrayBuffer()
        .then(setter)
        .catch((err) => setError(err instanceof Error ? err.message : "Failed to read file"));
    };

  async function readApproval(addr: string): Promise<IssuanceApprovalState> {
    if (!readProvider || !gateConfigured) {
      return { status: "error", message: "Issuance registry not configured for this network" };
    }
    const c = new ethers.Contract(registry, ISSUANCE_APPROVAL_REGISTRY_ABI, readProvider);
    const raw = await c.approvals(addr);
    return classifyApproval(raw, Math.floor(Date.now() / 1000));
  }

  async function handleSign() {
    setError(null);
    setResult(null);
    setApproval(null);

    const addr = normalizeEvmAddress(wallet.trim());
    if (!addr) return setError("Enter a valid operator wallet address (0x…).");
    if (!caP12) return setError("Upload the Root CA .p12 (private key).");
    if (!passphrase) return setError("Enter the Root CA .p12 passphrase.");
    if (!csrPem.includes("CERTIFICATE REQUEST")) return setError("Paste the operator's CSR (PEM).");

    setBusy(true);
    try {
      // 1. On-chain approval = the authoritative subject + validity.
      const appr = await readApproval(addr);
      setApproval(appr);
      if (appr.status !== "approved" || !appr.approval) {
        setError(`Wallet is not approved for issuance (status: ${appr.status}). Cannot sign.`);
        return;
      }

      // 2. Load the CA key (and cert if the .p12 bundles one).
      const { privateKey, certificate } = await importCaPkcs12(caP12, passphrase);
      const resolvedCaCertDer = certificate ? certificate.toSchema().toBER() : caCertDer;
      if (!resolvedCaCertDer) {
        setError("The .p12 has no certificate — also upload the public rootCA.der.");
        return;
      }

      // 3. Sign — signOperatorCsr enforces CSR.subject == approval.
      const leaf = await signOperatorCsr({
        csrPem,
        caCertDer: resolvedCaCertDer,
        caPrivateKey: privateKey,
        approved: {
          commonName: appr.approval.commonName,
          organization: appr.approval.organization,
          country: appr.approval.country,
        },
        validityDays: appr.approval.validityDays,
      });
      download(`operator-${addr.slice(0, 10)}-leaf.pem`, leaf.certPem, "application/x-pem-file");
      setResult(leaf);
    } catch (e) {
      if (e instanceof CsrSubjectMismatchError) {
        setError(`Refused: ${e.message}. The CSR does not match the approved identity.`);
      } else {
        setError(e instanceof Error ? e.message : "Signing failed");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <p className="text-sm text-[var(--color-text-muted)]">
        Sign an operator’s CSR with the company Root CA. The certificate subject is taken
        from the operator’s <strong>on-chain approval</strong> — a CSR whose subject doesn’t
        match the approval is rejected before signing.
      </p>

      <div
        role="note"
        className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-3 py-2 text-xs text-[var(--color-text-muted)]"
      >
        <span className="font-semibold text-[var(--color-warning)]">Test / devnet only.</span>{" "}
        The Root CA private key is loaded into this browser to sign — a proof-of-concept
        shortcut. Production signs via an HSM-backed Issuing CA and never exposes the CA key
        (design §12). Signing authority here is possession of the <code className="font-mono">.p12</code> + passphrase.
      </div>

      {!gateConfigured && (
        <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">
          Issuance-approval registry isn’t configured for this network — signing is
          unavailable.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Operator wallet" hint="reads the on-chain approval">
          <input
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm"
            placeholder="0x…"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
          />
        </Field>
        <Field label="Root CA passphrase">
          <input
            type="password"
            autoComplete="off"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            placeholder="decrypts rootCA.p12"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
        </Field>
        <Field label="Root CA key (rootCA.p12)">
          <input type="file" accept=".p12,application/x-pkcs12" onChange={fileToBuffer(setCaP12)} className="text-sm" />
        </Field>
        <Field label="Root CA cert (rootCA.der)" hint="optional if bundled in the .p12">
          <input type="file" accept=".der,.crt,application/pkix-cert" onChange={fileToBuffer(setCaCertDer)} className="text-sm" />
        </Field>
      </div>

      <Field label="Operator CSR (PEM)">
        <textarea
          className="h-32 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs"
          placeholder="-----BEGIN CERTIFICATE REQUEST-----"
          value={csrPem}
          onChange={(e) => setCsrPem(e.target.value)}
        />
      </Field>

      {approval?.approval && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
          On-chain approved subject: <span className="font-mono">CN={approval.approval.commonName}, O={approval.approval.organization}, C={approval.approval.country}</span> · {approval.approval.validityDays}d
        </div>
      )}

      {error && (
        <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">
          {error}
        </div>
      )}

      <button
        type="button"
        disabled={busy || !gateConfigured || !isValidEvmAddress(wallet.trim())}
        onClick={() => void handleSign()}
        className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Signing…" : "Sign CSR → leaf certificate"}
      </button>

      {result && (
        <div className="space-y-2 rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] px-3 py-3 text-sm text-[var(--color-success)]">
          <div className="font-medium">
            Leaf certificate issued (serial <span className="font-mono">{result.serialHex.slice(0, 16)}…</span>) — downloaded.
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--color-surface)] p-2 text-xs text-[var(--color-text-muted)]">
            {result.certPem}
          </pre>
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
        {label}
        {hint && <span className="ml-1 normal-case text-[var(--color-text-subtle)]">· {hint}</span>}
      </span>
      {children}
    </label>
  );
}
