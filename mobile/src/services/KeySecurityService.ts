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
   * Create a new wallet.
   *
   * Happy path — a seed-backed wallet (source 'created' or 'mnemonic') is
   * already on the device: reuse its mnemonic and derive the next BIP-44
   * account index. The user keeps a single recovery phrase to back up
   * instead of one per button press. Returns `reusedSeed: true` and
   * omits `mnemonic` from the result so the caller never re-surfaces a
   * phrase the user has already saved (and so the value isn't held in JS
   * memory longer than necessary — cuts the exposure surface via crash
   * reports / accidental logs).
   *
   * Fresh-seed paths — mint a new mnemonic and anchor a new seedId when:
   *   1. the index is empty, or
   *   2. the only existing wallets are privateKey imports (no seed), or
   *   3. every seed-backed wallet in the index has a missing mnemonic in
   *      SecureStore (full corrupt install). We walk all candidates —
   *      not just the first — and only mint a fresh seed after every
   *      one has failed its SecureStore read. Each failure is logged so
   *      the fallback isn't silent. This keeps Create working when one
   *      row was corrupted mid-migration but a sibling row derived from
   *      the same seed is still healthy.
   *
   * The reused-seed branch goes through `authenticate()` rather than
   * `_biometricGate()` so the full recovery-phrase prompt always fires —
   * matching `getMnemonic()`'s guard and stopping an attacker from
   * harvesting a mnemonic when the biometric toggle is off.
   */
  async createWallet(nickname?: string): Promise<
    | { id: string; address: string; mnemonic: string; reusedSeed: false }
    | { id: string; address: string; reusedSeed: true }
  > {
    await ensureMigrated();
    const list = await readIndex();

    // "The device manages exactly one mnemonic." Whichever seed-backed
    // wallet is already on the device — whether Created here or imported
    // from another phone via Recovery Phrase — is *the* seed, and every
    // subsequent Create derives a new BIP-44 account from it. Only
    // privateKey-imported wallets are excluded (they have no seed). That
    // way the user only ever has one recovery phrase to back up.
    // All seed-backed candidates, new-format rows first so a healthy
    // `seedId`-tagged entry is preferred over a pre-HD legacy wallet.
    const candidates = [
      ...list.filter(w => (w.source === 'created' || w.source === 'mnemonic') && w.seedId !== undefined),
      ...list.filter(w => (w.source === 'created' || w.source === 'mnemonic') && w.seedId === undefined),
    ];

    if (candidates.length > 0) {
      // `authenticate()` — not `_biometricGate()` — because reading an
      // existing recovery phrase is the same security level as
      // `getMnemonic()`. The gate variant turns into a no-op when the
      // biometric toggle is off, which would let an attacker who has
      // briefly unlocked the phone extract the mnemonic by tapping
      // "Create New Wallet".
      if (!(await this.authenticate('Authenticate to derive a new account'))) {
        throw new Error('Authentication cancelled');
      }

      // Walk every candidate rather than failing on the first corrupt
      // row — an install can have one row whose SecureStore secret lost
      // its `mnemonic` (interrupted migration, power-cycle during write,
      // iOS Keychain ACL change) while a sibling row derived from the
      // same seed is still healthy. Picking the first healthy row keeps
      // Create working instead of silently minting a second unrelated
      // mnemonic the user would have to back up separately.
      for (const hosted of candidates) {
        let secret;
        try {
          secret = await readSecret(hosted.id);
        } catch (err) {
          // A SecureStore read failure here is telling — log it so the
          // fall-through to minting a fresh seed below is at least
          // diagnosable in the Metro console.
          console.warn(
            `[KeySecurityService] readSecret(${hosted.id}) failed while searching for a reusable seed; falling back`,
            err,
          );
          continue;
        }
        if (!secret?.mnemonic) {
          console.warn(
            `[KeySecurityService] wallet ${hosted.id} has no mnemonic in SecureStore (corrupt install?); trying next candidate`,
          );
          continue;
        }

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
        return { id: meta.id, address: meta.address, reusedSeed: true };
      }

      // Every candidate was corrupt. Log the surrender before falling
      // through to mint a fresh seed so the user at least isn't stuck.
      console.warn(
        `[KeySecurityService] all ${candidates.length} seed-backed wallets failed the mnemonic read; minting a fresh seed`,
      );
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

  /**
   * Import a BIP-39 mnemonic. The device only ever manages one mnemonic,
   * so:
   *   - If no seed-backed wallet exists yet, the import anchors the
   *     device seed at index 0.
   *   - If a seed-backed wallet already exists AND it was derived from
   *     the same mnemonic the caller is importing, we derive the next
   *     free BIP-44 account index from that shared seed (acts exactly
   *     like Create). `reusedSeed` is true.
   *   - If a seed-backed wallet already exists with a DIFFERENT
   *     mnemonic, the import is rejected. The user must delete the
   *     existing wallets (and its mnemonic) before restoring a new
   *     recovery phrase — this is what keeps the one-mnemonic-per-
   *     device invariant true.
   */
  async importFromMnemonic(mnemonic: string, nickname?: string): Promise<{ address: string; reusedSeed: boolean }> {
    await ensureMigrated();
    const trimmed = mnemonic.trim();
    const list = await readIndex();
    const hosted = list.find(w => (w.source === 'created' || w.source === 'mnemonic') && w.seedId !== undefined)
      ?? list.find(w => w.source === 'created' || w.source === 'mnemonic');

    if (hosted) {
      if (!(await this._biometricGate('Authenticate to import recovery phrase'))) {
        throw new Error('Authentication cancelled');
      }
      const hostedSecret = await readSecret(hosted.id);
      if (hostedSecret?.mnemonic && hostedSecret.mnemonic === trimmed) {
        // Same seed — treat like Create and derive the next unused index.
        const seedId = hosted.seedId ?? hosted.id;
        const indexes = list
          .filter(w => (w.seedId ?? w.id) === seedId)
          .map(w => w.derivationIndex ?? 0);
        const nextIndex = indexes.length === 0 ? 0 : Math.max(...indexes) + 1;
        const derived = ethers.HDNodeWallet.fromPhrase(
          trimmed,
          undefined,
          `m/44'/60'/0'/0/${nextIndex}`,
        );
        const meta = await addWalletInternal(
          derived.privateKey,
          derived.address,
          trimmed,
          'mnemonic',
          nickname,
          { seedId, derivationIndex: nextIndex },
        );
        return { address: meta.address, reusedSeed: true };
      }
      // Different mnemonic — refuse rather than silently grow a second
      // seed tree the user would have to back up separately.
      throw new Error(
        'This device already manages a recovery phrase. Delete existing seed-backed wallets before importing a different one.',
      );
    }

    // No existing seed — the import anchors a fresh one.
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
    return { address: meta.address, reusedSeed: false };
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
