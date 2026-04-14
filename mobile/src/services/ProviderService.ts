/**
 * ProviderService — 읽기 전용 ethers JsonRpcProvider 싱글톤
 */
import { ethers } from 'ethers';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ConfigService } from './ConfigService';

let readProvider: ethers.JsonRpcProvider | null = null;
// Three-state cache: `undefined` = never fetched, `null` = pool
// doesn't implement sanctionsList() (older deployments), string =
// real address. A two-state `string | null` couldn't distinguish
// "not fetched" from "fetched and absent", causing repeat RPCs.
let cachedSanctionsAddr: string | null | undefined = undefined;
const resetListeners = new Set<() => void>();

export const ProviderService = {
  getReadProvider(): ethers.JsonRpcProvider {
    if (!readProvider) {
      readProvider = new ethers.JsonRpcProvider(ConfigService.getRpcUrl());
    }
    return readProvider;
  },

  async getEarliestBlock(): Promise<number> {
    const cached = await AsyncStorage.getItem('scatterdex_earliest_block');
    if (cached) return Number(cached);
    return ConfigService.getDeployBlock();
  },

  async cacheEarliestBlock(block: number): Promise<void> {
    await AsyncStorage.setItem('scatterdex_earliest_block', String(block));
  },

  /** Cached sanctions list address from CommitmentPool — avoids RPC on every deposit.
   *  Returns null gracefully if pool doesn't support sanctionsList() (older deployments). */
  async getSanctionsListAddress(): Promise<string | null> {
    if (cachedSanctionsAddr !== undefined) return cachedSanctionsAddr;

    const poolAddr = ConfigService.getCommitmentPoolAddress();
    if (!poolAddr) return null;

    try {
      const { COMMITMENT_POOL_ABI } = await import('../lib/contracts');
      const pool = new ethers.Contract(poolAddr, COMMITMENT_POOL_ABI, this.getReadProvider());
      const addr: string = await pool.sanctionsList();
      cachedSanctionsAddr = addr;
      return addr;
    } catch {
      // Pool doesn't implement sanctionsList() — cache null so later
      // callers short-circuit without a repeat RPC attempt.
      cachedSanctionsAddr = null;
      return null;
    }
  },

  reset() {
    readProvider = null;
    cachedSanctionsAddr = undefined;
    resetListeners.forEach((fn) => {
      try { fn(); } catch (err) {
        console.warn('ProviderService reset listener failed:', err);
      }
    });
  },

  /** Subscribe to provider resets (e.g. network switch). Returns unsubscribe. */
  subscribeReset(fn: () => void): () => void {
    resetListeners.add(fn);
    return () => { resetListeners.delete(fn); };
  },
};
