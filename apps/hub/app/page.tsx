import Link from "next/link";
import { ArrowRight, Lock, ShieldCheck, Zap } from "lucide-react";
import { Button, buttonClassName } from "@zkscatter/ui";
import { USER_APPS, OPERATOR_APPS, DOCS_URL } from "./lib/apps";
import { AppCard } from "./components/AppCard";
import { Section } from "./components/Section";
import { FeatureCard } from "./components/FeatureCard";
import { EyebrowLabel, SectionHeading } from "./components/SectionHeader";

export default function HomePage() {
  return (
    <>
      <Hero />
      <Why />
      <AppsRouter />
      <OperatorsRouter />
      <HowItWorks />
      <Developers />
      <Proof />
      <FooterCTA />
    </>
  );
}

function Hero() {
  return (
    <Section className="pt-24 pb-16">
      <div className="max-w-3xl">
        <span className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-1 text-xs font-medium text-[var(--color-text-muted)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent-pay)]" />
          Testnet live · ZK Private Settlement
        </span>
        <h1 className="mt-6 text-5xl font-bold leading-[1.05] tracking-tight md:text-6xl">
          Private trades. <br />
          Compliant identity. <br />
          <span className="text-[var(--color-text-muted)]">One ZK stack.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-[var(--color-text-muted)]">
          Off-chain matching, on-chain ZK settlement, KYC-aware without doxxing
          your users. Four apps, one shared core.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="#apps" className={buttonClassName({ size: "lg" })}>
            Explore the apps
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="#developers"
            className={buttonClassName({ variant: "secondary", size: "lg" })}
          >
            Build with us
          </Link>
        </div>
      </div>
    </Section>
  );
}

function Why() {
  const items = [
    {
      icon: Lock,
      title: "Privacy by ZK",
      body: "Groth16 proofs over a commitment pool. Order amounts and trader identities are never revealed on-chain.",
    },
    {
      icon: ShieldCheck,
      title: "Compliant by zk-X509",
      body: "Multi-CA identity gating attests jurisdiction and KYC status — without exposing who the trader is.",
    },
    {
      icon: Zap,
      title: "Gasless & MEV-free",
      body: "A relayer network matches orders off-chain and submits settlement so users pay nothing and front-runners see nothing.",
    },
  ];
  return (
    <Section id="technology" className="border-t border-[var(--color-border)]">
      <div className="mb-10 flex items-end justify-between">
        <SectionHeading>Why zkScatter</SectionHeading>
        <Link
          href="/research"
          className="text-sm font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          Read the paper →
        </Link>
      </div>
      <div className="grid gap-5 md:grid-cols-3">
        {items.map((i) => (
          <FeatureCard key={i.title} {...i} />
        ))}
      </div>
      <div className="mt-8">
        <Link
          href="/technology"
          className="text-sm font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          Full architecture →
        </Link>
      </div>
    </Section>
  );
}

function AppsRouter() {
  return (
    <Section id="apps" className="border-t border-[var(--color-border)]">
      <div className="mb-10 max-w-2xl">
        <EyebrowLabel>For end-users</EyebrowLabel>
        <SectionHeading className="mt-2">Built for your role</SectionHeading>
        <p className="mt-3 text-[var(--color-text-muted)]">
          Same ZK core, different surface. Pick the app shaped to your job.
        </p>
      </div>
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        {USER_APPS.map((app) => (
          <AppCard key={app.id} app={app} />
        ))}
      </div>
      <div className="mt-8">
        <Link
          href="/apps"
          className="text-sm font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          Compare apps in detail →
        </Link>
      </div>
    </Section>
  );
}

function OperatorsRouter() {
  return (
    <Section className="border-t border-[var(--color-border)]">
      <div className="mb-10 max-w-2xl">
        <EyebrowLabel>For operators</EyebrowLabel>
        <SectionHeading className="mt-2">Run the network</SectionHeading>
        <p className="mt-3 text-[var(--color-text-muted)]">
          Every zkScatter user app runs on a permissionless relayer network.
          Match orders, generate ZK proofs, earn fees.
        </p>
      </div>
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        {OPERATOR_APPS.map((app) => (
          <AppCard key={app.id} app={app} />
        ))}
      </div>
    </Section>
  );
}

function HowItWorks() {
  const steps = [
    {
      eyebrow: "01",
      title: "Order",
      body: "User signs an EdDSA order locally. Amount, side, and identity stay on the device.",
    },
    {
      eyebrow: "02",
      title: "Match",
      body: "A relayer matches against the shared orderbook off-chain and produces a half-proof per side (~15K constraints).",
    },
    {
      eyebrow: "03",
      title: "Settle",
      body: "PrivateSettlement verifies the proof and writes a commitment to the pool. Claims happen later, gaslessly.",
    },
  ];
  return (
    <Section className="border-t border-[var(--color-border)]">
      <SectionHeading>How it works</SectionHeading>
      <p className="mt-3 max-w-2xl text-[var(--color-text-muted)]">
        Three steps. No mempool exposure. No identity leak.
      </p>
      <div className="mt-10 grid gap-5 md:grid-cols-3">
        {steps.map((s) => (
          <FeatureCard key={s.eyebrow} {...s} />
        ))}
      </div>
    </Section>
  );
}

function Developers() {
  return (
    <Section id="developers" className="border-t border-[var(--color-border)]">
      <div className="grid gap-12 md:grid-cols-2">
        <div>
          <EyebrowLabel>For developers</EyebrowLabel>
          <SectionHeading className="mt-3">
            Build private, compliant trading in an afternoon.
          </SectionHeading>
          <p className="mt-4 text-[var(--color-text-muted)]">
            One TypeScript SDK across contracts, ZK circuits, the relayer
            network, and the shared orderbook. Used by every persona app.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              size="lg"
            >
              Open developer docs
              <ArrowRight className="h-4 w-4" />
            </Button>
            <Button
              href="https://github.com/tokamak-network/scatter-dex"
              target="_blank"
              rel="noopener noreferrer"
              variant="secondary"
              size="lg"
            >
              GitHub
            </Button>
          </div>
        </div>
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-primary)] p-6 text-sm text-white shadow-sm">
          <div className="mb-3 font-mono text-xs text-white/60">
            $ npm install @zkscatter/sdk
          </div>
          <pre className="overflow-x-auto font-mono text-[13px] leading-relaxed text-white/90">
{`import {
  PRIVATE_SETTLEMENT_IFACE,
  chainName,
  parseTokenList,
  type NetworkConfig,
} from "@zkscatter/sdk";

const network: NetworkConfig = {
  chainId: 11155111,
  rpcUrl: process.env.RPC_URL!,
  contracts: { /* ... */ },
  tokens: parseTokenList(
    "0x...:USDC:6,0x...:WETH:18",
  ),
};

chainName(network.chainId);
// → "Sepolia"

PRIVATE_SETTLEMENT_IFACE.parseLog(log);
// decode Settled events without
// re-instantiating ethers.`}
          </pre>
        </div>
      </div>
    </Section>
  );
}

function Proof() {
  const items = [
    { k: "Circuits audited", v: "5 / 5" },
    { k: "ZK constraints", v: "~15K" },
    { k: "Settlement gas", v: "Gasless" },
    { k: "Identity CAs", v: "Multi" },
  ];
  return (
    <Section id="research" className="border-t border-[var(--color-border)]">
      <div className="grid gap-10 md:grid-cols-[1fr_auto] md:items-end">
        <div className="max-w-2xl">
          <SectionHeading>Backed by published research.</SectionHeading>
          <p className="mt-3 text-[var(--color-text-muted)]">
            Half-proof authorization, commitment-pool settlement, and zk-X509
            identity gating — designed and analyzed in the open.
          </p>
          <Link
            href="/research"
            className="mt-5 inline-flex text-sm font-medium text-[var(--color-text)] hover:underline"
          >
            Read the whitepaper →
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {items.map((i) => (
            <div
              key={i.k}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3"
            >
              <div className="text-lg font-semibold">{i.v}</div>
              <div className="text-xs text-[var(--color-text-muted)]">{i.k}</div>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}

function FooterCTA() {
  return (
    <Section className="border-t border-[var(--color-border)]">
      <div className="rounded-2xl bg-[var(--color-primary)] px-8 py-14 text-center text-white">
        <SectionHeading>Ship privacy without losing compliance.</SectionHeading>
        <p className="mx-auto mt-3 max-w-xl text-white/70">
          Pick the app shaped for you, or build your own on the same ZK core.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            href="/apps"
            className={buttonClassName({ variant: "inverse", size: "lg" })}
          >
            Try the apps
          </Link>
          <Button
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            variant="inverse-outline"
            size="lg"
          >
            Read the docs
          </Button>
        </div>
      </div>
    </Section>
  );
}
