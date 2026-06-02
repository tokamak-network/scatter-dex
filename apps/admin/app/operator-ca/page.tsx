"use client";

import { isConfiguredAddress } from "@zkscatter/sdk";
import { SectionHeader } from "../components/SectionHeader";
import { Stat } from "../components/Stat";
import { DEMO_NETWORK } from "../lib/network";
import { useRelayerIdentityRegistry } from "../lib/useRelayerIdentityRegistry";
import { AttestationPanel } from "./_components/AttestationPanel";

export default function OperatorCaPage() {
  // The attestation registry is read on-chain from
  // RelayerRegistry.identityRegistry() (set on the Identity (relayer) tab),
  // not from a static env var — so this page always reflects the live wiring.
  const { address: identityRegistry, loading: registryLoading } = useRelayerIdentityRegistry();
  const registryConfigured = isConfiguredAddress(identityRegistry ?? "");

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-2xl font-semibold">Operator CA — verify &amp; attest</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
          scatter-dex no longer issues operator certificates. An operator&apos;s identity is
          their <strong>real accredited certificate</strong>, verified by the external{" "}
          <strong>zk-X509</strong> delegated-proving flow — scatter-dex only reads the result.
          Onboarding is gated by two independent checks:
        </p>
        <ul className="mt-2 max-w-2xl list-disc space-y-1 pl-5 text-sm text-[var(--color-text-muted)]">
          <li>
            <strong>zk-X509 verification</strong> — the operator proves their certificate to
            zk-X509, which flips <code className="font-mono">IdentityRegistry.isVerified(wallet)</code>{" "}
            (attested below).
          </li>
          <li>
            <strong>KYC approval</strong> — an admin reviews the operator&apos;s KYC submission and
            approves the wallet (the <strong>KYC review</strong> tab). On-chain this is{" "}
            <code className="font-mono">IssuanceApprovalRegistry.isApproved(wallet)</code>.
          </li>
        </ul>
      </header>

      <section>
        <SectionHeader title="Active deployment" badge="live" />
        <div className="grid grid-cols-2 gap-4">
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
        </div>
      </section>

      <section>
        <SectionHeader
          title="On-chain attestation (zk-X509 verification)"
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

      <section>
        <SectionHeader
          title="Compliance cross-check"
          badge="planned"
          hint="match the certificate the operator proved against their KYC submission"
        />
        <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-sm text-[var(--color-text-muted)]">
          <p>
            The certificate subject (common name / organization / country) the operator proved
            to zk-X509 is recorded by the prover and exposed via its compliance API
            (<code className="font-mono">GET /api/compliance?wallet=</code>). An admin
            cross-checks it against the operator&apos;s KYC video and documents before approving.
          </p>
          <p className="mt-2">
            Wiring pending — the prover compliance endpoint is being finalized; this panel will
            then surface the proved subject (and the certificate serial / consent signature)
            here for side-by-side review with KYC.
          </p>
        </div>
      </section>
    </div>
  );
}
