/**
 * Single source for the hardened `expo-secure-store` options the
 * mobile services share.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` keeps key material out of iCloud /
 * device-to-device backups: the value is readable only while this
 * specific device is unlocked, and never restored to a different
 * device after a backup. Use this for anything an attacker with a
 * backup or a paired device must not read — private keys, mnemonics,
 * the PIN salt/hash/fail counter.
 *
 * Non-secret data (public addresses, active-wallet pointers, feature
 * toggles) does NOT need this — the default `WHEN_UNLOCKED` is fine
 * and avoids the stricter access-class on every read. Use the bare
 * `SecureStore.{get,set,delete}ItemAsync` for those.
 */
import * as SecureStore from 'expo-secure-store';

export const SECURE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
