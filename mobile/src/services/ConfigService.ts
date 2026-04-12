/**
 * ConfigService — 환경변수 및 네트워크 설정
 *
 * NetworkService에서 선택된 네트워크가 있으면 해당 RPC/ChainId 사용.
 * 없으면 환경변수 → 기본값 순으로 fallback.
 */
import Constants from 'expo-constants';

function getEnv(key: string): string {
  const val = (Constants.expoConfig?.extra as any)?.[key]
    || process.env[key]
    || '';
  return val;
}

// Runtime overrides from NetworkService.selectNetwork()
let _rpcOverride: string | null = null;
let _chainIdOverride: number | null = null;

export const ConfigService = {
  getRpcUrl: () => _rpcOverride || getEnv('RPC_URL') || 'https://rpc.thanos-sepolia.tokamak.network',
  getChainId: () => _chainIdOverride || Number(getEnv('CHAIN_ID') || '111551119090'),
  getCommitmentPoolAddress: () => getEnv('COMMITMENT_POOL_ADDRESS'),
  getPrivateSettlementAddress: () => getEnv('PRIVATE_SETTLEMENT_ADDRESS'),
  getRelayerRegistryAddress: () => getEnv('RELAYER_REGISTRY_ADDRESS'),
  getWethAddress: () => getEnv('WETH_ADDRESS'),
  getFeeVaultAddress: () => getEnv('FEE_VAULT_ADDRESS'),
  getRelayerUrl: () => getEnv('RELAYER_URL') || 'http://localhost:4000',
  getDeployBlock: () => Number(getEnv('DEPLOY_BLOCK') || '0'),
  getWalletConnectProjectId: () => getEnv('WALLETCONNECT_PROJECT_ID') || '',
  getUniswapRouterAddress: () => getEnv('UNISWAP_ROUTER_ADDRESS') || '',

  /** Called by NetworkService when user switches network */
  applyNetworkOverride(rpcUrl: string, chainId: number) {
    _rpcOverride = rpcUrl;
    _chainIdOverride = chainId;
  },

  clearNetworkOverride() {
    _rpcOverride = null;
    _chainIdOverride = null;
  },
};
