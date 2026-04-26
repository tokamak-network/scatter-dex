# Shared Foundation — `packages/sdk` and `packages/ui`

The three production apps (`apps/pro/`, `apps/pay/`, `apps/drop/`)
and `mobile/` all depend on shared TypeScript packages. Without
these, every app duplicates contract calls, ZK glue, and design
tokens.

`frontend/` is the **reference implementation** whose real logic
(workers, storage, merkle tree, on-chain dispatch) is being
migrated into `@zkscatter/sdk` so the apps can consume it. Once
`apps/pro` reaches parity, `frontend/` is archived.

This is the prerequisite work before app-specific features can ship
quickly.

## Goal

After extraction:

- Adding a new frontend = `pnpm create next-app` + import
  `@zkscatter/sdk` + theme `@zkscatter/ui` → first wired screen in
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
import { ScatterSDK } from "@zkscatter/sdk";

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

### Prover backends

The `Prover` interface in `@zkscatter/sdk/zk` lets us slot in a
different proving engine per environment without touching the
calling code (modal, vault, settlement flow). New backends just
ship a new `create*Prover()` factory.

| Backend | Engine | Target | Status |
| --- | --- | --- | --- |
| `createWebWorkerProver` | snarkjs (Web Worker) | `apps/pro`, `pay`, `drop` (web) | active (Phase 2a) — real circuit assets ship as part of the `frontend/` → SDK worker migration |
| `createMockProver` | deterministic dummy | dev, tests, storybooks; unblocks UI when circuit assets aren't ready | active (Phase 2a) |
| `createNativeProver` | mopro (Rust ↔ React Native FFI) | apps mobile companion | planned (Phase 4–6) |
| `createWasmProver` | mopro compiled to WASM | web speed-up, optional | exploratory |

**Why a Rust prover for mobile.** snarkjs running in a WebView is
30–60 s per proof on phone-class hardware — unacceptable UX for a
sign-and-go flow. mopro's arkworks-rs path is 5–10× faster.
`mobile/native-prover/` already builds the iOS `xcframework` +
Android `.so` via mopro's CLI; the Phase 4–6 mobile track will
plug those bindings into the SDK as `createNativeProver` so
`apps/pro`'s flow code (and eventually `apps/pay`, `apps/drop`)
runs unchanged on mobile.

**Why not WASM-everywhere now.** A mopro→WASM build for web is
attractive (5–10× over snarkjs) but has trade-offs: bundle size,
SharedArrayBuffer requirement (COOP/COEP headers), and a second
asset pipeline alongside snarkjs. Defer until web users complain
about the 30 s snarkjs path or until mobile native-prover is
shipping and the WASM target is essentially free.

## `packages/ui` — what it provides

### Tokens

Per-brand theme files, one file per app. All three default to the
light, fintech-trustworthy palette per `BRAND_DIRECTION.md`; the
sub-brand difference is accent color, not chrome.

```
packages/ui/
├── src/
│   ├── tokens/
│   │   ├── pro.css    # light, blue primary  (trader-focused)
│   │   ├── pay.css    # light, teal primary  (payouts / B2B)
│   │   └── drop.css   # light, purple accent (campaigns)
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

1. ✅ **Create `packages/sdk` skeleton** with module structure +
   public exports (Phases 0–4 done — types, ABIs, wallet, ZK
   prover interface, EdDSA, stealth, contract helpers, relayer
   client, shared orderbook client).
2. **Move `frontend/app/lib/zk/*` into `packages/sdk/src/zk/`** —
   real Web Worker provers (deposit / authorize / claim / cancel),
   worker-client + serde split, prove-timer, secure-wipe,
   zkey-cache. `apps/pro` swaps its mock prover for the real one
   in the same PR; `frontend/` swaps its imports next. (1 PR)
3. **Move note storage** — `frontend/app/lib/zk/note-storage.ts` →
   `packages/sdk/src/notes/` with adapter interface + IndexedDB
   adapter (web) + memory adapter (tests). `apps/pro` replaces its
   in-memory vault. (1 PR)
4. **Move incremental Merkle tree** — `frontend/app/lib/zk/incremental-tree.ts`
   → `packages/sdk/src/zk/merkle/` with chain-sync helper. (1 PR)
5. **Move `mobile/src/services/{Deposit,Order,Claim,ZKBridge}*`**
   into the same SDK with platform adapters (WebView prover,
   AsyncStorage / SQLite note adapter). (1 PR)
6. **Create `packages/ui`** with three theme files + primitive
   components. (1 PR)
7. **`apps/pay/` and `apps/drop/`** import both packages from
   day 1.

Each migration step keeps `frontend/` running by leaving its
imports until the new SDK module is verified in apps/pro, then
swapping. No user-visible regression at any step.

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
