"use client";

import { useState } from "react";
import { isValidCountryCode } from "../../../lib/x509";
import { generateRootCa } from "../../../lib/rootca";
import { exportOperatorPkcs12 } from "../../../lib/pkcs12";

const MIN_PASSPHRASE = 12;
const DEFAULT_VALIDITY_YEARS = 10;

/** Dev/interim bearer for the orderbook admin endpoints (same as the KYC
 *  review console) — replaced by a SIWE session header once the orderbook's
 *  signature auth lands. */
const ADMIN_TOKEN = process.env.NEXT_PUBLIC_ORDERBOOK_ADMIN_TOKEN ?? "";

interface FormState {
  commonName: string;
  organization: string;
  country: string;
  validityYears: number;
  passphrase: string;
  passphraseConfirm: string;
}

const INITIAL: FormState = {
  commonName: "",
  organization: "",
  country: "KR",
  validityYears: DEFAULT_VALIDITY_YEARS,
  passphrase: "",
  passphraseConfirm: "",
};

type Phase =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; published: boolean; note?: string; certDer: ArrayBuffer }
  | { kind: "error"; msg: string };

function download(filename: string, data: BlobPart, type: string) {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke: Safari can race a synchronous revoke against the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Generate the company Root CA in the browser, download the CA private key as a
 * passphrase-encrypted `.p12` (kept by the admin), and publish the public
 * `rootCA.der` to the shared orderbook. The CA private key never leaves the
 * device in plaintext and is never sent to a server.
 *
 * @param hasExisting whether a Root CA is already published (shows a replace
 *   warning — the design assumes a single active Root CA).
 * @param onPublished called after a successful publish so the page can refresh.
 */
export function GenerateRootCa({
  orderbookUrl,
  hasExisting,
  onPublished,
}: {
  orderbookUrl: string;
  hasExisting: boolean;
  onPublished: () => void;
}) {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  function validate(): string | null {
    if (!form.commonName.trim()) return "Common Name is required";
    if (!form.organization.trim()) return "Organisation is required";
    if (!isValidCountryCode(form.country.trim()))
      return "Country must be an ISO-3166 alpha-2 code (e.g. KR, US)";
    if (
      !Number.isInteger(form.validityYears) ||
      form.validityYears <= 0 ||
      form.validityYears > 50
    )
      return "Validity must be between 1 and 50 years";
    if (form.passphrase.length < MIN_PASSPHRASE)
      return `CA key passphrase must be at least ${MIN_PASSPHRASE} characters`;
    if (form.passphrase !== form.passphraseConfirm) return "Passphrases do not match";
    return null;
  }

  async function handleGenerate() {
    const v = validate();
    if (v) {
      setPhase({ kind: "error", msg: v });
      return;
    }
    setPhase({ kind: "working" });
    try {
      const { certDer, privateKeyPem } = await generateRootCa({
        commonName: form.commonName.trim(),
        organization: form.organization.trim(),
        country: form.country.trim().toUpperCase(),
        validityYears: form.validityYears,
      });

      // Auto-download ONLY the encrypted CA private key (.p12) — the one
      // secret the admin must keep. Browsers block multiple programmatic
      // downloads, so the public .der is offered as a manual button in the
      // done banner (and is published to the orderbook below).
      const p12 = await exportOperatorPkcs12(privateKeyPem, form.passphrase);
      download("rootCA.p12", p12, "application/x-pkcs12");

      // Publish the public DER to the orderbook. The POST endpoint is admin-
      // guarded (Bearer/SIWE) and may not be deployed yet — treat any failure
      // as non-fatal (the key .p12 is already saved, and .der is downloadable
      // from the banner) and give actionable guidance per status.
      let published = false;
      let note: string | undefined;
      try {
        const res = await fetch(`${orderbookUrl}/api/ca/root`, {
          method: "POST",
          headers: {
            "Content-Type": "application/pkix-cert",
            ...(ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {}),
          },
          body: certDer,
        });
        if (res.ok) {
          published = true;
        } else if (res.status === 401) {
          note =
            "Publish unauthorized (401). Admin auth isn't configured — set NEXT_PUBLIC_ORDERBOOK_ADMIN_TOKEN (or sign in once SIWE admin auth lands), then download the .der below and re-publish.";
        } else if (res.status === 503) {
          note =
            "Root CA service is disabled (503) on the orderbook. Download the .der below and publish once it's enabled.";
        } else {
          note = `Publish failed (HTTP ${res.status}). Download the .der below and retry once the Root CA service is available.`;
        }
      } catch {
        note =
          "Publish endpoint unreachable. Download the .der below and publish once the Root CA service is available.";
      }

      setPhase({ kind: "done", published, note, certDer });
      setForm(INITIAL);
      if (published) onPublished();
    } catch (e) {
      setPhase({ kind: "error", msg: e instanceof Error ? e.message : "Generation failed" });
    }
  }

  const working = phase.kind === "working";

  return (
    <div className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      {hasExisting && (
        <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
          A Root CA is already published. Generating a new one <strong>replaces</strong>{" "}
          it — operator certificates signed by the old CA will no longer chain to the
          published anchor. Only proceed for a deliberate rotation.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Common Name (CN)">
          <input
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            placeholder="Company Operator Root CA"
            value={form.commonName}
            onChange={(e) => set("commonName", e.target.value)}
          />
        </Field>
        <Field label="Organisation (O)">
          <input
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            placeholder="Example Co"
            value={form.organization}
            onChange={(e) => set("organization", e.target.value)}
          />
        </Field>
        <Field label="Country (C)" hint="ISO-3166 alpha-2">
          <input
            className="w-24 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm uppercase"
            maxLength={2}
            value={form.country}
            onChange={(e) => set("country", e.target.value.toUpperCase())}
          />
        </Field>
        <Field label="Validity (years)">
          <input
            type="number"
            min={1}
            max={50}
            className="w-32 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            value={form.validityYears}
            onChange={(e) => set("validityYears", Number(e.target.value))}
          />
        </Field>
        <Field label="CA key passphrase" hint={`min ${MIN_PASSPHRASE} chars`}>
          <input
            type="password"
            autoComplete="new-password"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            placeholder="encrypts the CA private key (.p12)"
            value={form.passphrase}
            onChange={(e) => set("passphrase", e.target.value)}
          />
        </Field>
        <Field label="Confirm passphrase">
          <input
            type="password"
            autoComplete="new-password"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            value={form.passphraseConfirm}
            onChange={(e) => set("passphraseConfirm", e.target.value)}
          />
        </Field>
      </div>

      <p className="text-xs text-[var(--color-text-muted)]">
        The CA <strong>private key</strong> is downloaded as a passphrase-encrypted{" "}
        <code className="font-mono">rootCA.p12</code> and never leaves this device. Only
        the public <code className="font-mono">rootCA.der</code> is published. Store the
        <code className="font-mono">.p12</code> and its passphrase securely — they are the
        trust root for every operator certificate and cannot be recovered if lost.
      </p>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={working}
          onClick={() => void handleGenerate()}
          className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {working ? "Generating…" : "Generate Root CA"}
        </button>
      </div>

      {phase.kind === "error" && (
        <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">
          {phase.msg}
        </div>
      )}
      {phase.kind === "done" && (
        <div
          className={`space-y-2 rounded-md border px-3 py-2 text-sm ${
            phase.published
              ? "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-success)]"
              : "border-[var(--color-warning)] bg-[var(--color-warning-soft)] text-[var(--color-text-muted)]"
          }`}
        >
          <div>
            {phase.published
              ? "Root CA generated and published. rootCA.p12 (private key) was downloaded — store it and its passphrase securely."
              : phase.note}
          </div>
          <button
            type="button"
            onClick={() =>
              download("rootCA.der", phase.certDer, "application/pkix-cert")
            }
            className="text-xs text-[var(--color-primary)] hover:underline"
          >
            Download rootCA.der
          </button>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
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
