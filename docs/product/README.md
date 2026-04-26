# Product docs

Strategic & implementation docs for the persona-specific frontends
that share the zkScatter core (contracts + ZK + relayer + shared
orderbook).

## Contents

- [`BRAND_DIRECTION.md`](./BRAND_DIRECTION.md) — visual and verbal
  direction shared across all frontends. Light theme by default,
  fintech-trustworthy aesthetic, regulator-friendly tone.
- [`MULTI_FRONTEND_STRATEGY.md`](./MULTI_FRONTEND_STRATEGY.md) — three
  target audiences, three frontends. Why split, naming, brand
  architecture, rollout order.
- [`PERSONAS.md`](./PERSONAS.md) — concrete persona sheets (semi-pro
  trader, finance ops, token launcher) with channels, pains, pricing
  willingness.
- [`SCATTERPAY_SPEC.md`](./SCATTERPAY_SPEC.md) — `apps/pay/` spec:
  screens, flows, data model, MVP scope, pricing, GTM.
- [`SCATTERDROP_SPEC.md`](./SCATTERDROP_SPEC.md) — `apps/drop/` spec:
  screens, sybil policy, embeddable widget, GTM.
- [`PRO_REPOSITION.md`](./PRO_REPOSITION.md) — how to refocus the
  current `frontend/` for semi-pro traders (workbench consolidation,
  `/app` route, vs-Uniswap comparison metric).
- [`SHARED_FOUNDATION.md`](./SHARED_FOUNDATION.md) — `packages/sdk` and
  `packages/ui` extraction plan that all three apps depend on.
- [`DEVELOPER_DOCS_SITE.md`](./DEVELOPER_DOCS_SITE.md) — `apps/docs/`
  plan: Nextra-based public reference for SDK consumers.
- [`inventory/FRONTEND_FEATURES.md`](./inventory/FRONTEND_FEATURES.md) —
  raw feature inventory of `frontend/` (web).
- [`inventory/MOBILE_FEATURES.md`](./inventory/MOBILE_FEATURES.md) —
  raw feature inventory of `mobile/`.

## Audience

These docs are for the dev team building the new frontends. They
encode product intent so engineers don't have to re-derive scope from
chat history. Brand/marketing copy lives in each app's own
`README.md` and (future) `apps/<name>/marketing/`.
