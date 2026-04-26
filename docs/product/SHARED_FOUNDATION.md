# Shared Foundation — `packages/sdk` and `packages/ui`

The three frontends (`frontend/`, `apps/pay/`, `apps/drop/`) and
`mobile/` will all depend on shared TypeScript packages. Without
these, every app duplicates contract calls, ZK glue, and design
tokens.

This is the prerequisite work before app-specific features can ship
quickly.

## Goal

After extraction:

- Adding a new frontend = `pnpm create next-app` + import
  `@scatterdex/sdk` + theme `@scatterdex/ui` → first wired screen in
  a day.
- Bug in deposit flow gets fixed once, lands in all four surfaces.
- Designers can ship a token change (e.g. brand color) by editing
  one file.

## `packages/sdk` — what it wraps

Today the same logic exists twice (once in `frontend/app/lib/zk/*`
and once in `mobile/src/services/*`). Extract the union into one
React-agnostic SDK.

### Modules

```
packages/sdk/
├── core/
│   ├── network.ts           # config + RPC + contract addresses per chain
│   ├── contracts.ts         # ABIs + typed contract clients
│   └── relayer.ts           # relayer registry + fetching + auth
├── zk/
│   ├── deposit.ts           # build commitment, generate proof
│   ├── authorize.ts         # order signing + Groth16 proof
│   ├── claim.ts             # withdraw / multi-recipient / stealth
│   ├── stealth.ts           # ephemeral address derivation
│   └── prover.ts            # snarkjs wrapper (web Worker / RN WebView)
├── orderbook/
│   ├── shared.ts            # shared orderbook client
│   └── matcher.ts           # local match preview
├── notes/
│   ├── storage.ts           # storage adapter interface
│   └── adapters/
│       ├── filesystem.ts    # web — File System Access API
│       ├── sqlite.ts        # mobile — expo-sqlite
│       └── memory.ts        # tests
├── identity/
│   └── zkX509.ts            # KYC integration
└── index.ts                 # public entry
```

### API shape (sketch)

```ts
import { ScatterSDK } from "@scatterdex/sdk";

const sdk = ScatterSDK.create({
  network: "thanos-sepolia",
  storage: ScatterSDK.adapters.filesystem(),
  prover: ScatterSDK.prover.webWorker(),
});

await sdk.deposit({ token, amount });
const order = await sdk.authorize.create({ side, price, size, recipients });
const claims = await sdk.claim.byOrderId(orderId);
```

Storage and prover are pluggable — that's the only part the host
environment varies on.

### What goes into core vs apps

- **Core (SDK)**: contract calls, proof gen, note management,
  relayer fetch, stealth math
- **App**: routes, copy, layout, persona-specific composition

## `packages/ui` — what it provides

### Tokens

Per-brand theme files, one file per app:

```
packages/ui/
├── tokens/
│   ├── pro.css        # dark, blue/cyan
│   ├── pay.css        # light, blue
│   └── drop.css       # light, purple
├── components/
│   ├── Button.tsx
│   ├── Input.tsx
│   ├── Modal.tsx
│   ├── Stepper.tsx
│   ├── EmptyState.tsx
│   ├── StatCard.tsx
│   └── ConnectWalletButton.tsx
└── index.ts
```

Components consume CSS variables, not hardcoded colors. Theme switch
= swap one CSS import.

### What does NOT belong in `packages/ui`

- Page layouts (those are app-specific composition)
- Charts / visualizations (per-app for now; can promote if 2+ apps
  use the same one)
- Branded marketing components (hero sections, pricing tables)

## Migration order

1. **Create `packages/sdk` skeleton** with module structure + empty
   exports. (1 day)
2. **Move `frontend/app/lib/zk/*`** into `packages/sdk/zk` and update
   `frontend/` imports. Frontend still works. (3 days)
3. **Move `mobile/src/services/{Deposit,Order,Claim,ZKBridge}*`**
   into the same SDK with platform adapters. Mobile uses the same
   SDK for everything except prover (WebView adapter) and storage
   (sqlite adapter). (1 week)
4. **Create `packages/ui`** with three theme files + 6 primitive
   components. Update `frontend/` to use `Button`, `Input`,
   `Modal`. (3 days)
5. **`apps/pay/` and `apps/drop/`** import both packages from day 1.

Total: ~3 weeks, 1 engineer, no user-visible changes during the
extraction.

## Workspace setup

When ready to wire workspaces (option B from the original split
discussion):

```yaml
# pnpm-workspace.yaml
packages:
  - "frontend"
  - "apps/*"
  - "mobile"
  - "packages/*"
  - "zk-relayer"
  - "shared-orderbook"
```

Until then, each app installs its own copy of deps. That's fine for
the scaffold phase.

## Risks

- **Bundle size on web**: SDK pulls in snarkjs / circomlibjs. Use
  ESM + tree-shaking, lazy-load the prover module behind dynamic
  import.
- **Mobile WebView ↔ native interface**: keep the prover adapter
  surface tiny (one `prove(circuitId, input)` function) so the
  WebView bridge is trivial.
- **Contract version skew**: SDK pins ABI versions per network. When
  contracts upgrade, SDK gets a new minor version; apps update at
  their own pace.
