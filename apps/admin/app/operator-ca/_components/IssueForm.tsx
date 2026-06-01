"use client";

import { useState } from "react";
import {
  buildCertificateRequest,
  generateOperatorKeypair,
  isValidCountryCode,
  isValidEvmAddress,
  type CertificateRequest,
  type GeneratedKeypair,
} from "../../lib/x509";
import { encryptPrivateKeyPem, type EncryptedKeystore } from "../../lib/keystore";

const DEFAULT_VALIDITY = 365;
const MIN_PASSPHRASE = 12;

export interface IssuedRecord {
  walletAddress: string;
  commonName: string;
  organization: string;
  country: string;
  validityDays: number;
  publicKeyFingerprint: string;
  request: CertificateRequest;
  /** The operator private key, passphrase-encrypted — never plaintext. */
  encryptedPrivateKey: EncryptedKeystore;
  publicKeyPem: string;
  issuedAt: string;
}

interface Props {
  onIssued: (record: IssuedRecord) => void;
}

interface FormState {
  commonName: string;
  organization: string;
  country: string;
  walletAddress: string;
  validityDays: number;
  passphrase: string;
  passphraseConfirm: string;
}

const INITIAL: FormState = {
  commonName: "",
  organization: "",
  country: "KR",
  walletAddress: "",
  validityDays: DEFAULT_VALIDITY,
  passphrase: "",
  passphraseConfirm: "",
};

export function IssueForm({ onIssued }: Props) {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [busy, setBusy] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<
    | {
        kp: GeneratedKeypair;
        request: CertificateRequest;
      }
    | null
  >(null);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  function validate(): string | null {
    if (!form.commonName.trim()) return "Common Name is required";
    if (!form.organization.trim()) return "Organisation is required";
    if (!isValidCountryCode(form.country))
      return "Country must be an ISO-3166 alpha-2 code (e.g. KR, US)";
    if (!isValidEvmAddress(form.walletAddress))
      return "Operator wallet must be a 0x-prefixed 20-byte address";
    if (!Number.isFinite(form.validityDays) || form.validityDays <= 0 || form.validityDays > 3650)
      return "Validity must be between 1 and 3650 days";
    return null;
  }

  async function handleGenerate() {
    setError(null);
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setBusy(true);
    try {
      const kp = await generateOperatorKeypair();
      const request = buildCertificateRequest(
        {
          commonName: form.commonName.trim(),
          organization: form.organization.trim(),
          country: form.country.toUpperCase(),
          walletAddress: form.walletAddress.trim(),
        },
        kp.publicKeyPem,
        form.validityDays,
      );
      setPreview({ kp, request });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Keygen failed");
    } finally {
      setBusy(false);
    }
  }

  function passphraseError(): string | null {
    if (form.passphrase.length < MIN_PASSPHRASE)
      return `Passphrase must be at least ${MIN_PASSPHRASE} characters`;
    if (form.passphrase !== form.passphraseConfirm) return "Passphrases do not match";
    return null;
  }

  async function handleIssue() {
    if (!preview) return;
    const pe = passphraseError();
    if (pe) {
      setError(pe);
      return;
    }
    setError(null);
    setIssuing(true);
    try {
      // Encrypt the private key with the passphrase before it leaves this
      // component — the issued bundle never carries plaintext key material.
      const encryptedPrivateKey = await encryptPrivateKeyPem(
        preview.kp.privateKeyPem,
        form.passphrase,
      );
      const record: IssuedRecord = {
        walletAddress: preview.request.walletAddress,
        commonName: preview.request.commonName,
        organization: preview.request.organization,
        country: preview.request.country,
        validityDays: preview.request.validityDays,
        publicKeyFingerprint: preview.kp.publicKeyFingerprint,
        request: preview.request,
        encryptedPrivateKey,
        publicKeyPem: preview.kp.publicKeyPem,
        issuedAt: new Date().toISOString(),
      };
      onIssued(record);
      setPreview(null);
      setForm(INITIAL);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Encryption failed");
    } finally {
      setIssuing(false);
    }
  }

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Common Name (CN)">
          <input
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            placeholder="ops@example.io"
            value={form.commonName}
            onChange={(e) => update("commonName", e.target.value)}
          />
        </Field>
        <Field label="Organisation (O)">
          <input
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            placeholder="Example Operations Ltd"
            value={form.organization}
            onChange={(e) => update("organization", e.target.value)}
          />
        </Field>
        <Field label="Country (C)" hint="ISO-3166 alpha-2">
          <input
            className="w-24 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm uppercase"
            maxLength={2}
            value={form.country}
            onChange={(e) => update("country", e.target.value.toUpperCase())}
          />
        </Field>
        <Field label="Validity (days)">
          <input
            type="number"
            min={1}
            max={3650}
            className="w-32 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            value={form.validityDays}
            onChange={(e) => update("validityDays", Number(e.target.value))}
          />
        </Field>
        <Field label="Operator wallet" full>
          <input
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm"
            placeholder="0x…"
            value={form.walletAddress}
            onChange={(e) => update("walletAddress", e.target.value)}
          />
        </Field>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">
          {error}
        </div>
      )}

      {preview && (
        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Key passphrase" hint={`min ${MIN_PASSPHRASE} chars`}>
            <input
              type="password"
              autoComplete="new-password"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
              placeholder="encrypts the private key"
              value={form.passphrase}
              onChange={(e) => update("passphrase", e.target.value)}
            />
          </Field>
          <Field label="Confirm passphrase">
            <input
              type="password"
              autoComplete="new-password"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
              value={form.passphraseConfirm}
              onChange={(e) => update("passphraseConfirm", e.target.value)}
            />
          </Field>
          <p className="text-xs text-[var(--color-text-muted)] md:col-span-2">
            The private key is encrypted with this passphrase (PBKDF2-HMAC-SHA256 +
            AES-256-GCM) before download — the bundle never contains a plaintext key.
            Deliver the passphrase to the operator out-of-band; it is never stored or sent
            to a server and cannot be recovered if lost.
          </p>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || issuing}
          onClick={handleGenerate}
          className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Generating…" : preview ? "Regenerate keypair" : "Generate keypair & build CSR"}
        </button>
        {preview && (
          <button
            type="button"
            disabled={busy || issuing || passphraseError() !== null}
            onClick={handleIssue}
            className="rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] px-4 py-2 text-sm font-medium text-[var(--color-success)] hover:bg-[var(--color-success)] hover:text-white disabled:opacity-50"
          >
            {issuing ? "Encrypting…" : "Issue cert ↗"}
          </button>
        )}
      </div>

      {preview && (
        <div className="mt-6 space-y-4">
          <Preview
            label="Certificate request"
            hint="POST this to the zk-X509 issuer to receive the signed cert."
            value={JSON.stringify(preview.request, null, 2)}
          />
          <Preview
            label="Operator public key (SPKI PEM)"
            hint={`SHA-256 fingerprint: ${preview.kp.publicKeyFingerprint}`}
            value={preview.kp.publicKeyPem}
          />
          <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-text-muted)]">
            The private key is held in memory only and is{" "}
            <strong>encrypted with your passphrase on “Issue cert”</strong> — the downloaded
            bundle contains the encrypted keystore, never plaintext. It is not shown here to
            avoid on-screen exposure.
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  full,
  children,
}: {
  label: string;
  hint?: string;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`block text-sm ${full ? "md:col-span-2" : ""}`}>
      <span className="mb-1 block text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
        {label}
        {hint && <span className="ml-1 normal-case text-[var(--color-text-subtle)]">· {hint}</span>}
      </span>
      {children}
    </label>
  );
}

function Preview({
  label,
  hint,
  value,
  danger,
}: {
  label: string;
  hint?: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div
      className={`rounded-md border p-3 ${
        danger
          ? "border-[var(--color-warning)] bg-[var(--color-warning-soft)]"
          : "border-[var(--color-border)] bg-[var(--color-bg)]"
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          {label}
        </div>
        <button
          type="button"
          onClick={() => navigator.clipboard.writeText(value)}
          className="text-xs text-[var(--color-primary)] hover:underline"
        >
          Copy
        </button>
      </div>
      {hint && <div className="mt-1 text-xs text-[var(--color-text-subtle)]">{hint}</div>}
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--color-code-bg)] p-3 text-xs text-[var(--color-code-fg)]">
        {value}
      </pre>
    </div>
  );
}
