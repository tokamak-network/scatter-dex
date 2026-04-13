/**
 * EdDSAKeyService — 모바일용 EdDSA 키 관리
 *
 * WalletConnect signer로 서명 → keccak256 → BabyJub private key 유도.
 * ZKBridgeService를 통해 WebView에서 EdDSA 연산 수행.
 * expo-secure-store에 암호화 저장.
 *
 * 웹 프론트엔드의 eddsa.ts와 동일한 유도 로직이지만,
 * circomlibjs는 WebView에서만 실행 가능하므로 Bridge를 통해 호출한다.
 */
import { ethers } from 'ethers';
import * as SecureStore from 'expo-secure-store';
import { ZKBridgeService } from './ZKBridgeService';

const DERIVE_MESSAGE =
  'Sign to generate your zkScatter trading key.\n\nThis key is used to sign orders privately.\nIt does not grant access to your funds.';

const EDDSA_KEY_PREFIX = 'scatterdex_eddsa_';

export interface EdDSAKeyPair {
  /**
   * Raw hex string WITHOUT a `0x` prefix — that's what the WebView bridge
   * (`derive_eddsa_key`) returns and what `sign_eddsa` accepts. The earlier
   * "0x-prefixed" comment was wrong; aligning the contract here so callers
   * stop hand-trimming or hand-prefixing it.
   */
  privateKeyHex: string;
  pubKeyAx: string;               // decimal string (for circuit inputs)
  pubKeyAy: string;               // decimal string
}

export const EdDSAKeyService = {
  /**
   * EdDSA 키 유도: signer.signMessage → keccak256 → BabyJub prv2pub
   *
   * WalletConnect를 통해 지갑 앱에서 서명을 받고,
   * ZKBridgeService.deriveEdDSAKey()로 WebView에서 BabyJub 키를 유도한다.
   */
  async deriveKey(signer: ethers.Signer): Promise<{ keyPair: EdDSAKeyPair; signature: string }> {
    // 1. WalletConnect 지갑 앱에서 서명 요청 (딥링크 전환)
    const signature = await signer.signMessage(DERIVE_MESSAGE);

    // 2. keccak256 → private key
    const signatureHash = ethers.keccak256(signature);

    // 3. WebView에서 BabyJub prv2pub 수행
    const result = await ZKBridgeService.deriveEdDSAKey(signatureHash);

    return {
      keyPair: {
        privateKeyHex: result.privateKeyHex,
        pubKeyAx: result.pubKeyAx,
        pubKeyAy: result.pubKeyAy,
      },
      signature,
    };
  },

  /**
   * 저장된 키가 있으면 로드, 없으면 null. 저장된 JSON이 손상된 경우
   * (앱 종료 도중 partial write, manual SecureStore wipe, schema drift 등)
   * 해당 항목을 삭제하고 null을 반환 — `getOrDeriveKey`가 다시 유도하도록.
   * 그냥 throw하면 매 trade마다 사용자에게 unrecoverable 에러를 보임.
   *
   * UX note: a corrupted entry will silently be removed here; the next
   * `getOrDeriveKey` call therefore triggers a fresh `signMessage` prompt
   * in the user's wallet. Callers that want to surface that beforehand
   * (e.g. "Your signing key was reset, approve to re-derive") should
   * check for `null` from this method first.
   */
  async loadKey(account: string): Promise<EdDSAKeyPair | null> {
    const key = `${EDDSA_KEY_PREFIX}${account.toLowerCase()}`;
    const stored = await SecureStore.getItemAsync(key);
    if (!stored) return null;
    try {
      const parsed = JSON.parse(stored);
      // Shape check — bridge returns three string fields. A blob missing
      // any of them is corrupt and re-derivation is the right move.
      if (
        typeof parsed?.privateKeyHex === 'string'
        && typeof parsed?.pubKeyAx === 'string'
        && typeof parsed?.pubKeyAy === 'string'
      ) {
        return parsed as EdDSAKeyPair;
      }
      throw new Error('EdDSA key blob missing required fields');
    } catch (err) {
      console.warn('EdDSAKeyService.loadKey: dropping corrupted entry', err);
      try { await SecureStore.deleteItemAsync(key); } catch { /* best-effort */ }
      return null;
    }
  },

  /**
   * 키를 expo-secure-store에 저장
   */
  async saveKey(account: string, keyPair: EdDSAKeyPair): Promise<void> {
    const key = `${EDDSA_KEY_PREFIX}${account.toLowerCase()}`;
    await SecureStore.setItemAsync(key, JSON.stringify(keyPair));
  },

  /**
   * 키 유도 또는 캐시 로드
   * 이미 저장된 키가 있으면 재사용, 없으면 signer로 유도 후 저장
   */
  async getOrDeriveKey(
    signer: ethers.Signer,
    account: string,
  ): Promise<EdDSAKeyPair> {
    const cached = await this.loadKey(account);
    if (cached) return cached;

    const { keyPair } = await this.deriveKey(signer);
    await this.saveKey(account, keyPair);
    return keyPair;
  },

  /**
   * 저장된 키 삭제
   */
  async deleteKey(account: string): Promise<void> {
    const key = `${EDDSA_KEY_PREFIX}${account.toLowerCase()}`;
    await SecureStore.deleteItemAsync(key);
  },
};
