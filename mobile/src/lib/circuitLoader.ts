/**
 * Shared circuit file loader with global cache.
 * Circuit files are immutable at runtime so we cache base64 after first read.
 */
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import { Asset } from 'expo-asset';

const cache = new Map<number, string>();

export async function loadCircuitFileB64(assetModule: number): Promise<string> {
  const cached = cache.get(assetModule);
  if (cached) return cached;

  const asset = Asset.fromModule(assetModule);
  await asset.downloadAsync();
  if (!asset.localUri) throw new Error('Failed to download circuit asset');
  const b64 = await readAsStringAsync(asset.localUri, {
    encoding: EncodingType.Base64,
  });
  cache.set(assetModule, b64);
  return b64;
}
