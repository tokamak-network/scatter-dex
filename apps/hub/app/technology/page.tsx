import type { Metadata } from "next";
import { ArrowRight, Lock, ShieldCheck, Zap, GitBranch } from "lucide-react";
import { Button } from "@zkscatter/ui";
import { Section } from "../components/Section";
import { FeatureCard } from "../components/FeatureCard";
import { EyebrowLabel, SectionHeading } from "../components/SectionHeader";

export const metadata: Metadata = {
  title: "Technology · zkScatter",
  description:
    "Off-chain matching, on-chain ZK settlement, KYC-aware without doxxing. The architecture, circuits, identity gating, and trust model behind zkScatter.",
};

export default function TechnologyPage() {
  return (
    <>
      <Hero />
      <Architecture />
      <Circuits />
      <CommitmentPool />
      <Identity />
      <RelayerNetwork />
      <TrustModel />
      <FooterCTA />
    </>
  );
}

function Hero() {
  return (
    <Section className="pt-24 pb-16">
      <div className="max-w-3xl">
        <EyebrowLabel>Technology</EyebrowLabel>
        <h1 className="mt-3 text-5xl font-bold leading-[1.05] tracking-tight md:text-6xl">
          Privacy-preserving DEX <br />
          with compliant identity.
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-[var(--color-text-muted)]">
          Trades are matched off-chain by a relayer network and settled
          on-chain through Groth16 proofs over a commitment pool — orders,
          amounts, and trader identities never appear in plaintext on-chain.
          A multi-CA zk-X509 identity gate keeps the system compliant without
          doxxing the user.
        </p>
      </div>
    </Section>
  );
}

function Architecture() {
  const layers = [
    {
      icon: Lock,
      title: "Frontend",
      body: "Wallet, EdDSA signing, browser-side proof generation. The user's order is signed locally; amount and side never leave the device unencrypted.",
    },
    {
      icon: GitBranch,
      title: "Relayer network",
      body: "Permissionless nodes pull from the shared orderbook, match pairs, generate half-proofs (~15K constraints per side), and submit settlement.",
    },
    {
      icon: ShieldCheck,
      title: "On-chain settlement",
      body: "PrivateSettlement verifies the proof and writes a commitment to the pool. RelayerRegistry gates submitters; IdentityGate gates the order side.",
    },
  ];
  return (
    <Section id="architecture" className="border-t border-[var(--color-border)]">
      <SectionHeading>Three-layer architecture</SectionHeading>
      <p className="mt-3 max-w-2xl text-[var(--color-text-muted)]">
        Each layer publishes the minimum surface the next one needs — the
        frontend never trusts the relayer, the contract never trusts either.
      </p>
      <div className="mt-10 grid gap-5 md:grid-cols-3">
        {layers.map((l) => (
          <FeatureCard key={l.title} {...l} />
        ))}
      </div>
      <pre className="mt-8 overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-6 font-mono text-[13px] leading-relaxed text-[var(--color-text-muted)]">
{`Frontend (Next.js / RN)  →  Relayer network (Node.js)  →  Contracts (Solidity)
       │                          │                              │
       ▼                          ▼                              ▼
   EdDSA keys              Order matching                PrivateSettlement
   Half-proof gen          Half-proof per side           CommitmentPool (IMT)
   Commitment build        Settlement submission         RelayerRegistry
                                                         IdentityGate (multi-CA)`}
      </pre>
    </Section>
  );
}

function Circuits() {
  const circuits = [
    { name: "authorize", c: "~15K", role: "Half-proof per-side settlement authorization" },
    { name: "cancel", c: "~8K", role: "Private order cancel" },
    { name: "claim", c: "~1.5K", role: "Claim with Merkle inclusion proof" },
    { name: "withdraw", c: "~6K", role: "Withdrawal from commitment pool" },
    { name: "deposit", c: "~4K", role: "Private deposit into commitment pool" },
  ];
  return (
    <Section id="circuits" className="border-t border-[var(--color-border)]">
      <EyebrowLabel>Circuits</EyebrowLabel>
      <SectionHeading className="mt-2">
        Five Circom circuits, one settlement story
      </SectionHeading>
      <p className="mt-3 max-w-2xl text-[var(--color-text-muted)]">
        Each circuit covers exactly one user action. Constraint counts are
        the headline cost — relayer hardware sizing falls out of these.
      </p>
      <div className="mt-8 overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
              <Th>Circuit</Th>
              <Th>Constraints</Th>
              <Th>Role</Th>
            </tr>
          </thead>
          <tbody className="[&_tr:not(:last-child)]:border-b [&_tr:not(:last-child)]:border-[var(--color-border)]">
            {circuits.map((c) => (
              <tr key={c.name}>
                <Td mono bold>{c.name}.circom</Td>
                <Td mono>{c.c}</Td>
                <Td>{c.role}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function CommitmentPool() {
  return (
    <Section id="commitment-pool" className="border-t border-[var(--color-border)] bg-[var(--color-surface-muted)]">
      <div className="grid gap-10 md:grid-cols-[1fr_2fr]">
        <div>
          <EyebrowLabel>Commitment pool</EyebrowLabel>
          <SectionHeading className="mt-2">
            Settlements as Merkle leaves.
          </SectionHeading>
        </div>
        <div className="space-y-4 text-[var(--color-text-muted)]">
          <p>
            The on-chain settlement contract does not store balances. It
            stores commitments — Poseidon hashes of <em>(amount, owner,
            secret)</em> tuples — in an incremental Merkle tree. A trader
            spends a commitment by proving membership and revealing a
            nullifier; the nullifier is logged so the same commitment can't
            be spent twice, but the committed values stay hidden.
          </p>
          <p>
            Because the pool's anonymity set is the union of every active
            commitment, a single trader's actions blend into the rest of
            the network's. There is no per-user balance to read on-chain.
          </p>
        </div>
      </div>
    </Section>
  );
}

function Identity() {
  return (
    <Section id="identity" className="border-t border-[var(--color-border)]">
      <div className="grid gap-10 md:grid-cols-[1fr_2fr]">
        <div>
          <EyebrowLabel>Compliance</EyebrowLabel>
          <SectionHeading className="mt-2">
            zk-X509 identity gating.
          </SectionHeading>
        </div>
        <div className="space-y-4 text-[var(--color-text-muted)]">
          <p>
            <code className="font-mono text-sm text-[var(--color-text)]">IdentityGate</code> verifies that the
            trader holds a signed attestation from one of a configured set
            of certificate authorities (X.509 PKIX, including KISA-path),
            without revealing the underlying credential. The proof asserts
            jurisdiction and sanctions status; the trader's identity stays
            on the trader's device.
          </p>
          <p>
            The CA set is multi-issuer and on-chain configurable. Adding a
            new CA does not recompile circuits — the verifier reads the
            current root list and accepts proofs against any of them.
          </p>
        </div>
      </div>
    </Section>
  );
}

function RelayerNetwork() {
  const points = [
    {
      icon: Zap,
      title: "Permissionless",
      body: "Anyone can register a relayer with a stake. The orderbook is shared; competition is on latency and uptime.",
    },
    {
      icon: Zap,
      title: "Gasless for users",
      body: "Relayers submit and pay gas. The fee comes out of the trade in the quote token.",
    },
    {
      icon: Zap,
      title: "MEV-free by construction",
      body: "Order payloads are encrypted before they reach the relayer; the settlement contract only accepts the proof. Reordering you can't read isn't a strategy.",
    },
  ];
  return (
    <Section id="relayer-network" className="border-t border-[var(--color-border)] bg-[var(--color-surface-muted)]">
      <EyebrowLabel>Relayer network</EyebrowLabel>
      <SectionHeading className="mt-2">
        Off-chain matching, on-chain proof.
      </SectionHeading>
      <div className="mt-10 grid gap-5 md:grid-cols-3">
        {points.map((p) => (
          <FeatureCard key={p.title} {...p} />
        ))}
      </div>
      <Button
        href="https://relayer.zkscatter.xyz"
        target="_blank"
        rel="noopener noreferrer"
        variant="secondary"
        size="md"
        className="mt-8"
      >
        See live relayers →
      </Button>
    </Section>
  );
}

function TrustModel() {
  const rows = [
    { actor: "Trader", trusts: "Local key material, browser proof gen", proves: "Authorization, identity, balance" },
    { actor: "Relayer", trusts: "Nothing about the trader's order", proves: "Match validity, half-proof on submit" },
    { actor: "Contract", trusts: "Nothing about either", proves: "Verifies Groth16; rejects bad proofs" },
  ];
  return (
    <Section id="trust" className="border-t border-[var(--color-border)]">
      <SectionHeading>Trust model</SectionHeading>
      <p className="mt-3 max-w-2xl text-[var(--color-text-muted)]">
        Each role has the smallest possible trust surface. Compromise at one
        layer does not compromise the next.
      </p>
      <div className="mt-8 overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
              <Th>Actor</Th>
              <Th>Trusts</Th>
              <Th>Proves</Th>
            </tr>
          </thead>
          <tbody className="[&_tr:not(:last-child)]:border-b [&_tr:not(:last-child)]:border-[var(--color-border)]">
            {rows.map((r) => (
              <tr key={r.actor}>
                <Td bold>{r.actor}</Td>
                <Td>{r.trusts}</Td>
                <Td>{r.proves}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function FooterCTA() {
  return (
    <Section className="border-t border-[var(--color-border)]">
      <div className="rounded-2xl bg-[var(--color-primary)] px-8 py-14 text-center text-white">
        <SectionHeading>Read the paper, then build.</SectionHeading>
        <p className="mx-auto mt-3 max-w-xl text-white/70">
          Half-proof authorization, commitment-pool settlement, multi-CA
          zk-X509 identity gating — designed and analyzed in the open.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Button
            href="https://github.com/tokamak-network/scatter-dex/blob/main/docs/research/PAPER.md"
            target="_blank"
            rel="noopener noreferrer"
            variant="inverse"
            size="lg"
          >
            Whitepaper
            <ArrowRight className="h-4 w-4" />
          </Button>
          <Button
            href="https://docs.zkscatter.xyz"
            target="_blank"
            rel="noopener noreferrer"
            variant="inverse-outline"
            size="lg"
          >
            Developer docs
          </Button>
        </div>
      </div>
    </Section>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="px-4 py-3 text-xs font-semibold uppercase tracking-wider">
      {children}
    </th>
  );
}

function Td({
  children,
  bold = false,
  mono = false,
}: {
  children: React.ReactNode;
  bold?: boolean;
  mono?: boolean;
}) {
  const classes = [
    "px-4 py-3",
    bold ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-muted)]",
    mono && "font-mono text-xs",
  ]
    .filter(Boolean)
    .join(" ");
  return <td className={classes}>{children}</td>;
}
