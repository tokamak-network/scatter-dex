# Developer Docs Site (planned)

Public-facing docs site for engineers consuming `@scatterdex/sdk`.

## Why a separate site

`docs/product/` is internal: strategy, personas, specs. Useful to
the team, but not what an external dev wants to read. SDK consumers
need:

- Quickstart — install, connect, first deposit, first order in 5
  minutes
- API reference — every exported type, function, hook (auto-generated
  from TSDoc)
- Concept guides — what's a commitment, how stealth claims work,
  why Dual-CA matters for compliance
- Recipes — "build a custom relayer dashboard", "add ScatterPay to
  my Safe", "verify a payout audit signature"
- Migration guides — when SDK ships a breaking version

These belong on a versioned, indexed, search-friendly site — not
a bullet list in a README.

## Tooling recommendation: Nextra

Same Next.js stack as the rest of `apps/`, MDX content authoring,
strong defaults for docs sites (built-in search, sidebar nav,
versioned releases, dark mode toggle). Used by Turbo, SWR, Reflect.

Alternatives considered:
- **Docusaurus** — battle-tested but React + extra build chain;
  duplicates infra we already have for Next.
- **VitePress** — beautiful but Vue-based; team is a React shop.
- **Mintlify** — hosted SaaS; nice but adds vendor and monthly cost
  before we've validated traffic.

Pick Nextra unless we hit a hard limitation.

## Location

`apps/docs/` — fourth Next.js app, port 3004 in dev,
`docs.scatterdex.xyz` in production.

## Phased build

| Phase | Adds | Trigger |
| --- | --- | --- |
| 0.5 | Nextra scaffold + sidebar + landing | After SDK Phase 0 lands |
| 1 | Quickstart + Concepts pages | After SDK Phase 1 (wallet hook) |
| 2 | Auto-generated API reference | TypeDoc → MDX, hooked into CI |
| 3 | Recipes + community guides | After first 5 external integrations |
| 4 | Versioned docs (per SDK release) | Once SDK has 2+ minor versions |

Each phase tracks the SDK roadmap in
`packages/sdk/README.md`. Docs ship at the same time as the module
they describe — never write docs for unreleased modules.

## Content sources

- **API reference**: TypeDoc on `packages/sdk` → JSON → MDX
  generator → `apps/docs/pages/api/*.mdx`. Re-run on PR merge so
  the live site never drifts.
- **Quickstart / concepts**: hand-written MDX in `apps/docs/pages/`.
- **Recipes**: hand-written, may be community-contributed via PR.

## Search

Algolia DocSearch (free for open-source docs). Fallback: built-in
Nextra search (FlexSearch). Apply for DocSearch once the site has
enough content (~20 pages).

## Authoring rules

1. Every public SDK export gets a TSDoc block. CI fails if a new
   export ships without one.
2. Code samples are real, runnable. Test them in CI via a
   compile-only pass (no chain calls, just type check).
3. Versioned per SDK release; current docs always reflect `latest`.
4. No marketing copy — that lives on `apps/pro|pay|drop`. This site
   is for people who already decided to build on us.

## Open questions

- Hosted on Vercel? (Cheapest path; Next-native.)
- One repo or split out? Recommend one repo until SDK stabilizes —
  docs PRs land alongside the SDK changes they describe.
- License for content (CC BY 4.0?). Decide before publication.
