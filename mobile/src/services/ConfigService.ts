import Constants from 'expo-constants';

function getEnv(key: string): string {
  const val = (Constants.expoConfig?.extra as any)?.[key]
    || process.env[key]
    || '';
  return val;
}

interface ChainContracts {
  weth?: string;
  commitmentPool?: string;
  privateSettlement?: string;
  relayerRegistry?: string;
  feeVault?: string;
  relayerUrl?: string;
  // Extra ERC-20 tokens surfaced alongside the auto-generated ETH/WETH
  // pair in the Escrow/Trade token picker. Keyed per-chain because
  // testnet USDC on anvil (31337) is a completely different address
  // than USDC on Thanos Sepolia.
  tokens?: Array<{ address: string; symbol: string; decimals: number }>;
}

// Per-chain contract overrides. Loaded from `src/config/fork-contracts.json`
// which `scripts/dev.sh` / `scripts/dev-fork.sh` regenerate after each
// deploy — that way the mobile client sees the same addresses the
// frontend does without having to inject environment variables into the
// Expo build.
//
// The file is optional: when it is missing (a plain `expo start` with no
// local fork running), the map is empty and callers fall back to the env
// getters below, which match the pre-multi-chain behaviour.
let CHAIN_CONTRACTS: Record<number, ChainContracts> = {};
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require('../config/fork-contracts.json') as Record<string, ChainContracts>;
  // JSON keys are strings; normalise to numeric chain ids.
  CHAIN_CONTRACTS = Object.fromEntries(
    Object.entries(loaded).map(([k, v]) => [Number(k), v]),
  );
} catch {
  // File missing or unparseable — no overrides, fall back to env.
}

let _rpcOverride: string | null = null;
let _chainIdOverride: number | null = null;

function chainContracts(): ChainContracts {
  const id = _chainIdOverride ?? Number(getEnv('CHAIN_ID') || '111551119090');
  return CHAIN_CONTRACTS[id] ?? {};
}

export const ConfigService = {
  getRpcUrl: () => _rpcOverride ?? (getEnv('RPC_URL') || 'https://rpc.thanos-sepolia.tokamak.network'),
  getChainId: () => _chainIdOverride ?? Number(getEnv('CHAIN_ID') || '111551119090'),
  getCommitmentPoolAddress: () => chainContracts().commitmentPool || getEnv('COMMITMENT_POOL_ADDRESS'),
  getPrivateSettlementAddress: () => chainContracts().privateSettlement || getEnv('PRIVATE_SETTLEMENT_ADDRESS'),
  getRelayerRegistryAddress: () => chainContracts().relayerRegistry || getEnv('RELAYER_REGISTRY_ADDRESS'),
  getWethAddress: () => chainContracts().weth || getEnv('WETH_ADDRESS'),
  getFeeVaultAddress: () => chainContracts().feeVault || getEnv('FEE_VAULT_ADDRESS'),
  getRelayerUrl: () => chainContracts().relayerUrl || getEnv('RELAYER_URL') || 'http://localhost:4000',
  /** Extra ERC-20 tokens registered for the active chain (beyond the
   *  auto-generated ETH / WETH pair). Returns an empty array when the
   *  current network has no contracts block. */
  getExtraTokens: (): Array<{ address: string; symbol: string; decimals: number }> =>
    chainContracts().tokens ?? [],
  // Commitment-pool deploy block. Callers that scan full commitment
  // history (Cancel, MarketOrder, useRecentActivity) must use this as
  // the lower bound. We validate here rather than at each call site:
  // if `DEPLOY_BLOCK` is set to a non-numeric value, `Number(...)`
  // returns NaN, and an `|| 0` fallback at the caller would silently
  // scan from genesis — that's expensive *and* hides the misconfig.
  // An unset env resolves to `'0'` which is a legitimate value.
  getDeployBlock: (): number => {
    const raw = getEnv('DEPLOY_BLOCK') || '0';
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(
        `Invalid DEPLOY_BLOCK configuration: ${JSON.stringify(raw)} — must be a non-negative integer`,
      );
    }
    return n;
  },
  getWalletConnectProjectId: () => getEnv('WALLETCONNECT_PROJECT_ID') || '',
  getUniswapRouterAddress: () => getEnv('UNISWAP_ROUTER_ADDRESS') || '',
  getBuyTokenSymbol: () => getEnv('BUY_TOKEN_SYMBOL') || 'WETH',
  // Optional: URL of a deployed web instance whose /api/swap endpoint
  // proxies 1inch with a server-side API key. Leave empty to skip
  // 1inch and use Uniswap V3 direct only.
  getWebApiBaseUrl: () => getEnv('WEB_API_BASE_URL') || '',

  applyNetworkOverride(rpcUrl: string, chainId: number) {
    _rpcOverride = rpcUrl;
    _chainIdOverride = chainId;
  },
};
