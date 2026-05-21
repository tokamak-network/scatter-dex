import { SectionHeader } from "../components/SectionHeader";

export default function SanctionsPage() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">SanctionsList</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
          Self-multisig sanction entries: KoFIU and emergency holds. The Chainalysis OFAC
          oracle is consumed externally and not editable here.
        </p>
      </header>

      <section>
        <SectionHeader title="Manual entries" badge="mock" />
        <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
          Scaffold — wire to <code className="font-mono">SanctionsList</code> contract with the
          admin multisig signer to add/remove entries.
        </div>
      </section>
    </div>
  );
}
