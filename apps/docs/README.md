# @zkscatter/docs

Self-hosted developer docs site — Nextra (Next.js) build of
`developers/`. We replaced the Mintlify pipeline with this so the
private repo can serve docs without a paid Mintlify plan.

## Run locally

```bash
cd apps/docs
npm install
npm run dev          # http://localhost:4100
```

Hot-reloads on every `developers/*.mdx` save.

## How it works

- `apps/docs/content/` is a symlink to `developers/`. The `.mdx` files
  in `developers/` remain the canonical source — same files Mintlify
  would have read.
- `apps/docs/components/mintlify.tsx` shims the Mintlify-flavoured
  components (`<Card>`, `<CardGroup>`, `<Steps>`, `<Step>`,
  `<Accordion>`, `<AccordionGroup>`, `<Note>`, `<Check>`,
  `<CodeGroup>`, `<Frame>`) so existing pages render unchanged.
- `mdx-components.tsx` registers the shims with Nextra's MDX provider.
- `developers/**/_meta.tsx` files define the sidebar order — Mintlify
  ignores them, so they don't conflict if we ever re-enable Mintlify.

## Build for production

```bash
npm run build
npm start            # serves the prebuilt site on :4100
```

For static hosting (Cloudflare Pages, S3, GitHub Pages) the site
needs `output: "export"` in `next.config.ts`. We currently ship the
default Node target so dynamic features (search, routing) work in
the development workflow.

## Why not Mintlify

Mintlify's GitHub App needs the Pro plan to build private repos.
Until the docs source goes public (or we upgrade), this Nextra build
is the supported path. The `developers/docs.json` file is left in
place as a fallback config in case Mintlify is re-enabled.
