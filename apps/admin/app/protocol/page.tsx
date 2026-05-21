import { SectionHeader } from "../components/SectionHeader";

export default function ProtocolPage() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Protocol parameters</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
          Governed parameters across CommitmentPool, PrivateSettlement, and RelayerRegistry —
          fee splits, bond minimums, pause switches.
        </p>
      </header>

      <section>
        <SectionHeader title="Parameters" badge="mock" />
        <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
          Scaffold — bind to <code className="font-mono">setTreasury</code>,{" "}
          <code className="font-mono">setMinBond</code>,{" "}
          <code className="font-mono">setIdentityGate</code> etc. through the multisig.
        </div>
      </section>
    </div>
  );
}
