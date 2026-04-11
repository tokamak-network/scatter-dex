/**
 * KeySecurityService — Trust Wallet 수준 키 보안
 *
 * 레이어 1: 앱 잠금 (생체인증 / PIN)
 * 레이어 2: Keychain(iOS) / Keystore(Android) 암호화 저장
 * 레이어 3: 트랜잭션 서명 시 생체인증 재확인
 *
 * 키 저장 구조:
 *   expo-secure-store (하드웨어 백 암호화)
 *     └─ 'scatterdex_wallet' → 암호화된 프라이빗 키
 *     └─ 'scatterdex_mnemonic' → 암호화된 시드 구문
 */
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import { ethers } from 'ethers';

const WALLET_KEY = 'scatterdex_wallet_pk';
const MNEMONIC_KEY = 'scatterdex_wallet_mnemonic';
const AUTH_ENABLED_KEY = 'scatterdex_biometric_enabled';

export interface WalletInfo {
  address: string;
  privateKey: string;
}

export const KeySecurityService = {
  // ─── 생체인증 ──────────────────────────────────────

  /** 기기에서 생체인증을 지원하는지 확인 */
  async isBiometricAvailable(): Promise<boolean> {
    const compatible = await LocalAuthentication.hasHardwareAsync();
    if (!compatible) return false;
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    return enrolled;
  },

  /** 생체인증 요청 — Face ID / 지문 / PIN */
  async authenticate(reason: string = 'Authenticate to access your wallet'): Promise<boolean> {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      fallbackLabel: 'Use passcode',
      disableDeviceFallback: false,
    });
    return result.success;
  },

  /** 생체인증 활성화 여부 */
  async isBiometricEnabled(): Promise<boolean> {
    const val = await SecureStore.getItemAsync(AUTH_ENABLED_KEY);
    return val === 'true';
  },

  /** 생체인증 활성화/비활성화 */
  async setBiometricEnabled(enabled: boolean): Promise<void> {
    await SecureStore.setItemAsync(AUTH_ENABLED_KEY, enabled ? 'true' : 'false');
  },

  // ─── 지갑 생성/복구 ────────────────────────────────

  /** 새 지갑 생성 — 시드 구문 + 프라이빗 키 생성 후 Keychain 저장 */
  async createWallet(): Promise<{ mnemonic: string; wallet: WalletInfo }> {
    const hdWallet = ethers.Wallet.createRandom();
    const mnemonic = hdWallet.mnemonic!.phrase;
    const privateKey = hdWallet.privateKey;
    const address = hdWallet.address;

    // Keychain/Keystore에 암호화 저장
    await SecureStore.setItemAsync(WALLET_KEY, privateKey, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    await SecureStore.setItemAsync(MNEMONIC_KEY, mnemonic, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });

    return { mnemonic, wallet: { address, privateKey } };
  },

  /** 시드 구문으로 지갑 복구 */
  async importFromMnemonic(mnemonic: string): Promise<WalletInfo> {
    const hdWallet = ethers.Wallet.fromPhrase(mnemonic.trim());
    const privateKey = hdWallet.privateKey;
    const address = hdWallet.address;

    await SecureStore.setItemAsync(WALLET_KEY, privateKey, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    await SecureStore.setItemAsync(MNEMONIC_KEY, mnemonic.trim(), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });

    return { address, privateKey };
  },

  /** 프라이빗 키로 지갑 가져오기 (개발/테스트용) */
  async importFromPrivateKey(privateKey: string): Promise<WalletInfo> {
    const wallet = new ethers.Wallet(privateKey);
    const address = wallet.address;

    await SecureStore.setItemAsync(WALLET_KEY, privateKey, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });

    return { address, privateKey };
  },

  // ─── 키 접근 (생체인증 게이팅) ──────────────────────

  /** 저장된 지갑 존재 여부 */
  async hasWallet(): Promise<boolean> {
    const pk = await SecureStore.getItemAsync(WALLET_KEY);
    return !!pk;
  },

  /** 프라이빗 키 로드 — 생체인증 필요 */
  async getPrivateKey(): Promise<string | null> {
    const biometricEnabled = await this.isBiometricEnabled();
    if (biometricEnabled) {
      const ok = await this.authenticate('Authenticate to access your private key');
      if (!ok) return null;
    }
    return SecureStore.getItemAsync(WALLET_KEY);
  },

  /** ethers.Wallet 인스턴스 생성 — 생체인증 필요 */
  async getSigner(provider: ethers.JsonRpcProvider): Promise<ethers.Wallet | null> {
    const pk = await this.getPrivateKey();
    if (!pk) return null;
    return new ethers.Wallet(pk, provider);
  },

  /** 지갑 주소만 로드 (생체인증 불필요) */
  async getAddress(): Promise<string | null> {
    const pk = await SecureStore.getItemAsync(WALLET_KEY);
    if (!pk) return null;
    try {
      const wallet = new ethers.Wallet(pk);
      return wallet.address;
    } catch {
      return null;
    }
  },

  /** 시드 구문 조회 — 반드시 생체인증 */
  async getMnemonic(): Promise<string | null> {
    const ok = await this.authenticate('Authenticate to view recovery phrase');
    if (!ok) return null;
    return SecureStore.getItemAsync(MNEMONIC_KEY);
  },

  // ─── 트랜잭션 서명 게이팅 ──────────────────────────

  /** 트랜잭션 서명 전 생체인증 확인 */
  async authorizeTransaction(description: string): Promise<boolean> {
    return this.authenticate(`Approve: ${description}`);
  },

  // ─── 지갑 삭제 ────────────────────────────────────

  /** 지갑 데이터 완전 삭제 */
  async deleteWallet(): Promise<void> {
    await SecureStore.deleteItemAsync(WALLET_KEY);
    await SecureStore.deleteItemAsync(MNEMONIC_KEY);
  },
};
