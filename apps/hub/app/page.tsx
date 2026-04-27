import Link from "next/link";
import { ArrowRight, Lock, ShieldCheck, Zap } from "lucide-react";
import { USER_APPS, OPERATOR_APPS } from "./lib/apps";
import { AppCard } from "./components/AppCard";

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

function Section({
  id,
  className = "",
  children,
}: {
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={`mx-auto max-w-6xl px-6 py-20 ${className}`}>
      {children}
    </section>
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
          <Link
            href="#apps"
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-primary)] px-5 py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            Explore the apps
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="#developers"
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] px-5 py-2.5 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-muted)]"
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
      Icon: Lock,
      title: "Privacy by ZK",
      body: "Groth16 proofs over a commitment pool. Order amounts and trader identities are never revealed on-chain.",
    },
    {
      Icon: ShieldCheck,
      title: "Compliant by zk-X509",
      body: "Multi-CA identity gating attests jurisdiction and KYC status — without exposing who the trader is.",
    },
    {
      Icon: Zap,
      title: "Gasless & MEV-free",
      body: "A relayer network matches orders off-chain and submits settlement so users pay nothing and front-runners see nothing.",
    },
  ];
  return (
    <Section id="technology" className="border-t border-[var(--color-border)]">
      <div className="mb-10 flex items-end justify-between">
        <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
          Why zkScatter
        </h2>
        <Link
          href="#developers"
          className="text-sm font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          Read the paper →
        </Link>
      </div>
      <div className="grid gap-5 md:grid-cols-3">
        {items.map(({ Icon, title, body }) => (
          <div
            key={title}
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
          >
            <Icon className="h-5 w-5 text-[var(--color-text)]" />
            <div className="mt-4 text-lg font-semibold">{title}</div>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">{body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function AppsRouter() {
  return (
    <Section id="apps" className="border-t border-[var(--color-border)]">
      <div className="mb-10 max-w-2xl">
        <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-subtle)]">
          For end-users
        </div>
        <h2 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">
          Built for your role
        </h2>
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
        <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-subtle)]">
          For operators
        </div>
        <h2 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">
          Run the network
        </h2>
        <p className="mt-3 text-[var(--color-text-muted)]">
          The four user apps run on a permissionless relayer network. Match
          orders, generate ZK proofs, earn fees.
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
      n: "01",
      title: "Order",
      body: "User signs an EdDSA order locally. Amount, side, and identity stay on the device.",
    },
    {
      n: "02",
      title: "Match",
      body: "A relayer matches against the shared orderbook off-chain and produces a half-proof per side (~15K constraints).",
    },
    {
      n: "03",
      title: "Settle",
      body: "PrivateSettlement verifies the proof and writes a commitment to the pool. Claims happen later, gaslessly.",
    },
  ];
  return (
    <Section className="border-t border-[var(--color-border)]">
      <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">How it works</h2>
      <p className="mt-3 max-w-2xl text-[var(--color-text-muted)]">
        Three steps. No mempool exposure. No identity leak.
      </p>
      <div className="mt-10 grid gap-5 md:grid-cols-3">
        {steps.map((s) => (
          <div
            key={s.n}
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
          >
            <div className="font-mono text-xs text-[var(--color-text-subtle)]">{s.n}</div>
            <div className="mt-2 text-lg font-semibold">{s.title}</div>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">{s.body}</p>
          </div>
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
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-subtle)]">
            For developers
          </div>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
            Build private, compliant trading in an afternoon.
          </h2>
          <p className="mt-4 text-[var(--color-text-muted)]">
            One TypeScript SDK across contracts, ZK circuits, the relayer
            network, and the shared orderbook. Used by every persona app.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <a
              href="https://docs.zkscatter.xyz"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-primary)] px-5 py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
            >
              Open developer docs
              <ArrowRight className="h-4 w-4" />
            </a>
            <a
              href="https://github.com/tokamak-network"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] px-5 py-2.5 text-sm font-medium hover:bg-[var(--color-surface-muted)]"
            >
              GitHub
            </a>
          </div>
        </div>
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-primary)] p-6 text-sm text-white shadow-sm">
          <div className="mb-3 font-mono text-xs text-white/60">
            $ npm install @zkscatter/sdk
          </div>
          <pre className="overflow-x-auto font-mono text-[13px] leading-relaxed text-white/90">
{`import {
  createScatterClient,
  SEPOLIA,
} from "@zkscatter/sdk";

const client = createScatterClient({
  network: SEPOLIA,
  rpcUrl: process.env.RPC_URL,
});

const fill = await client.relayer.submit(
  await client.zk.generateAuthorizeProof({
    side: "buy",
    base: "USDC",
    quote: "WETH",
    amount: 1000_000000n,
    price: 3500_000000n,
  }),
);

console.log(fill.txHash);`}
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
          <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
            Backed by published research.
          </h2>
          <p className="mt-3 text-[var(--color-text-muted)]">
            Half-proof authorization, commitment-pool settlement, and zk-X509
            identity gating — designed and analyzed in the open.
          </p>
          <a
            href="https://github.com/tokamak-network"
            target="_blank"
            rel="noreferrer"
            className="mt-5 inline-flex text-sm font-medium text-[var(--color-text)] hover:underline"
          >
            Read the whitepaper →
          </a>
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
        <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
          Ship privacy without losing compliance.
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-white/70">
          Pick the app shaped for you, or build your own on the same ZK core.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            href="/apps"
            className="rounded-md bg-white px-5 py-2.5 text-sm font-medium text-[var(--color-primary)] hover:bg-white/90"
          >
            Try the apps
          </Link>
          <a
            href="https://docs.zkscatter.xyz"
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-white/30 px-5 py-2.5 text-sm font-medium text-white hover:bg-white/10"
          >
            Read the docs
          </a>
        </div>
      </div>
    </Section>
  );
}
