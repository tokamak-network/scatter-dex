/**
 * PinService — app-level 6-digit PIN, with mnemonic-based recovery
 * after lockout. Storage is plain hash-compare; PIN does NOT wrap any
 * key material, so a forgotten PIN means "reset via recovery phrase",
 * not loss of funds.
 *
 * Layout in SecureStore (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`):
 *   pin_salt    — 16 random bytes, hex
 *   pin_hash    — scrypt(pin, salt, N=2^14, r=8, p=1, 32B), hex
 *   pin_fails   — running failure count since last successful verify
 *
 * Lockout policy: PIN_MAX_FAILURES (5) consecutive fails -> the only
 * way out is for the caller to verify the user's recovery mnemonic
 * (in KeySecurityService) and then `enroll(newPin)` to overwrite.
 * There is no time-based unlock; recovery is the single explicit door.
 */
import * as SecureStore from 'expo-secure-store';
import { scrypt, hexlify, randomBytes, getBytes } from 'ethers';

const KEY_SALT = 'scatterdex_pin_salt';
const KEY_HASH = 'scatterdex_pin_hash';
const KEY_FAILS = 'scatterdex_pin_fails';

const SECURE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const PIN_LENGTH = 6;
export const PIN_MAX_FAILURES = 5;

// Light mobile-friendly scrypt params — ~150ms on mid-range Android.
// Bumped from defaults so brute-forcing 1M PINs is non-trivial.
const SCRYPT_N = 1 << 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 32;

function assertPinShape(pin: string): void {
  if (!/^\d+$/.test(pin) || pin.length !== PIN_LENGTH) {
    throw new Error(`PIN must be exactly ${PIN_LENGTH} digits`);
  }
}

async function hashPin(pin: string, saltHex: string): Promise<string> {
  const salt = getBytes(saltHex);
  const pwd = new TextEncoder().encode(pin);
  const out = await scrypt(pwd, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_DKLEN);
  return hexlify(out);
}

/** Length-safe equal-time hex compare — iterate the full string and
 *  XOR each char so a wrong PIN doesn't leak position via early-exit. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export const PinService = {
  async isEnrolled(): Promise<boolean> {
    const salt = await SecureStore.getItemAsync(KEY_SALT, SECURE_OPTS);
    return Boolean(salt);
  },

  async enroll(pin: string): Promise<void> {
    assertPinShape(pin);
    const saltHex = hexlify(randomBytes(16));
    const hashHex = await hashPin(pin, saltHex);
    await Promise.all([
      SecureStore.setItemAsync(KEY_SALT, saltHex, SECURE_OPTS),
      SecureStore.setItemAsync(KEY_HASH, hashHex, SECURE_OPTS),
      SecureStore.setItemAsync(KEY_FAILS, '0', SECURE_OPTS),
    ]);
  },

  async verify(pin: string): Promise<boolean> {
    if (!/^\d+$/.test(pin) || pin.length !== PIN_LENGTH) return false;
    // Read the three keys in parallel — they are independent and each
    // SecureStore round-trip is ~10–15ms on Android. Lockout is then
    // checked against the in-memory value.
    const [failsRaw, saltHex, expected] = await Promise.all([
      SecureStore.getItemAsync(KEY_FAILS, SECURE_OPTS),
      SecureStore.getItemAsync(KEY_SALT, SECURE_OPTS),
      SecureStore.getItemAsync(KEY_HASH, SECURE_OPTS),
    ]);
    const fails = failsRaw ? parseInt(failsRaw, 10) : 0;
    if (Number.isFinite(fails) && fails >= PIN_MAX_FAILURES) return false;
    if (!saltHex || !expected) return false;
    const got = await hashPin(pin, saltHex);
    if (constantTimeEqual(got, expected)) {
      await SecureStore.setItemAsync(KEY_FAILS, '0', SECURE_OPTS);
      return true;
    }
    await SecureStore.setItemAsync(KEY_FAILS, String(fails + 1), SECURE_OPTS);
    return false;
  },

  async getFailureCount(): Promise<number> {
    const v = await SecureStore.getItemAsync(KEY_FAILS, SECURE_OPTS);
    const n = v ? parseInt(v, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  },

  async isLockedOut(): Promise<boolean> {
    return (await this.getFailureCount()) >= PIN_MAX_FAILURES;
  },

  async resetFailures(): Promise<void> {
    await SecureStore.setItemAsync(KEY_FAILS, '0', SECURE_OPTS);
  },

  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(KEY_SALT, SECURE_OPTS);
    await SecureStore.deleteItemAsync(KEY_HASH, SECURE_OPTS);
    await SecureStore.deleteItemAsync(KEY_FAILS, SECURE_OPTS);
  },
};
