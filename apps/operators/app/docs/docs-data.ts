// Static metadata for the in-app docs viewer. Kept free of any
// node:fs / build-time imports so client components can safely import
// the types and the DOCS index without pulling Node built-ins into
// the client bundle. Markdown loading lives in `docs-loader.ts`
// (server-only).

export type DocSlug =
  | "operations-guide"
  | "registering-a-relayer"
  | "local-setup"
  | "deployment"
  | "relayer-security"
  | "mev-protection"
  | "fee-architecture"
  | "gas-cost-analysis";

export type DocCategory = "Run" | "Deploy" | "Reference";

// Explicit display order for the sidebar — decoupled from the
// `DOCS` array's iteration order so reordering docs within a
// category doesn't reshuffle the sidebar groupings.
export const CATEGORY_ORDER: readonly DocCategory[] = [
  "Run",
  "Deploy",
  "Reference",
];

export interface DocMeta {
  slug: DocSlug;
  title: string;
  blurb: string;
  category: DocCategory;
}

// Curated, in order. `operator-gap-analysis.md` is intentionally
// excluded — it's an internal planning artefact, not operator-facing.
export const DOCS: DocMeta[] = [
  {
    slug: "operations-guide",
    title: "Operations Guide",
    blurb: "Day-to-day monitoring, admin actions, troubleshooting.",
    category: "Run",
  },
  {
    slug: "registering-a-relayer",
    title: "Registering a Relayer",
    blurb: "9-step end-to-end flow: KYC → zk-X509 cert → bond → leaderboard.",
    category: "Run",
  },
  {
    slug: "local-setup",
    title: "Local Setup",
    blurb: "Run the full stack on your machine for development.",
    category: "Run",
  },
  {
    slug: "deployment",
    title: "Deployment",
    blurb: "Production install — service, reverse proxy, health checks.",
    category: "Deploy",
  },
  {
    slug: "relayer-security",
    title: "Security Hardening",
    blurb: "Admin auth, key custody, network exposure, audit log.",
    category: "Deploy",
  },
  {
    slug: "mev-protection",
    title: "MEV Protection",
    blurb: "Why private mempools matter and how settlement is shielded.",
    category: "Reference",
  },
  {
    slug: "fee-architecture",
    title: "Fee Architecture",
    blurb: "Fee policy, rebates, and how earnings flow to operators.",
    category: "Reference",
  },
  {
    slug: "gas-cost-analysis",
    title: "Gas Cost Analysis",
    blurb: "Per-action gas baselines so you can size your float.",
    category: "Reference",
  },
];

export interface DocContent {
  meta: DocMeta;
  html: string;
}
