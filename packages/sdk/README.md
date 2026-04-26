# @scatterdex/sdk

Typed TypeScript client for the ScatterDEX core: contracts + ZK
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
  `explorerLink(network, hash)`

No live network calls, no proof generation, no wallet hooks yet.
Those modules ship in subsequent phases (see
`docs/product/SHARED_FOUNDATION.md` for the full plan).

## Install (in-repo)

The package is referenced by sibling packages via `file:` paths or
TypeScript path mapping. There is no published npm version yet.

```jsonc
// apps/<name>/package.json
"dependencies": {
  "@scatterdex/sdk": "file:../../packages/sdk"
}
```

Or, for zero-build dev usage in Next.js apps, point tsconfig paths
at the source and add to `transpilePackages` in `next.config.ts`:

```jsonc
// apps/<name>/tsconfig.json
"paths": {
  "@scatterdex/sdk": ["../../packages/sdk/src/index.ts"]
}
```

```ts
// apps/<name>/next.config.ts
const nextConfig: NextConfig = {
  transpilePackages: ["@scatterdex/sdk"],
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
} from "@scatterdex/sdk";

const tokens: TokenInfo[] = parseTokenList(
  "0xabc…:USDC:6,0xdef…:USDT:6",
);

const name = chainName(11155111); // "Sepolia"
```

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
4. **Tree-shakeable.** Subpath exports (`@scatterdex/sdk/core`) so
   bundlers don't ship the proving module to apps that don't use it.

## Roadmap

| Phase | Module | Notes |
| --- | --- | --- |
| 0 (this PR) | `core/` types, ABIs, helpers | done |
| 1 | `core/provider.ts` + wallet | useWallet hook in a `react/` subpath |
| 2 | `zk/deposit.ts` + `prover` adapter | Web Worker on web, WebView on RN |
| 3 | `zk/authorize.ts` + EdDSA signing | order signing + proof |
| 4 | `zk/claim.ts` + `stealth.ts` | withdraw + stealth derivation |
| 5 | `orderbook/` + `relayer/` | shared orderbook + relayer registry |
| 6 | `notes/` storage adapters | filesystem (web) / sqlite (mobile) |
| 7 | `identity/zkX509.ts` | KYC integration |

## Developer docs

Future `apps/docs/` (Nextra) will host the public SDK reference —
auto-generated from TSDoc + curated guides.
See `docs/product/DEVELOPER_DOCS_SITE.md` for that plan.
