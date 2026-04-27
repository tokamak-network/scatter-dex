# developers/

Public developer documentation for zkScatter — hosted by
[Mintlify](https://mintlify.com), served at `docs.zkscatter.xyz`.

> Internal contributor docs (architecture, design, research) live in
> the repo-root `docs/` directory. This folder is the **public**
> surface that ships to developers integrating the SDK.

## Layout

```
developers/
├── docs.json            Mintlify configuration (nav, theme, colors)
├── introduction.mdx     Landing page
├── quickstart.mdx       5-minute first-order walkthrough
├── guides/              Task-oriented walkthroughs
├── sdk/                 @zkscatter/sdk reference (TypeDoc-generated, planned)
├── contracts/           Solidity reference
├── circuits/            Circom reference + trusted-setup notes
├── operate/             Relayer node operator guide
└── snippets/            Reusable MDX fragments
```

## Local preview

```bash
npm install -g mint
cd developers
mint dev   # http://localhost:3000
```

## Deploy

Connected to Mintlify via the GitHub app — pushes to `main` deploy
automatically. Custom domain `docs.zkscatter.xyz` is configured in
the Mintlify dashboard.

## Authoring rules

- **Imperative voice**: "Install the SDK", not "You can install".
- **Every code block runs**: paste-and-go, including imports.
- **Errors get a section**: every guide ends with "Common errors".
- **Version when stable**: once the SDK is published to npm, pin
  `@zkscatter/sdk@X.Y.Z` in examples that depend on a specific surface.
  Pre-publish, leave examples unpinned and rely on the Phase note at
  the top of each page.
- **No "simply", "just", "easy"**: condescending when something fails.
