"use client";

/** Operator-CA › Root CA.
 *
 *  The company Root CA whose public certificate (`rootCA.der`) is
 *  anchored in zk-X509 and used to verify operator leaf certificates.
 *
 *  - If no Root CA exists yet, an admin generates one (client-side
 *    keypair + self-signed CA cert; the CA private key is downloaded as
 *    a password-encrypted PKCS#12 and never leaves the admin's device,
 *    while the public `rootCA.der` is published to the shared-orderbook).
 *    Generation is the operator-CA / X.509 module's job.
 *  - Once published, ANY account can download the public `rootCA.der`
 *    here (e.g. to anchor it in zk-X509, or to verify a chain).
 *
 *  Backend (shared-orderbook, in progress):
 *    GET  /api/ca/root         → public rootCA.der (+ metadata) | 404
 *    POST /api/ca/root (admin) → publish the generated rootCA.der */

import { useCallback, useEffect, useState } from "react";
import { SectionHeader } from "../../components/SectionHeader";

const ORDERBOOK_URL =
  process.env.NEXT_PUBLIC_SHARED_ORDERBOOK_URL ?? "http://localhost:4000";

interface RootCaInfo {
  commonName: string;
  organization: string;
  country: string;
  notAfter: number; // unix seconds
  fingerprint: string; // sha256 hex of the DER
}

export default function RootCaPage() {
  const [info, setInfo] = useState<RootCaInfo | null>(null);
  const [state, setState] = useState<"loading" | "present" | "absent" | "error">("loading");

  const refresh = useCallback(async () => {
    setState("loading");
    try {
      const res = await fetch(`${ORDERBOOK_URL}/api/ca/root/info`);
      if (res.status === 404) { setInfo(null); setState("absent"); return; }
      if (!res.ok) throw new Error(String(res.status));
      setInfo((await res.json()) as RootCaInfo);
      setState("present");
    } catch {
      setInfo(null);
      setState("error");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Operator CA — Root CA</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
          The company Root CA that signs operator leaf certificates. Its public
          certificate (<code className="font-mono">rootCA.der</code>) is anchored
          in zk-X509; anyone can download it here. The CA private key never
          leaves the admin device that generated it.
        </p>
      </header>

      <section>
        <SectionHeader
          title="Public Root CA certificate"
          badge="live"
          hint={state === "loading" ? "Checking…" : undefined}
        />
        {state === "present" && info ? (
          <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm">
            <Row label="Common name" value={info.commonName} />
            <Row label="Organization" value={info.organization} />
            <Row label="Country" value={info.country} />
            <Row
              label="Valid until"
              value={new Date(info.notAfter * 1000).toISOString().slice(0, 10)}
            />
            <Row label="SHA-256" value={info.fingerprint} mono />
            <a
              href={`${ORDERBOOK_URL}/api/ca/root`}
              download="rootCA.der"
              className="inline-block rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
            >
              Download rootCA.der
            </a>
          </div>
        ) : state === "absent" ? (
          <div className="rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-4 text-sm">
            <div className="font-medium">No Root CA published yet.</div>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              An admin needs to generate the company Root CA (below) and publish
              its public certificate. Until then operator certificates cannot be
              issued or verified.
            </p>
          </div>
        ) : state === "error" ? (
          <p className="text-sm text-[var(--color-danger)]">
            Could not reach the Root CA service ({ORDERBOOK_URL}).
          </p>
        ) : null}
      </section>

      <section>
        <SectionHeader title="Generate Root CA" badge="live" />
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-text-muted)]">
          Admin-only. Generates a self-signed CA keypair in the browser, downloads
          the CA private key as a password-encrypted{" "}
          <code className="font-mono">.p12</code> (kept by the admin) and publishes
          the public <code className="font-mono">rootCA.der</code>.
          <p className="mt-2 text-xs">
            The generation control is provided by the operator-CA X.509 module.
          </p>
        </div>
      </section>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      <span className="w-32 shrink-0 text-[var(--color-text-subtle)]">{label}</span>
      <span className={mono ? "break-all font-mono text-xs" : ""}>{value}</span>
    </div>
  );
}
