# apps/hub

Brand home for **zkScatter** — the umbrella site that introduces the
ZK + compliance stack and routes visitors to the right persona app
(`pro`, `pay`, `mobile`) and the developer docs.

This app is not a product surface. No trading, no proofs, no wallet.
Its job is positioning, navigation, and trust.

## Run

```bash
cd apps/hub
npm install
npm run dev   # http://localhost:3000
```

## Pages (Phase 0 scaffold)

| Path        | Purpose |
| ----------- | ------- |
| `/`         | Landing — Hero, Why, Apps router, How it works, Developers teaser |
| `/apps`     | Catalog — 4 app cards, comparison table, recommender |

Subsequent phases add `/technology`, `/developers`, `/research`, `/about`.

## Stack

- Next.js 16 (App Router) + React 19
- Tailwind 4
- `@zkscatter/ui` design tokens (hub theme)
- `@zkscatter/sdk` types (no live network calls)
