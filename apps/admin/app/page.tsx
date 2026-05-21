import Link from "next/link";
import { SectionHeader } from "./components/SectionHeader";

const TILES = [
  {
    href: "/operator-ca",
    title: "Operator CA",
    blurb:
      "Issue X.509 certificates that attest a relayer operator's identity, then write the attestation into the on-chain IdentityRegistry.",
    cta: "Issue cert →",
    badge: "live" as const,
  },
  {
    href: "/sanctions",
    title: "SanctionsList",
    blurb:
      "Manage the self-multisig sanction entries (KoFIU / emergency holds). The Chainalysis OFAC oracle is read-only and external.",
    cta: "Open list →",
    badge: "live" as const,
  },
  {
    href: "/protocol",
    title: "Protocol parameters",
    blurb:
      "Fee splits, bond minimums, pause switches, and other governed parameters across CommitmentPool, PrivateSettlement, and RelayerRegistry.",
    cta: "Review →",
    badge: "live" as const,
  },
  {
    href: "/treasury",
    title: "Treasury",
    blurb:
      "FeeVault: per-token platform revenue + withdraw, timelocked fee changes, setTreasury, authorized depositors.",
    cta: "Open →",
    badge: "live" as const,
  },
  {
    href: "/audit",
    title: "Audit",
    blurb:
      "In-scope contracts on this deployment, live pause state, and the repo's AUDIT.md + HARDENING.md bundled inline.",
    cta: "View →",
    badge: "live" as const,
  },
];

export default function AdminHome() {
  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Platform administration</h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--color-text-muted)]">
          Operator identity issuance, sanctions, protocol parameters, and treasury — wired
          to the multisig key that governs this deployment.
        </p>
      </header>

      <section>
        <SectionHeader title="Modules" badge="live" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {TILES.map((tile) => (
            <Link
              key={tile.href}
              href={tile.href}
              className="group rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 transition hover:border-[var(--color-primary)]"
            >
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">{tile.title}</h2>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                    tile.badge === "live"
                      ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
                      : "bg-[var(--color-bg)] text-[var(--color-text-subtle)]"
                  }`}
                >
                  {tile.badge}
                </span>
              </div>
              <p className="mt-2 text-sm text-[var(--color-text-muted)]">{tile.blurb}</p>
              <div className="mt-3 text-sm font-medium text-[var(--color-primary)] group-hover:underline">
                {tile.cta}
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
