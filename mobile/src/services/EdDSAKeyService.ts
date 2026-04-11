/**
 * EdDSAKeyService — 모바일용 EdDSA 키 관리
 */
import { ethers } from 'ethers';
import * as SecureStore from 'expo-secure-store';
import { ZKBridgeService } from './ZKBridgeService';

const DERIVE_MESSAGE = 'Sign to generate your zkScatter trading key.\n\nThis key is used to sign orders privately.\nIt does not grant access to your funds.';
const EDDSA_KEY_PREFIX = 'scatterdex_eddsa_';

export interface EdDSAKeyPair {
  privateKeyHex: string;
  pubKeyAx: string;
  pubKeyAy: string;
}

export const EdDSAKeyService = {
  async deriveKey(signer: ethers.Signer): Promise<{ keyPair: EdDSAKeyPair; signature: string }> {
    const signature = await signer.signMessage(DERIVE_MESSAGE);
    const signatureHash = ethers.keccak256(signature);
    const result = await ZKBridgeService.deriveEdDSAKey(signatureHash);
    return { keyPair: { privateKeyHex: result.privateKeyHex, pubKeyAx: result.pubKeyAx, pubKeyAy: result.pubKeyAy }, signature };
  },

  async loadKey(account: string): Promise<EdDSAKeyPair | null> {
    const stored = await SecureStore.getItemAsync(`${EDDSA_KEY_PREFIX}${account.toLowerCase()}`);
    return stored ? JSON.parse(stored) : null;
  },

  async saveKey(account: string, keyPair: EdDSAKeyPair): Promise<void> {
    await SecureStore.setItemAsync(`${EDDSA_KEY_PREFIX}${account.toLowerCase()}`, JSON.stringify(keyPair));
  },

  async getOrDeriveKey(signer: ethers.Signer, account: string): Promise<EdDSAKeyPair> {
    const cached = await this.loadKey(account);
    if (cached) return cached;
    const { keyPair } = await this.deriveKey(signer);
    await this.saveKey(account, keyPair);
    return keyPair;
  },
};
