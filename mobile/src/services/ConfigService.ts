/**
 * ConfigService — 환경변수 및 네트워크 설정
 */
import Constants from 'expo-constants';

function getEnv(key: string): string {
  const val = (Constants.expoConfig?.extra as any)?.[key]
    || process.env[key]
    || '';
  return val;
}

export const ConfigService = {
  getRpcUrl: () => getEnv('RPC_URL') || 'https://rpc.thanos-sepolia.tokamak.network',
  getChainId: () => Number(getEnv('CHAIN_ID') || '111551119090'),
  getCommitmentPoolAddress: () => getEnv('COMMITMENT_POOL_ADDRESS'),
  getPrivateSettlementAddress: () => getEnv('PRIVATE_SETTLEMENT_ADDRESS'),
  getRelayerRegistryAddress: () => getEnv('RELAYER_REGISTRY_ADDRESS'),
  getWethAddress: () => getEnv('WETH_ADDRESS'),
  getFeeVaultAddress: () => getEnv('FEE_VAULT_ADDRESS'),
  getRelayerUrl: () => getEnv('RELAYER_URL') || 'http://localhost:4000',
  getDeployBlock: () => Number(getEnv('DEPLOY_BLOCK') || '0'),
  getWalletConnectProjectId: () => getEnv('WALLETCONNECT_PROJECT_ID') || '',
};
