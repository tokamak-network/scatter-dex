/**
 * KeySecurityService — 하드웨어 기반 키 보안
 *
 * 레이어 1: 앱 잠금 (생체인증 / PIN)
 * 레이어 2: Keychain(iOS) / Keystore(Android) 암호화 저장
 * 레이어 3: 트랜잭션 서명 시 생체인증 재확인
 *
 * 키 저장 구조:
 *   expo-secure-store (하드웨어 백 암호화)
 *     └─ WALLET_KEY → 프라이빗 키 (암호화)
 *     └─ MNEMONIC_KEY → 시드 구문 (암호화)
 *     └─ ADDRESS_KEY → 지갑 주소 (생체인증 없이 접근)
 */
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import { ethers } from 'ethers';

const WALLET_KEY = 'scatterdex_wallet_pk';
const MNEMONIC_KEY = 'scatterdex_wallet_mnemonic';
const ADDRESS_KEY = 'scatterdex_wallet_address';
const AUTH_ENABLED_KEY = 'scatterdex_biometric_enabled';

export const KeySecurityService = {
  // ─── 생체인증 ──────────────────────────────────────

  async isBiometricAvailable(): Promise<boolean> {
    const compatible = await LocalAuthentication.hasHardwareAsync();
    if (!compatible) return false;
    return LocalAuthentication.isEnrolledAsync();
  },

  async authenticate(reason: string = 'Authenticate to access your wallet'): Promise<boolean> {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      fallbackLabel: 'Use passcode',
      disableDeviceFallback: false,
    });
    return result.success;
  },

  async isBiometricEnabled(): Promise<boolean> {
    const val = await SecureStore.getItemAsync(AUTH_ENABLED_KEY);
    return val === 'true';
  },

  async setBiometricEnabled(enabled: boolean): Promise<void> {
    await SecureStore.setItemAsync(AUTH_ENABLED_KEY, enabled ? 'true' : 'false');
  },

  // ─── 지갑 생성/복구 ────────────────────────────────

  async createWallet(): Promise<{ mnemonic: string; address: string }> {
    const hdWallet = ethers.Wallet.createRandom();
    const mnemonic = hdWallet.mnemonic!.phrase;

    await this._saveWallet(hdWallet.privateKey, hdWallet.address, mnemonic);
    return { mnemonic, address: hdWallet.address };
  },

  async importFromMnemonic(mnemonic: string): Promise<string> {
    const hdWallet = ethers.Wallet.fromPhrase(mnemonic.trim());
    await this._saveWallet(hdWallet.privateKey, hdWallet.address, mnemonic.trim());
    return hdWallet.address;
  },

  async importFromPrivateKey(privateKey: string): Promise<string> {
    const pk = privateKey.trim().startsWith('0x') ? privateKey.trim() : `0x${privateKey.trim()}`;
    const wallet = new ethers.Wallet(pk);
    // No mnemonic for raw key imports
    await this._saveWallet(pk, wallet.address, null);
    return wallet.address;
  },

  /** Internal: save wallet data to Keychain/Keystore */
  async _saveWallet(privateKey: string, address: string, mnemonic: string | null): Promise<void> {
    await SecureStore.setItemAsync(WALLET_KEY, privateKey, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    await SecureStore.setItemAsync(ADDRESS_KEY, address);
    if (mnemonic) {
      await SecureStore.setItemAsync(MNEMONIC_KEY, mnemonic, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
    }
  },

  // ─── 키 접근 (생체인증 게이팅) ──────────────────────

  async hasWallet(): Promise<boolean> {
    const addr = await SecureStore.getItemAsync(ADDRESS_KEY);
    return !!addr;
  },

  /** 지갑 주소 — 생체인증 불필요 (주소는 공개 정보) */
  async getAddress(): Promise<string | null> {
    return SecureStore.getItemAsync(ADDRESS_KEY);
  },

  /** 프라이빗 키 — 생체인증 필요 */
  async getPrivateKey(): Promise<string | null> {
    const biometricEnabled = await this.isBiometricEnabled();
    if (biometricEnabled) {
      const ok = await this.authenticate('Authenticate to access your private key');
      if (!ok) return null;
    }
    return SecureStore.getItemAsync(WALLET_KEY);
  },

  /** ethers.Wallet Signer 생성 — 생체인증 필요 */
  async getSigner(provider: ethers.JsonRpcProvider): Promise<ethers.Wallet | null> {
    const pk = await this.getPrivateKey();
    if (!pk) return null;
    return new ethers.Wallet(pk, provider);
  },

  /** 시드 구문 조회 — 항상 생체인증 필요 */
  async getMnemonic(): Promise<string | null> {
    const hasMnemonic = await SecureStore.getItemAsync(MNEMONIC_KEY);
    if (!hasMnemonic) return null;

    const ok = await this.authenticate('Authenticate to view recovery phrase');
    if (!ok) return null;
    return SecureStore.getItemAsync(MNEMONIC_KEY);
  },

  // ─── 트랜잭션 서명 게이팅 ──────────────────────────

  /** 트랜잭션 서명 전 생체인증 (biometric 토글이 켜진 경우만) */
  async authorizeTransaction(description: string): Promise<boolean> {
    const biometricEnabled = await this.isBiometricEnabled();
    if (!biometricEnabled) return true; // 토글 OFF → 자동 승인
    return this.authenticate(`Approve: ${description}`);
  },

  // ─── 지갑 삭제 ────────────────────────────────────

  async deleteWallet(): Promise<void> {
    await SecureStore.deleteItemAsync(WALLET_KEY);
    await SecureStore.deleteItemAsync(MNEMONIC_KEY);
    await SecureStore.deleteItemAsync(ADDRESS_KEY);
  },
};
