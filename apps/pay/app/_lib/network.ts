import { KNOWN_EXPLORER_BASES, LAUNCH_TOKENS, type NetworkConfig } from "@zkscatter/sdk";

// Pay's network config. Uses NEXT_PUBLIC_* envs at build time so
// Pay never reads chain state from process.env at runtime — this
// keeps the SDK's "network is passive" contract intact.
//
// In dev with `./scripts/dev.sh --mock`, all addresses come from the
// printed deploy output. Set them via `.env.local`:
//
//   NEXT_PUBLIC_PAY_RPC_URL=http://127.0.0.1:8545
//   NEXT_PUBLIC_PAY_CHAIN_ID=31337
//   NEXT_PUBLIC_PAY_PRIVATE_SETTLEMENT=0x...
//   NEXT_PUBLIC_PAY_COMMITMENT_POOL=0x...
//   NEXT_PUBLIC_PAY_IDENTITY_GATE=0x...
//   NEXT_PUBLIC_PAY_RELAYER_REGISTRY=0x...
//   NEXT_PUBLIC_PAY_WETH=0x...
//   NEXT_PUBLIC_PAY_RELAYER_URL=http://127.0.0.1:7000

const ZERO = "0x0000000000000000000000000000000000000000";

function pick(value: string | undefined, fallback = ""): string {
  return value && value.length > 0 ? value : fallback;
}

// Parse an integer env (chainId, deployBlock) and fall back when it
// isn't a non-negative integer. A bare `Number(pick(...))` lets a typo
// like `"11155111abc"` become `NaN` and silently propagate into the
// NetworkConfig — breaking the `KNOWN_EXPLORER_BASES[chainId]` lookup
// and any other chainId-keyed logic. Mirrors `pickInt` in Pro's config.
function pickInt(value: string | undefined, fallback: number): number {
  if (!value || value.length === 0) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

// Each `process.env.NEXT_PUBLIC_*` access has to be a *literal* key
// for Next to inline the value into the client bundle — a dynamic
// lookup like `process.env[name]` is not statically analysable, so
// it survives only on the server and the browser sees `undefined`
// (which then silently falls through to the dev defaults). Reading
// each key explicitly here keeps the chain pill rendered on the
// server and the wrong-chain banner rendered on the client agreeing
// on the same chain.
export function getNetworkConfig(): NetworkConfig {
  // Overlay env-provided contract addresses onto the LAUNCH_TOKENS
  // metadata so non-native lookups resolve to the deployed contract
  // (LAUNCH_TOKENS' address field is a ZERO sentinel).
  const overlay: Record<string, string> = {
    USDC: pick(process.env.NEXT_PUBLIC_PAY_USDC, ZERO),
    USDT: pick(process.env.NEXT_PUBLIC_PAY_USDT, ZERO),
    TON: pick(process.env.NEXT_PUBLIC_PAY_TON, ZERO),
  };
  const tokens = Object.values(LAUNCH_TOKENS).map((t) => {
    const addr = overlay[t.symbol];
    return addr && addr !== ZERO ? { ...t, address: addr } : t;
  });
  const chainId = pickInt(process.env.NEXT_PUBLIC_PAY_CHAIN_ID, 31337);
  return {
    chainId,
    rpcUrl: pick(process.env.NEXT_PUBLIC_PAY_RPC_URL, "http://127.0.0.1:8545"),
    // Env override wins; otherwise fall back to the chain's known
    // explorer (Sepolia → sepolia.etherscan.io, mainnet → etherscan.io,
    // …) so every tx/address link works without an env per deploy.
    // Unknown chains (e.g. localhost 31337) stay undefined → plain text.
    explorerBase:
      pick(process.env.NEXT_PUBLIC_PAY_EXPLORER_BASE) ||
      KNOWN_EXPLORER_BASES[chainId] ||
      undefined,
    contracts: {
      privateSettlement: pick(process.env.NEXT_PUBLIC_PAY_PRIVATE_SETTLEMENT, ZERO),
      commitmentPool: pick(process.env.NEXT_PUBLIC_PAY_COMMITMENT_POOL, ZERO),
      identityGate: pick(process.env.NEXT_PUBLIC_PAY_IDENTITY_GATE, ZERO),
      relayerRegistry: pick(process.env.NEXT_PUBLIC_PAY_RELAYER_REGISTRY, ZERO),
      weth: pick(process.env.NEXT_PUBLIC_PAY_WETH, ZERO),
    },
    tokens,
    relayer: process.env.NEXT_PUBLIC_PAY_RELAYER_URL
      ? { url: process.env.NEXT_PUBLIC_PAY_RELAYER_URL }
      : undefined,
    deployBlock: pickInt(process.env.NEXT_PUBLIC_PAY_DEPLOY_BLOCK, 0),
    // Shared orderbook base URL — when set, the commitment tree hydrates from
    // its /api/commitments indexer first, falling back to getLogs.
    sharedOrderbookUrl: pick(process.env.NEXT_PUBLIC_SHARED_ORDERBOOK_URL) || undefined,
  };
}

/** Whether the current network config has its core contracts wired up.
 *  Phase B will use this to gate write actions (deposit / settle) until
 *  the env is fully populated. */
export function isNetworkConfigured(cfg: NetworkConfig): boolean {
  return (
    cfg.contracts.privateSettlement !== ZERO &&
    cfg.contracts.commitmentPool !== ZERO &&
    cfg.contracts.relayerRegistry !== ZERO
  );
}

