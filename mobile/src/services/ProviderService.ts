/**
 * ProviderService — 읽기 전용 ethers JsonRpcProvider 싱글톤
 */
import { ethers } from 'ethers';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ConfigService } from './ConfigService';

let readProvider: ethers.JsonRpcProvider | null = null;
// Cache the *promise* rather than the resolved value so N concurrent
// first-callers share a single RPC — otherwise the first batch of
// deposits on a fresh session fires as many `sanctionsList()` probes
// as there are inflight deposits. The resolved value is
// `string | null`: `null` means the pool doesn't implement
// sanctionsList() (older deployment); we only cache the rejection on
// decode-shaped errors so transient RPC failures stay retryable.
let sanctionsPromise: Promise<string | null> | null = null;
const resetListeners = new Set<() => void>();

/** Errors that indicate the pool lacks `sanctionsList()` — safe to
 *  cache the negative result. Anything else is likely transient and
 *  should clear the promise so the next caller retries. */
function isMethodMissingError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  const msg = String((err as { message?: string })?.message ?? '');
  return (
    code === 'BAD_DATA'
    || code === 'CALL_EXCEPTION'
    || /could not decode result data/i.test(msg)
  );
}

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
    if (sanctionsPromise) return sanctionsPromise;

    const poolAddr = ConfigService.getCommitmentPoolAddress();
    if (!poolAddr) return null;

    sanctionsPromise = (async () => {
      try {
        const { COMMITMENT_POOL_ABI } = await import('../lib/contracts');
        const pool = new ethers.Contract(poolAddr, COMMITMENT_POOL_ABI, this.getReadProvider());
        return await pool.sanctionsList() as string;
      } catch (err) {
        // Only cache the negative result when the pool genuinely
        // doesn't implement sanctionsList(). Transient RPC failures
        // clear the promise so the next call retries — otherwise a
        // flaky network would permanently disable sanctions checks
        // for the session.
        if (!isMethodMissingError(err)) {
          sanctionsPromise = null;
          throw err;
        }
        return null;
      }
    })();
    // Swallow the rejection in the cached-promise path so later
    // awaiters don't all see the same rejected promise; the original
    // caller still gets the throw via the returned promise below.
    sanctionsPromise.catch(() => { /* handled above */ });
    return sanctionsPromise;
  },

  reset() {
    readProvider = null;
    sanctionsPromise = null;
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
