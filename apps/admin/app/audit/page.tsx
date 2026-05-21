import { SectionHeader } from "../components/SectionHeader";

export default function AuditPage() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Audit</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
          Audit posture for the deployment currently selected on the network pill — internal
          AUDIT.md state and external auditor links.
        </p>
      </header>

      <section>
        <SectionHeader title="Status" badge="mock" />
        <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
          Scaffold — render <code className="font-mono">contracts/AUDIT.md</code> + invariants
          run badges + external auditor PDFs.
        </div>
      </section>
    </div>
  );
}
