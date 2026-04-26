# @zkscatter/sdk

Typed TypeScript client for the zkScatter core: contracts + ZK
proofs + relayer network + shared orderbook.

Used by every persona-specific frontend (`apps/pro`, `apps/pay`,
`apps/drop`, `mobile`). The goal is **one place** for contract calls,
proof generation glue, and core types — so a deposit bug fix lands in
all four surfaces at once.

## Status

**Phase 0 (current)**: foundation only. The SDK exposes:

- **Types**: `NetworkConfig`, `ContractAddresses`, `TokenInfo`
- **Constants**: ABI strings + pre-parsed `Interface` objects for
  every core contract
- **Helpers**: `chainName(id)`, `parseTokenList(raw)`,
  `explorerLink(network, entity, value)` where `entity` is
  `"tx" | "address" | "block"`

No live network calls, no proof generation, no wallet hooks yet.
Those modules ship in subsequent phases (see
`docs/product/SHARED_FOUNDATION.md` for the full plan).

## Install (in-repo)

The package is referenced by sibling packages via `file:` paths or
TypeScript path mapping. There is no published npm version yet.

```jsonc
// apps/<name>/package.json
"dependencies": {
  "@zkscatter/sdk": "file:../../packages/sdk"
}
```

Or, for zero-build dev usage in Next.js apps, point tsconfig paths
at the source and add to `transpilePackages` in `next.config.ts`:

```jsonc
// apps/<name>/tsconfig.json
"paths": {
  "@zkscatter/sdk": ["../../packages/sdk/src/index.ts"]
}
```

```ts
// apps/<name>/next.config.ts
const nextConfig: NextConfig = {
  transpilePackages: ["@zkscatter/sdk"],
};
```

## Usage (Phase 0 surface)

```ts
import {
  PRIVATE_SETTLEMENT_ABI,
  PRIVATE_SETTLEMENT_IFACE,
  COMMITMENT_POOL_ABI,
  ERC20_ABI,
  chainName,
  parseTokenList,
  type NetworkConfig,
  type TokenInfo,
} from "@zkscatter/sdk";

const tokens: TokenInfo[] = parseTokenList(
  "0xabc…:USDC:6,0xdef…:USDT:6",
);

const name = chainName(11155111); // "Sepolia"
```

## Distribution

Phase 0 ships as **TypeScript source only**: `package.json` points
`main` / `types` / `exports` at `./src/index.ts`. This is intentional
for in-repo use:

- Apps in `apps/*` consume the SDK via tsconfig path mapping +
  Next.js `transpilePackages` — zero build step, instant type
  refresh on save.
- The SDK is `private: true` and not on npm yet.

Before the first npm publish (or any consumer that does not
transpile dependencies), we will add a `tsc` build that emits to
`./dist/` and switch the `exports` field to a dual condition
(`import` / `require`) with a `types` entry — matching the pattern
already used by `packages/types`. Tracked alongside the Phase 1
SDK work.

## Layout

```
packages/sdk/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── core/
    │   ├── network.ts     # NetworkConfig, ContractAddresses, chain name lookup
    │   ├── contracts.ts   # ABIs + ethers.Interface for every core contract
    │   ├── tokens.ts      # TokenInfo + parseTokenList
    │   └── index.ts
    └── index.ts
```

## Design rules

1. **No host coupling.** SDK never reads `process.env`, `window`, or
   localStorage. Caller passes config explicitly. This is what lets
   the same code run in Next.js, React Native (WebView), and Node.
2. **Typed first, runtime small.** Prefer narrow types and pure
   functions; defer side-effecty bits (proving, RPC) to adapters.
3. **Versioned ABIs.** When contracts upgrade, SDK gets a new minor
   version; apps adopt at their own pace.
4. **Tree-shakeable.** Subpath exports (`@zkscatter/sdk/core`) so
   bundlers don't ship the proving module to apps that don't use it.

## Roadmap

| Phase | Module | Notes |
| --- | --- | --- |
| 0 | `core/` types, ABIs, helpers | done |
| 1 | `core/provider.ts` + wallet | done — `useWallet` in `./react` |
| 2a | `zk/` Prover interface + WebWorker / Mock impls | done |
| 2b | `zk/deposit.ts` + circuit worker | next |
| 3 | `zk/authorize.ts` + EdDSA signing | order signing + proof |
| 4 | `zk/claim.ts` + `stealth.ts` | withdraw + stealth derivation |
| 5 | `orderbook/` + `relayer/` | shared orderbook + relayer registry |
| 6 | `notes/` storage adapters | filesystem (web) / sqlite (mobile) |
| 7 | `identity/zkX509.ts` | KYC integration |

## Developer docs

Future `apps/docs/` (Nextra) will host the public SDK reference —
auto-generated from TSDoc + curated guides.
See `docs/product/DEVELOPER_DOCS_SITE.md` for that plan.
