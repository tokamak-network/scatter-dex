/**
 * Shared circuit file loader with global cache.
 * Circuit files are immutable at runtime so we cache base64 after first read.
 * Uses in-flight promise dedup to prevent concurrent duplicate loads.
 */
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import { Asset } from 'expo-asset';

const cache = new Map<number, string>();
const inflight = new Map<number, Promise<string>>();

export async function loadCircuitFileB64(assetModule: number): Promise<string> {
  const cached = cache.get(assetModule);
  if (cached) return cached;

  const existing = inflight.get(assetModule);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const asset = Asset.fromModule(assetModule);
      await asset.downloadAsync();
      if (!asset.localUri) throw new Error('Failed to download circuit asset');
      const b64 = await readAsStringAsync(asset.localUri, {
        encoding: EncodingType.Base64,
      });
      cache.set(assetModule, b64);
      return b64;
    } finally {
      // `finally` so a transient failure (download/read) clears the
      // entry — without this, every later call returns the rejected
      // promise and the asset can never be retried in the session.
      inflight.delete(assetModule);
    }
  })();

  inflight.set(assetModule, promise);
  return promise;
}
