import Constants from 'expo-constants';

function getEnv(key: string): string {
  const val = (Constants.expoConfig?.extra as any)?.[key]
    || process.env[key]
    || '';
  return val;
}

let _rpcOverride: string | null = null;
let _chainIdOverride: number | null = null;

export const ConfigService = {
  getRpcUrl: () => _rpcOverride ?? (getEnv('RPC_URL') || 'https://rpc.thanos-sepolia.tokamak.network'),
  getChainId: () => _chainIdOverride ?? Number(getEnv('CHAIN_ID') || '111551119090'),
  getCommitmentPoolAddress: () => getEnv('COMMITMENT_POOL_ADDRESS'),
  getPrivateSettlementAddress: () => getEnv('PRIVATE_SETTLEMENT_ADDRESS'),
  getRelayerRegistryAddress: () => getEnv('RELAYER_REGISTRY_ADDRESS'),
  getWethAddress: () => getEnv('WETH_ADDRESS'),
  getFeeVaultAddress: () => getEnv('FEE_VAULT_ADDRESS'),
  getRelayerUrl: () => getEnv('RELAYER_URL') || 'http://localhost:4000',
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
