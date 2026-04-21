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
  seedInfo?: { seedId: string; derivationIndex: number },
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
    ...(seedInfo ? { seedId: seedInfo.seedId, derivationIndex: seedInfo.derivationIndex } : {}),
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

  /**
   * Create a new wallet. When an existing seed-backed wallet (source
   * 'created' or 'mnemonic') is already stored, we reuse its mnemonic and
   * derive the next BIP-44 account index from it — the user only ever has
   * one recovery phrase to back up, not one per button press. Only when the
   * index is empty (or only holds privateKey-imported wallets) do we mint
   * a fresh mnemonic.
   *
   * Returned `mnemonic` may therefore be the same seed the caller has
   * already been shown in a prior create; the alert copy should say so.
   */
  async createWallet(nickname?: string): Promise<{ id: string; address: string; mnemonic: string; reusedSeed: boolean }> {
    await ensureMigrated();
    const list = await readIndex();

    // Look for an existing seed we can derive a new account from. Prefer
    // wallets that already have a seedId (new-format) before falling back
    // to pre-HD legacy wallets that were created one-seed-per-account.
    const hosted = list.find(w => w.seedId !== undefined && (w.source === 'created' || w.source === 'mnemonic'))
      ?? list.find(w => (w.source === 'created' || w.source === 'mnemonic'));

    if (hosted) {
      if (!(await this._biometricGate('Authenticate to derive a new account'))) {
        throw new Error('Authentication cancelled');
      }
      const secret = await readSecret(hosted.id);
      if (!secret?.mnemonic) {
        // Host wallet lost its mnemonic (corrupt install) — fall through
        // and mint a fresh seed rather than failing the create outright.
      } else {
        const seedId = hosted.seedId ?? hosted.id; // legacy wallets adopt their own id as seedId
        const indexes = list
          .filter(w => (w.seedId ?? w.id) === seedId)
          .map(w => w.derivationIndex ?? 0);
        const nextIndex = indexes.length === 0 ? 0 : Math.max(...indexes) + 1;
        const derived = ethers.HDNodeWallet.fromPhrase(
          secret.mnemonic,
          undefined,
          `m/44'/60'/0'/0/${nextIndex}`,
        );
        const meta = await addWalletInternal(
          derived.privateKey,
          derived.address,
          secret.mnemonic,
          'created',
          nickname,
          { seedId, derivationIndex: nextIndex },
        );
        return { id: meta.id, address: meta.address, mnemonic: secret.mnemonic, reusedSeed: true };
      }
    }

    // No reusable seed — mint a fresh mnemonic and anchor it with a new
    // seedId. Subsequent creates will derive additional accounts from
    // this one.
    const hdWallet = ethers.Wallet.createRandom();
    const mnemonic = hdWallet.mnemonic!.phrase;
    const seedId = generateWalletId();
    const meta = await addWalletInternal(
      hdWallet.privateKey,
      hdWallet.address,
      mnemonic,
      'created',
      nickname,
      { seedId, derivationIndex: 0 },
    );
    return { id: meta.id, address: meta.address, mnemonic, reusedSeed: false };
  },

  async importFromMnemonic(mnemonic: string, nickname?: string): Promise<string> {
    const trimmed = mnemonic.trim();
    const hdWallet = ethers.Wallet.fromPhrase(trimmed);
    const seedId = generateWalletId();
    const meta = await addWalletInternal(
      hdWallet.privateKey,
      hdWallet.address,
      trimmed,
      'mnemonic',
      nickname,
      { seedId, derivationIndex: 0 },
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
   *
   * Guard: a no-arg call with no active id but a non-empty wallet index
   * indicates storage corruption, not an intent to wipe everything. We
   * refuse rather than mass-delete; callers must pass an explicit id.
   */
  async deleteWallet(id?: string): Promise<void> {
    await ensureMigrated();
    const [list, activeId] = await Promise.all([
      readIndex(),
      SecureStore.getItemAsync(ACTIVE_WALLET_ID_KEY),
    ]);
    const targetId = id ?? activeId;
    if (!targetId) {
      if (list.length > 0) {
        throw new Error(
          'deleteWallet() called with no id and no active wallet, but the wallet index is non-empty. Pass an explicit id to delete a specific wallet.',
        );
      }
      await Promise.all([
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
