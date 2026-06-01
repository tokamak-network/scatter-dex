"use client";

/** Operator self-service certificate issuance.
 *
 *  The operator lands here from the KYC-approval email (`?wallet=<addr>`),
 *  connects that wallet, and generates their cert key material **in their own
 *  browser** (PKI design §12.2 trust boundary):
 *
 *   1. Gate: only proceeds when the connected wallet is `approved` on-chain
 *      (IssuanceApprovalRegistry) — reuses the same read as the relayer
 *      register Step 1.
 *   2. Subject (CN/O/C) is **read-only**, taken verbatim from the on-chain
 *      approval — the operator cannot mint a cert for an identity the admin
 *      didn't approve (design §12.3 "CSR subject == on-chain approval").
 *   3. WebCrypto P-256 keygen → private key downloaded as a passphrase-encrypted
 *      PKCS#12 (never leaves the device) → only the public **CSR** is produced.
 *
 *  ⚠ Test/devnet PoC. CSR submission/signing is wired in a follow-up; for now
 *  the operator downloads the CSR and hands it to the CA. Production signs via
 *  an HSM-backed Issuing CA (§12).
 */

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { eqAddr, isConfiguredAddress } from "@zkscatter/sdk";
import { LiveFreshness, useWallet } from "@zkscatter/sdk/react";
import { DEMO_NETWORK } from "../lib/network";
import { useIssuanceApproval } from "../lib/useIssuanceApproval";
import { generateOperatorKeypair, isValidCountryCode } from "../lib/operatorCert";
import { buildOperatorCsr } from "../lib/csr";
import { exportOperatorPkcs12 } from "../lib/pkcs12";

const MIN_PASSPHRASE = 12;

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

export default function OperatorCertPage() {
  return (
    <Suspense fallback={<div className="text-sm text-[var(--color-text-muted)]">Loading…</div>}>
      <OperatorCertBody />
    </Suspense>
  );
}

function OperatorCertBody() {
  const search = useSearchParams();
  const targetWallet = (search?.get("wallet") ?? "").trim();

  const { account, connect } = useWallet();
  const approval = useIssuanceApproval();
  const subject = approval.approval;

  const [passphrase, setPassphrase] = useState("");
  const [passphraseConfirm, setPassphraseConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ csrPem: string; fingerprint: string } | null>(null);

  const gateConfigured = isConfiguredAddress(DEMO_NETWORK.contracts.issuanceApprovalRegistry);
  // The email link targets a specific approved wallet; the operator must connect
  // THAT wallet (the approval — and therefore the read-only subject — is keyed
  // to it). With no `?wallet=`, any connected wallet's own approval is used.
  const walletMatches = !targetWallet || (!!account && eqAddr(account, targetWallet));
  const approved = approval.status === "approved";
  const canIssue = gateConfigured && approved && walletMatches && !!account && !!subject;

  function passphraseError(): string | null {
    if (passphrase.length < MIN_PASSPHRASE)
      return `Passphrase must be at least ${MIN_PASSPHRASE} characters`;
    if (passphrase !== passphraseConfirm) return "Passphrases do not match";
    return null;
  }

  async function handleGenerate() {
    setError(null);
    // Defense-in-depth: the button is disabled when !canIssue, but guard the
    // callback too so a programmatic invocation can't bypass the gate.
    if (!canIssue || !subject) {
      setError("Issuance is not permitted: connect the approved wallet first.");
      return;
    }
    const pe = passphraseError();
    if (pe) {
      setError(pe);
      return;
    }
    // The subject is the on-chain approved identity — never operator input.
    const subj = {
      commonName: subject.commonName,
      organization: subject.organization,
      country: subject.country,
    };
    if (!isValidCountryCode(subj.country)) {
      setError(`On-chain approval has a malformed country code ("${subj.country}").`);
      return;
    }

    setBusy(true);
    try {
      const kp = await generateOperatorKeypair();
      // CSR build and .p12 encryption are independent once the key exists.
      // The private key leaves the browser only inside the encrypted .p12.
      const [{ csrPem }, p12] = await Promise.all([
        buildOperatorCsr(kp.keyPair, subj),
        exportOperatorPkcs12(kp.privateKeyPem, passphrase),
      ]);
      const tag = `${account!.slice(0, 10)}-${new Date().toISOString().slice(0, 10)}`;
      download(`operator-${tag}.p12`, p12, "application/x-pkcs12");
      setResult({ csrPem, fingerprint: kp.publicKeyFingerprint });
      setPassphrase("");
      setPassphraseConfirm("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Key/CSR generation failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Operator certificate</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
          Generate your operator certificate key in this browser and produce a signing
          request (CSR). Your private key is encrypted with a passphrase and never leaves
          your device — only the public CSR is submitted to the CA.
        </p>
      </header>

      <div
        role="note"
        className="flex items-start gap-3 rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-4 py-3 text-sm text-[var(--color-text-muted)]"
      >
        <span aria-hidden className="text-base leading-none">⚠</span>
        <div>
          <span className="font-semibold text-[var(--color-warning)]">
            Test / devnet only — not for production.
          </span>{" "}
          Browser key generation is a proof-of-concept. Production binds operator keys to
          hardware (WebAuthn/Secure Enclave) and signs via an HSM-backed Issuing CA — see
          the PKI design doc §12.
        </div>
      </div>

      {!gateConfigured ? (
        <div className="rounded-xl border border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-4 text-sm text-[var(--color-danger)]">
          The issuance-approval registry isn’t configured for this network — certificate
          issuance is unavailable here.
        </div>
      ) : (
        <>
          <GateBanner
            account={account}
            targetWallet={targetWallet}
            walletMatches={walletMatches}
            approval={approval}
            onConnect={() => void connect()}
          />

          {subject && approved && walletMatches && (
            <section className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
              <div>
                <h2 className="text-sm font-semibold text-[var(--color-text-muted)]">
                  Approved identity
                </h2>
                <p className="mt-0.5 text-xs text-[var(--color-text-subtle)]">
                  Read-only — set by the admin’s on-chain approval. Your certificate will
                  bind exactly these values.
                </p>
              </div>
              <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <ReadOnly label="Common Name (CN)" value={subject.commonName} />
                <ReadOnly label="Organisation (O)" value={subject.organization} />
                <ReadOnly label="Country (C)" value={subject.country} />
                <ReadOnly
                  label="Validity"
                  value={`${subject.validityDays} days`}
                  hint="applied by the CA at signing"
                />
              </dl>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Key passphrase" hint={`min ${MIN_PASSPHRASE} chars`}>
                  <input
                    type="password"
                    autoComplete="new-password"
                    className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
                    placeholder="encrypts your private key"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                  />
                </Field>
                <Field label="Confirm passphrase">
                  <input
                    type="password"
                    autoComplete="new-password"
                    className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
                    value={passphraseConfirm}
                    onChange={(e) => setPassphraseConfirm(e.target.value)}
                  />
                </Field>
              </div>
              <p className="text-xs text-[var(--color-text-muted)]">
                The private key is encrypted with this passphrase (PBKDF2-HMAC-SHA256 +
                AES-256-CBC) and downloaded as a <code className="font-mono">.p12</code>.
                Keep both safe — they cannot be recovered if lost, and the passphrase is
                never stored or sent anywhere.
              </p>

              {error && (
                <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">
                  {error}
                </div>
              )}

              <button
                type="button"
                disabled={busy || !canIssue || passphraseError() !== null}
                onClick={() => void handleGenerate()}
                className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
              >
                {busy ? "Generating…" : "Generate key & CSR"}
              </button>
            </section>
          )}

          {result && (
            <section className="space-y-3 rounded-xl border border-[var(--color-success)] bg-[var(--color-success-soft)] p-5 text-sm">
              <div className="font-medium text-[var(--color-success)]">
                Key generated — <code className="font-mono">.p12</code> downloaded.
              </div>
              <p className="text-xs text-[var(--color-text-muted)]">
                Public key SHA-256: <span className="font-mono">{result.fingerprint}</span>
              </p>
              <Preview label="Certificate signing request (CSR)" value={result.csrPem} />
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() =>
                    download("operator.csr", result.csrPem, "application/pkcs10")
                  }
                  className="rounded-md border border-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]"
                >
                  Download CSR
                </button>
              </div>
              <p className="text-xs text-[var(--color-text-subtle)]">
                Submit this CSR to the CA to receive your signed certificate. (Automated
                submission is wired in a follow-up; for now hand it off out-of-band.)
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function GateBanner({
  account,
  targetWallet,
  walletMatches,
  approval,
  onConnect,
}: {
  account: string | null | undefined;
  targetWallet: string;
  walletMatches: boolean;
  approval: ReturnType<typeof useIssuanceApproval>;
  onConnect: () => void;
}) {
  if (!account) {
    return (
      <Banner tone="warn">
        <span>
          {targetWallet
            ? `Connect the approved wallet (${shorten(targetWallet)}) to issue your certificate.`
            : "Connect your operator wallet to check issuance approval."}
        </span>
        <button
          type="button"
          onClick={onConnect}
          className="shrink-0 rounded-md bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-white hover:bg-[var(--color-primary-hover)]"
        >
          Connect wallet
        </button>
      </Banner>
    );
  }

  if (targetWallet && !walletMatches) {
    return (
      <Banner tone="danger">
        <span>
          Connected wallet doesn’t match the approved address ({shorten(targetWallet)}).
          Switch to that wallet to continue.
        </span>
      </Banner>
    );
  }

  // status → (tone, message). One Banner shape for all gate states; only the
  // tone and copy vary. `idle` (no registry / no wallet) renders nothing.
  const states: Partial<Record<typeof approval.status, { tone: "ok" | "warn" | "danger"; message: string }>> = {
    approved: { tone: "ok", message: "Wallet approved — your certificate identity is set below." },
    checking: { tone: "warn", message: "Checking issuance approval…" },
    "not-approved": {
      tone: "warn",
      message: "This wallet isn’t approved for issuance yet — an admin must approve it first.",
    },
    revoked: {
      tone: "danger",
      message: `Issuance approval was revoked: ${approval.revokeReason ?? "(no reason)"}.`,
    },
    expired: { tone: "warn", message: "Issuance approval has expired — request re-approval." },
    error: { tone: "danger", message: `Couldn’t read issuance approval: ${approval.message ?? "RPC error"}.` },
  };
  const state = states[approval.status];
  if (!state) return null;
  return (
    <Banner tone={state.tone}>
      <span>{state.message}</span>
      <Freshness approval={approval} />
    </Banner>
  );
}

function Freshness({ approval }: { approval: ReturnType<typeof useIssuanceApproval> }) {
  return (
    <LiveFreshness
      lastRefreshedAt={approval.lastRefreshedAt}
      loading={approval.status === "checking"}
      onRefresh={approval.refetch}
      label="approval"
    />
  );
}

function Banner({ tone, children }: { tone: "ok" | "warn" | "danger"; children: React.ReactNode }) {
  const cls =
    tone === "ok"
      ? "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-success)]"
      : tone === "danger"
        ? "border-[var(--color-danger)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]"
        : "border-[var(--color-warning)] bg-[var(--color-warning-soft)] text-[var(--color-text-muted)]";
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 rounded-md border ${cls} px-4 py-2.5 text-sm`}>
      {children}
    </div>
  );
}

function ReadOnly({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
        {label}
        {hint && <span className="ml-1 normal-case">· {hint}</span>}
      </dt>
      <dd className="mt-0.5 break-all font-medium">{value}</dd>
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

function Preview({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          {label}
        </div>
        <button
          type="button"
          onClick={() => void navigator.clipboard.writeText(value)}
          className="text-xs text-[var(--color-primary)] hover:underline"
        >
          Copy
        </button>
      </div>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--color-surface)] p-3 text-xs">
        {value}
      </pre>
    </div>
  );
}

function shorten(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 8)}…${addr.slice(-4)}` : addr;
}
