import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, ExternalLink, FileText } from "lucide-react";
import { buttonClassName } from "@zkscatter/ui";
import { Section } from "../components/Section";
import { EyebrowLabel, SectionHeading } from "../components/SectionHeader";

const REPO_BASE =
  "https://github.com/tokamak-network/scatter-dex/blob/main";
const DOCS_BASE =
  process.env.NEXT_PUBLIC_DOCS_URL ?? "https://zkscatter-docs.web.app";

type Paper = {
  id: string;
  status: "draft" | "published" | "in-review";
  title: string;
  authors: string;
  date: string;
  abstract: string;
  topics: string[];
  href: string;
  external?: boolean;
};

const PAPERS: Paper[] = [
  {
    id: "whitepaper",
    status: "in-review",
    title: "zkScatter Whitepaper",
    authors: "Tokamak Network Research",
    date: "Working draft v0.1, 2026-04",
    abstract:
      "Private settlement network for compliant on-chain finance. Half-proof authorization, witness-free relayer matching, multi-CA identity gate, and TON-denominated relayer bond.",
    topics: ["overview", "protocol design", "zk-X509"],
    href: `${DOCS_BASE}/docs/whitepaper`,
    external: true,
  },
  {
    id: "architecture-v2",
    status: "published",
    title: "Architecture v2 — Federated Relayers + Client-side Proving",
    authors: "Tokamak Network Research",
    date: "2026-04",
    abstract:
      "Evolution from single-relayer custodial-witness model to federated relayer + client-side proving + fair-exchange. Half-proof primitive, Waku v2 commit-reveal protocol, on-chain dispute registry.",
    topics: ["architecture", "half-proof", "relayer protocol"],
    href: `${REPO_BASE}/docs/architecture/architecture-v2.md`,
    external: true,
  },
  {
    id: "perf-proving",
    status: "published",
    title: "Browser ZK Proof Performance Analysis",
    authors: "Tokamak Network Research",
    date: "2026-04-10",
    abstract:
      "Empirical analysis of Groth16 proof generation in browsers. Constraint inventory, snarkjs vs rapidsnark feasibility, SharedArrayBuffer + COOP/COEP impact on MSM parallelization.",
    topics: ["zk-snark", "performance", "browser"],
    href: `${REPO_BASE}/docs/research/perf-proving-analysis.md`,
    external: true,
  },
];

export const metadata: Metadata = {
  title: "Research · zkScatter",
  description:
    "Whitepaper, technical papers, and design documents behind zkScatter — half-proof authorization, commitment-pool settlement, and zk-X509 identity gating.",
};

export default function ResearchPage() {
  return (
    <>
      <Hero />
      <Papers />
      <Contribute />
    </>
  );
}

function Hero() {
  return (
    <Section className="pt-24 pb-12">
      <div className="max-w-3xl">
        <EyebrowLabel>Research</EyebrowLabel>
        <h1 className="mt-4 text-5xl font-bold leading-[1.05] tracking-tight md:text-6xl">
          Designed and analyzed in the open.
        </h1>
        <p className="mt-6 text-lg text-[var(--color-text-muted)]">
          The protocol stack is documented as research before it ships.
          Whitepaper, formal design notes, and performance analyses are
          published so reviewers can verify our claims and external researchers
          can build on the same primitives.
        </p>
      </div>
    </Section>
  );
}

function Papers() {
  return (
    <Section className="border-t border-[var(--color-border)]">
      <SectionHeading>Papers and design notes</SectionHeading>
      <div className="mt-10 grid gap-5 md:grid-cols-2">
        {PAPERS.map((p) => (
          <PaperCard key={p.id} paper={p} />
        ))}
      </div>
    </Section>
  );
}

function PaperCard({ paper }: { paper: Paper }) {
  const isDraft = paper.status === "draft";
  // Label the CTA to match where the link actually goes — the
  // whitepaper opens in the docs site while the others link to
  // GitHub markdown.
  const ctaLabel = paper.href.startsWith(DOCS_BASE)
    ? "Read in Docs"
    : "Read on GitHub";
  const Inner = (
    <article
      className={`flex h-full flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 transition ${
        isDraft ? "opacity-70" : "hover:border-[var(--color-text-muted)]"
      }`}
    >
      <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
        <FileText className="h-3.5 w-3.5" />
        <StatusBadge status={paper.status} />
        <span>·</span>
        <span>{paper.date}</span>
      </div>
      <h3 className="mt-3 text-xl font-semibold text-[var(--color-text)]">
        {paper.title}
      </h3>
      <div className="mt-1 text-sm text-[var(--color-text-muted)]">
        {paper.authors}
      </div>
      <p className="mt-4 flex-1 text-sm text-[var(--color-text-muted)]">
        {paper.abstract}
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        {paper.topics.map((t) => (
          <span
            key={t}
            className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-muted)]"
          >
            {t}
          </span>
        ))}
      </div>
      <div className="mt-5 inline-flex items-center gap-1 text-sm font-medium text-[var(--color-text)]">
        {isDraft ? (
          <span className="text-[var(--color-text-muted)]">
            Coming soon
          </span>
        ) : (
          <>
            {ctaLabel}
            <ExternalLink className="h-3.5 w-3.5" />
          </>
        )}
      </div>
    </article>
  );

  if (isDraft) {
    return Inner;
  }
  if (paper.external) {
    return (
      <a href={paper.href} target="_blank" rel="noopener noreferrer">
        {Inner}
      </a>
    );
  }
  return <Link href={paper.href}>{Inner}</Link>;
}

function StatusBadge({ status }: { status: Paper["status"] }) {
  const label =
    status === "draft"
      ? "Draft"
      : status === "in-review"
      ? "In review"
      : "Published";
  const color =
    status === "published"
      ? "var(--color-accent-pay)"
      : "var(--color-text-muted)";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

function Contribute() {
  return (
    <Section className="border-t border-[var(--color-border)]">
      <div className="grid gap-10 md:grid-cols-2 md:items-center">
        <div>
          <SectionHeading>Independent review welcome.</SectionHeading>
          <p className="mt-3 text-[var(--color-text-muted)]">
            All design documents and technical notes live in the public
            repository. Open an issue or pull request if you spot an error or
            want to extend the analysis.
          </p>
        </div>
        <div className="flex flex-wrap gap-3 md:justify-end">
          <a
            href="https://github.com/tokamak-network/scatter-dex/tree/main/docs"
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClassName({ size: "lg" })}
          >
            Browse all docs
            <ArrowRight className="h-4 w-4" />
          </a>
          <a
            href="https://github.com/tokamak-network/scatter-dex/issues"
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClassName({ variant: "secondary", size: "lg" })}
          >
            Open an issue
          </a>
        </div>
      </div>
    </Section>
  );
}
