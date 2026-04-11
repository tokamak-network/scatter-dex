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
  privateKeyHex: string;          // 0x-prefixed hex
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
   * 저장된 키가 있으면 로드, 없으면 null
   */
  async loadKey(account: string): Promise<EdDSAKeyPair | null> {
    const key = `${EDDSA_KEY_PREFIX}${account.toLowerCase().slice(-8)}`;
    const stored = await SecureStore.getItemAsync(key);
    if (!stored) return null;
    return JSON.parse(stored);
  },

  /**
   * 키를 expo-secure-store에 저장
   */
  async saveKey(account: string, keyPair: EdDSAKeyPair): Promise<void> {
    const key = `${EDDSA_KEY_PREFIX}${account.toLowerCase().slice(-8)}`;
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
    const key = `${EDDSA_KEY_PREFIX}${account.toLowerCase().slice(-8)}`;
    await SecureStore.deleteItemAsync(key);
  },
};
