import { SectionHeader } from "../components/SectionHeader";
import { DEMO_NETWORK } from "../lib/network";
import { AuditViewer } from "./_components/AuditViewer";
import { ContractsTable } from "./_components/ContractsTable";
import { PauseStatus } from "./_components/PauseStatus";
import { loadAuditDocs } from "./audit-loader";

export const metadata = {
  title: "Audit — Scatter Admin",
  description:
    "Audit posture for this deployment: in-scope contracts, live pause state, internal AUDIT.md and HARDENING.md.",
};

export default function AuditPage() {
  // Build-time markdown load. Server component → client viewer.
  const docs = loadAuditDocs();
  const c = DEMO_NETWORK.contracts;

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-2xl font-semibold">Audit</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
          External auditor entry point: in-scope contracts on the live deployment, the
          repo's AUDIT package, and the live pause state across every pausable contract.
        </p>
      </header>

      <section>
        <SectionHeader title="In-scope contracts" badge="live" />
        <ContractsTable />
      </section>

      <section>
        <SectionHeader
          title="Live pause state"
          badge="live"
          hint="emergency-stop snapshot"
        />
        <PauseStatus
          targets={[
            { label: "CommitmentPool", address: c.commitmentPool },
            { label: "PrivateSettlement", address: c.privateSettlement },
          ]}
        />
      </section>

      <section>
        <SectionHeader title="Audit package" badge="live" hint="bundled at build time" />
        <AuditViewer docs={docs} />
      </section>

      <section>
        <SectionHeader title="External audits" badge="mock" />
        <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-text-muted)]">
          <p>
            No third-party audit reports are linked yet for this deployment. Drop PDFs into{" "}
            <code className="font-mono">docs/security/audits/</code> and surface them here in
            a follow-up commit.
          </p>
        </div>
      </section>
    </div>
  );
}
