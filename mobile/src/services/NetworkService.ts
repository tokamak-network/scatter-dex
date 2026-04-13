/**
 * NetworkService — 네트워크 관리
 *
 * 프리셋 네트워크 + 커스텀 네트워크 + 로컬 노드 지원.
 * 선택된 네트워크는 AsyncStorage에 저장되어 앱 재시작 시 유지.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ConfigService } from './ConfigService';
import { ProviderService } from './ProviderService';

const NETWORKS_KEY = 'scatterdex_custom_networks';
const SELECTED_KEY = 'scatterdex_selected_network';

export interface NetworkConfig {
  id: string;
  name: string;
  rpcUrl: string;
  chainId: number;
  symbol: string;        // native token symbol (ETH, TON, etc.)
  blockExplorer?: string;
  isCustom: boolean;
}

// Built-in networks
export const PRESET_NETWORKS: NetworkConfig[] = [
  {
    id: 'thanos-sepolia',
    name: 'Thanos Sepolia',
    rpcUrl: 'https://rpc.thanos-sepolia.tokamak.network',
    chainId: 111551119090,
    symbol: 'TON',
    blockExplorer: 'https://explorer.thanos-sepolia.tokamak.network',
    isCustom: false,
  },
  {
    id: 'thanos-mainnet',
    name: 'Thanos Mainnet',
    rpcUrl: 'https://rpc.titan.tokamak.network',
    chainId: 55004,
    symbol: 'TON',
    blockExplorer: 'https://explorer.titan.tokamak.network',
    isCustom: false,
  },
  {
    id: 'ethereum',
    name: 'Ethereum Mainnet',
    rpcUrl: 'https://eth.llamarpc.com',
    chainId: 1,
    symbol: 'ETH',
    blockExplorer: 'https://etherscan.io',
    isCustom: false,
  },
  {
    id: 'sepolia',
    name: 'Sepolia Testnet',
    rpcUrl: 'https://rpc.sepolia.org',
    chainId: 11155111,
    symbol: 'ETH',
    blockExplorer: 'https://sepolia.etherscan.io',
    isCustom: false,
  },
  {
    id: 'localhost',
    name: 'Local Node (Hardhat/Anvil)',
    rpcUrl: 'http://10.0.2.2:8545', // Android emulator → host machine
    chainId: 31337,
    symbol: 'ETH',
    isCustom: false,
  },
];

export const NetworkService = {
  /** 모든 네트워크 (프리셋 + 커스텀) */
  async getAllNetworks(): Promise<NetworkConfig[]> {
    const custom = await this.getCustomNetworks();
    return [...PRESET_NETWORKS, ...custom];
  },

  /** 커스텀 네트워크 목록 */
  async getCustomNetworks(): Promise<NetworkConfig[]> {
    const raw = await AsyncStorage.getItem(NETWORKS_KEY);
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  },

  /** 커스텀 네트워크 추가 */
  async addCustomNetwork(network: Omit<NetworkConfig, 'id' | 'isCustom'>): Promise<NetworkConfig> {
    const custom = await this.getCustomNetworks();
    const config: NetworkConfig = {
      ...network,
      id: `custom-${Date.now()}`,
      isCustom: true,
    };
    custom.push(config);
    await AsyncStorage.setItem(NETWORKS_KEY, JSON.stringify(custom));
    return config;
  },

  /** 커스텀 네트워크 삭제 */
  async removeCustomNetwork(id: string): Promise<void> {
    const custom = await this.getCustomNetworks();
    const filtered = custom.filter((n) => n.id !== id);
    await AsyncStorage.setItem(NETWORKS_KEY, JSON.stringify(filtered));
  },

  /** 현재 선택된 네트워크 ID */
  async getSelectedNetworkId(): Promise<string> {
    const id = await AsyncStorage.getItem(SELECTED_KEY);
    return id || 'thanos-sepolia'; // default
  },

  async selectNetwork(id: string): Promise<void> {
    await AsyncStorage.setItem(SELECTED_KEY, id);
    const network = await this.getSelectedNetwork();
    ConfigService.applyNetworkOverride(network.rpcUrl, network.chainId);
    ProviderService.reset();
  },

  async restoreSavedNetwork(): Promise<void> {
    const network = await this.getSelectedNetwork();
    ConfigService.applyNetworkOverride(network.rpcUrl, network.chainId);
    ProviderService.reset();
  },

  async getSelectedNetwork(): Promise<NetworkConfig> {
    const id = await this.getSelectedNetworkId();
    const all = await this.getAllNetworks();
    return all.find((n) => n.id === id) || PRESET_NETWORKS[0];
  },

  /** RPC 연결 테스트 */
  async testConnection(rpcUrl: string): Promise<{ ok: boolean; chainId?: number; blockNumber?: number; error?: string }> {
    try {
      const chainId = await rpcCall(rpcUrl, 'eth_chainId', 1);
      const blockNumber = await rpcCall(rpcUrl, 'eth_blockNumber', 2);
      return { ok: true, chainId, blockNumber };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' };
    }
  },
};

async function rpcCall(rpcUrl: string, method: string, id: number): Promise<number> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params: [], id }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from RPC`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || `RPC error from ${method}`);
  if (typeof data.result !== 'string' || !data.result.startsWith('0x')) {
    throw new Error(`Invalid RPC result for ${method}`);
  }
  const n = parseInt(data.result, 16);
  if (!Number.isFinite(n)) throw new Error(`Unparseable RPC result for ${method}`);
  return n;
}
