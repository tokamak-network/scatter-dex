import Link from "next/link";

const campaigns = [
  { id: "c_xyz_genesis",   token: "$XYZ", recipients: 12453, claimed: 7986, status: "live",     ends: "13d 4h"  },
  { id: "c_nft_holders",   token: "$XYZ", recipients: 3210,  claimed: 3210, status: "complete", ends: "—"       },
  { id: "c_early_testers", token: "$XYZ", recipients: 850,   claimed: 522,  status: "complete", ends: "—"       },
];

export default function Campaigns() {
  return (
    <div className="space-y-10">
      <section className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Airdrop campaigns</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Real anti-sybil. Gasless claims. Recipient amounts hidden on-chain to reduce dump pressure.
          </p>
        </div>
        <Link
          href="/campaigns/new"
          className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
        >
          New campaign
        </Link>
      </section>

      <section className="grid grid-cols-3 gap-4">
        <Stat label="Active campaigns" value="1" sub="Genesis ($XYZ)" />
        <Stat label="Claim rate (avg)" value="64%" sub="vs 25% industry" />
        <Stat label="Sybil blocked" value="3,841" sub="zk-X509 enforced" />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-text-muted)]">All campaigns</h2>
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          {campaigns.map((c) => (
            <div key={c.id} className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4 last:border-b-0">
              <div>
                <div className="font-medium">{c.id}</div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  {c.token} · {c.recipients.toLocaleString()} eligible · {c.claimed.toLocaleString()} claimed
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-xs text-[var(--color-text-muted)]">{c.ends}</div>
                {c.status === "live" ? (
                  <span className="rounded-full bg-[var(--color-primary-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-primary)]">Live</span>
                ) : (
                  <span className="rounded-full bg-[var(--color-success-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-success)]">Complete</span>
                )}
                <Link href={`/claim/${c.id}`} className="text-sm text-[var(--color-primary)] hover:underline">
                  Recipient view →
                </Link>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">{sub}</div>
    </div>
  );
}
