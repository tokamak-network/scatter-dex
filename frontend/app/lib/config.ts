// Runtime config for both server and client environments.
// Server: reads from process.env (set by Docker entrypoint).
// Client: Next.js inlines NEXT_PUBLIC_* at build time via the ENV_MAP below.
//         window.__ENV__ is reserved for future Docker runtime injection but
//         is not currently used — build-time inlining handles all client config.

declare global {
  interface Window {
    __ENV__?: Record<string, string>;
  }
}

// Next.js inlines process.env.NEXT_PUBLIC_* only when accessed as a literal.
// Dynamic access like process.env[key] does NOT work on the client.
// This map bridges the gap for client-side usage.
const ENV_MAP: Record<string, string | undefined> = {
  NEXT_PUBLIC_SETTLEMENT_ADDRESS: process.env.NEXT_PUBLIC_SETTLEMENT_ADDRESS,
  NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS: process.env.NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS,
  NEXT_PUBLIC_VAULTSKILLS_ADDRESS: process.env.NEXT_PUBLIC_VAULTSKILLS_ADDRESS,
  NEXT_PUBLIC_WETH_ADDRESS: process.env.NEXT_PUBLIC_WETH_ADDRESS,
  NEXT_PUBLIC_RPC_URL: process.env.NEXT_PUBLIC_RPC_URL,
  NEXT_PUBLIC_CHAIN_ID: process.env.NEXT_PUBLIC_CHAIN_ID,
  NEXT_PUBLIC_RELAYER_URL: process.env.NEXT_PUBLIC_RELAYER_URL,
  NEXT_PUBLIC_TOKENS: process.env.NEXT_PUBLIC_TOKENS,
  NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS: process.env.NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS,
  NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS: process.env.NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS,
};

export function getEnv(key: string): string | undefined {
  if (typeof window !== "undefined" && window.__ENV__ && key in window.__ENV__) {
    return window.__ENV__[key];
  }
  return ENV_MAP[key];
}

function requireEnv(key: string): string {
  const value = getEnv(key);
  if (!value) {
    throw new Error(`${key} is not set`);
  }
  return value;
}

// Lazy getters — evaluated at runtime (first access), not at import/build time.
// This avoids crashes during SSG when env vars are absent.

let _settlement: string | undefined;
export function getSettlementAddress(): string {
  if (!_settlement) _settlement = requireEnv("NEXT_PUBLIC_SETTLEMENT_ADDRESS");
  return _settlement;
}

let _registry: string | undefined;
export function getRelayerRegistryAddress(): string {
  if (!_registry) _registry = requireEnv("NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS");
  return _registry;
}

let _vaultSkills: string | undefined;
export function getVaultSkillsAddress(): string {
  if (!_vaultSkills) _vaultSkills = requireEnv("NEXT_PUBLIC_VAULTSKILLS_ADDRESS");
  return _vaultSkills;
}

let _weth: string | undefined;
export function getWethAddress(): string {
  if (!_weth) _weth = requireEnv("NEXT_PUBLIC_WETH_ADDRESS");
  return _weth;
}

let _commitmentPool: string | undefined;
export function getCommitmentPoolAddress(): string {
  if (!_commitmentPool) _commitmentPool = requireEnv("NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS");
  return _commitmentPool;
}

let _privateSettlement: string | undefined;
export function getPrivateSettlementAddress(): string {
  if (!_privateSettlement) _privateSettlement = requireEnv("NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS");
  return _privateSettlement;
}

export const RPC_URL = getEnv("NEXT_PUBLIC_RPC_URL") || "http://localhost:8545";
export const EXPECTED_CHAIN_ID = Number(getEnv("NEXT_PUBLIC_CHAIN_ID") || "31337");

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  5: "Goerli",
  11155111: "Sepolia",
  17000: "Holesky",
  31337: "Localhost",
  137: "Polygon",
  42161: "Arbitrum",
  10: "Optimism",
};

export function getChainName(chainId: number): string {
  return CHAIN_NAMES[chainId] || `Chain ${chainId}`;
}
