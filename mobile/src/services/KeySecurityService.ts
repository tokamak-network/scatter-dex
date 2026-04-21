/**
 * KeySecurityService — hardware-backed wallet key security + multi-wallet storage.
 *
 * Storage (multi-wallet):
 *   scatterdex_wallets_index        — JSON WalletMeta[]
 *   scatterdex_wallets_active_id    — active wallet id
 *   scatterdex_wallet_secret_<id>   — JSON WalletSecret (biometric-gated access)
 *
 * Legacy keys kept as a rollback mirror of the active wallet:
 *   scatterdex_wallet_pk, scatterdex_wallet_mnemonic, scatterdex_wallet_address
 */
import 'react-native-get-random-values';
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import { ethers } from 'ethers';

import type { WalletMeta, WalletSecret, WalletSource } from '../types/wallet';

const WALLET_KEY = 'scatterdex_wallet_pk';
const MNEMONIC_KEY = 'scatterdex_wallet_mnemonic';
const ADDRESS_KEY = 'scatterdex_wallet_address';
const AUTH_ENABLED_KEY = 'scatterdex_biometric_enabled';

const WALLETS_INDEX_KEY = 'scatterdex_wallets_index';
const ACTIVE_WALLET_ID_KEY = 'scatterdex_wallets_active_id';
const WALLET_SECRET_PREFIX = 'scatterdex_wallet_secret_';

const SECURE_OPTS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;

function generateWalletId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

let migrationPromise: Promise<void> | null = null;

async function readIndex(): Promise<WalletMeta[]> {
  const raw = await SecureStore.getItemAsync(WALLETS_INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeIndex(list: WalletMeta[]): Promise<void> {
  await SecureStore.setItemAsync(WALLETS_INDEX_KEY, JSON.stringify(list));
}

async function readSecret(id: string): Promise<WalletSecret | null> {
  const raw = await SecureStore.getItemAsync(`${WALLET_SECRET_PREFIX}${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WalletSecret;
  } catch {
    return null;
  }
}

async function writeSecret(id: string, secret: WalletSecret): Promise<void> {
  await SecureStore.setItemAsync(
    `${WALLET_SECRET_PREFIX}${id}`,
    JSON.stringify(secret),
    SECURE_OPTS,
  );
}

async function deleteSecret(id: string): Promise<void> {
  await SecureStore.deleteItemAsync(`${WALLET_SECRET_PREFIX}${id}`);
}

async function runMigration(): Promise<void> {
  const existing = await SecureStore.getItemAsync(WALLETS_INDEX_KEY);
  if (existing) return;

  const [legacyAddr, legacyPk, legacyMnemonic] = await Promise.all([
    SecureStore.getItemAsync(ADDRESS_KEY),
    SecureStore.getItemAsync(WALLET_KEY),
    SecureStore.getItemAsync(MNEMONIC_KEY),
  ]);

  if (!legacyAddr || !legacyPk) {
    await SecureStore.setItemAsync(WALLETS_INDEX_KEY, JSON.stringify([]));
    return;
  }

  const id = generateWalletId();
  const meta: WalletMeta = {
    id,
    address: ethers.getAddress(legacyAddr),
    nickname: 'Wallet 1',
    source: legacyMnemonic ? 'mnemonic' : 'privateKey',
    createdAt: Date.now(),
  };
  const secret: WalletSecret = legacyMnemonic
    ? { privateKey: legacyPk, mnemonic: legacyMnemonic }
    : { privateKey: legacyPk };

  await writeSecret(id, secret);
  await writeIndex([meta]);
  await SecureStore.setItemAsync(ACTIVE_WALLET_ID_KEY, id);
}

function ensureMigrated(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = runMigration().catch(err => {
      migrationPromise = null;
      throw err;
    });
  }
  return migrationPromise;
}

async function mirrorLegacyFromSecret(secret: WalletSecret, address: string): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(WALLET_KEY, secret.privateKey, SECURE_OPTS),
    SecureStore.setItemAsync(ADDRESS_KEY, address),
    secret.mnemonic
      ? SecureStore.setItemAsync(MNEMONIC_KEY, secret.mnemonic, SECURE_OPTS)
      : SecureStore.deleteItemAsync(MNEMONIC_KEY),
  ]);
}

async function clearLegacy(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(WALLET_KEY),
    SecureStore.deleteItemAsync(MNEMONIC_KEY),
    SecureStore.deleteItemAsync(ADDRESS_KEY),
  ]);
}

async function getActiveMeta(): Promise<WalletMeta | null> {
  await ensureMigrated();
  const [id, list] = await Promise.all([
    SecureStore.getItemAsync(ACTIVE_WALLET_ID_KEY),
    readIndex(),
  ]);
  if (!id) return null;
  return list.find(w => w.id === id) ?? null;
}

async function addWalletInternal(
  privateKey: string,
  address: string,
  mnemonic: string | undefined,
  source: WalletSource,
  nickname: string | undefined,
): Promise<WalletMeta> {
  await ensureMigrated();
  const checksummed = ethers.getAddress(address);
  const list = await readIndex();
  if (list.some(w => w.address === checksummed)) {
    throw new Error(`Wallet with address ${checksummed} already exists`);
  }

  const id = generateWalletId();
  const meta: WalletMeta = {
    id,
    address: checksummed,
    nickname: nickname ?? `Wallet ${list.length + 1}`,
    source,
    createdAt: Date.now(),
  };
  const secret: WalletSecret = mnemonic
    ? { privateKey, mnemonic }
    : { privateKey };

  await writeSecret(id, secret);
  await writeIndex([...list, meta]);

  const activeId = await SecureStore.getItemAsync(ACTIVE_WALLET_ID_KEY);
  if (!activeId) {
    await SecureStore.setItemAsync(ACTIVE_WALLET_ID_KEY, id);
    await mirrorLegacyFromSecret(secret, checksummed);
  }

  return meta;
}

export const KeySecurityService = {
  // ─── Biometric ────────────────────────────────────

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

  async _biometricGate(reason: string): Promise<boolean> {
    if (!(await this.isBiometricEnabled())) return true;
    return this.authenticate(reason);
  },

  // ─── Multi-wallet API ─────────────────────────────

  async listWallets(): Promise<WalletMeta[]> {
    await ensureMigrated();
    return readIndex();
  },

  async getActiveWalletId(): Promise<string | null> {
    await ensureMigrated();
    return SecureStore.getItemAsync(ACTIVE_WALLET_ID_KEY);
  },

  async setActiveWalletId(id: string): Promise<void> {
    await ensureMigrated();
    const [list, secret] = await Promise.all([readIndex(), readSecret(id)]);
    const meta = list.find(w => w.id === id);
    if (!meta) throw new Error(`Wallet id not found: ${id}`);
    if (!secret) throw new Error(`Wallet secret missing for id: ${id}`);
    await SecureStore.setItemAsync(ACTIVE_WALLET_ID_KEY, id);
    await mirrorLegacyFromSecret(secret, meta.address);
  },

  async getSignerForWallet(id: string, provider: ethers.Provider): Promise<ethers.Wallet | null> {
    await ensureMigrated();
    if (!(await this._biometricGate('Authenticate to access your wallet'))) return null;
    const secret = await readSecret(id);
    if (!secret) return null;
    return new ethers.Wallet(secret.privateKey, provider);
  },

  // ─── Wallet create / import ───────────────────────

  async createWallet(nickname?: string): Promise<{ id: string; address: string; mnemonic: string }> {
    const hdWallet = ethers.Wallet.createRandom();
    const mnemonic = hdWallet.mnemonic!.phrase;
    const meta = await addWalletInternal(
      hdWallet.privateKey,
      hdWallet.address,
      mnemonic,
      'created',
      nickname,
    );
    return { id: meta.id, address: meta.address, mnemonic };
  },

  async importFromMnemonic(mnemonic: string, nickname?: string): Promise<string> {
    const hdWallet = ethers.Wallet.fromPhrase(mnemonic.trim());
    const meta = await addWalletInternal(
      hdWallet.privateKey,
      hdWallet.address,
      mnemonic.trim(),
      'mnemonic',
      nickname,
    );
    return meta.address;
  },

  async importFromPrivateKey(privateKey: string, nickname?: string): Promise<string> {
    const pk = privateKey.trim().startsWith('0x') ? privateKey.trim() : `0x${privateKey.trim()}`;
    const wallet = new ethers.Wallet(pk);
    const meta = await addWalletInternal(
      pk,
      wallet.address,
      undefined,
      'privateKey',
      nickname,
    );
    return meta.address;
  },

  // ─── Active-wallet key access ─────────────────────

  async hasWallet(): Promise<boolean> {
    await ensureMigrated();
    const list = await readIndex();
    return list.length > 0;
  },

  /** Active wallet address — served from the legacy mirror to keep this hot-path fast. */
  async getActiveAddress(): Promise<string | null> {
    await ensureMigrated();
    return SecureStore.getItemAsync(ADDRESS_KEY);
  },

  async getPrivateKey(): Promise<string | null> {
    await ensureMigrated();
    const activeId = await SecureStore.getItemAsync(ACTIVE_WALLET_ID_KEY);
    if (!activeId) return null;
    if (!(await this._biometricGate('Authenticate to access your private key'))) return null;
    const secret = await readSecret(activeId);
    return secret?.privateKey ?? null;
  },

  async getSigner(provider: ethers.Provider): Promise<ethers.Wallet | null> {
    const pk = await this.getPrivateKey();
    if (!pk) return null;
    return new ethers.Wallet(pk, provider);
  },

  async getMnemonic(): Promise<string | null> {
    await ensureMigrated();
    const activeId = await SecureStore.getItemAsync(ACTIVE_WALLET_ID_KEY);
    if (!activeId) return null;
    const list = await readIndex();
    const meta = list.find(w => w.id === activeId);
    if (!meta || meta.source === 'privateKey') return null;
    if (!(await this.authenticate('Authenticate to view recovery phrase'))) return null;
    const secret = await readSecret(activeId);
    return secret?.mnemonic ?? null;
  },

  async authorizeTransaction(description: string): Promise<boolean> {
    return this._biometricGate(`Approve: ${description}`);
  },

  // ─── Deletion ─────────────────────────────────────

  /**
   * No-arg deletes the active wallet (legacy single-wallet UX).
   * With `id`, deletes that specific wallet. When the deleted wallet was
   * active, the next remaining wallet is promoted; if none remains (or its
   * secret is unreadable), legacy mirror keys are wiped so callers cannot
   * keep operating on a stale address. Non-active deletes leave the mirror
   * untouched.
   */
  async deleteWallet(id?: string): Promise<void> {
    await ensureMigrated();
    const [list, activeId] = await Promise.all([
      readIndex(),
      SecureStore.getItemAsync(ACTIVE_WALLET_ID_KEY),
    ]);
    const targetId = id ?? activeId;
    if (!targetId) {
      await Promise.all([
        ...list.map(w => deleteSecret(w.id)),
        SecureStore.deleteItemAsync(WALLETS_INDEX_KEY),
        SecureStore.deleteItemAsync(ACTIVE_WALLET_ID_KEY),
        clearLegacy(),
      ]);
      return;
    }

    const remaining = list.filter(w => w.id !== targetId);
    await deleteSecret(targetId);
    await writeIndex(remaining);

    if (targetId !== activeId) return;

    const next = remaining[0];
    const nextSecret = next ? await readSecret(next.id) : null;
    if (next && nextSecret) {
      await SecureStore.setItemAsync(ACTIVE_WALLET_ID_KEY, next.id);
      await mirrorLegacyFromSecret(nextSecret, next.address);
    } else {
      await Promise.all([
        SecureStore.deleteItemAsync(ACTIVE_WALLET_ID_KEY),
        clearLegacy(),
      ]);
    }
  },
};
