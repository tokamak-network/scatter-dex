import { SectionHeader } from "../components/SectionHeader";

export default function TreasuryPage() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Treasury</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
          Multisig treasury operations: protocol fee withdrawals, grants, and reserve transfers.
        </p>
      </header>

      <section>
        <SectionHeader title="Balances" badge="mock" />
        <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
          Scaffold — read <code className="font-mono">FeeVault</code> balances and surface
          withdraw flows guarded by the multisig.
        </div>
      </section>
    </div>
  );
}
