/**
 * Stealth Address — secp256k1 / EIP-5564.
 *
 * Mirrors `frontend/app/lib/stealth.ts` 1:1 minus the browser-only
 * `buildStealthClaimLink` (mobile shares via the OS Share sheet, not a
 * URL fragment — the deep-link form is left for a future companion PR).
 *
 * Flow:
 *   1. Recipient: `generateMetaAddress()` → `{ spendingKey, viewingKey,
 *      metaAddress }`. The keys are sensitive and must be stored in
 *      SecureStore; the meta-address is publishable.
 *   2. Sender: `generateStealthAddress(metaAddress)` → `{ stealthAddress,
 *      ephemeralPubKey }`. Use `stealthAddress` as the claim recipient
 *      and persist `ephemeralPubKey` alongside the claim secret.
 *   3. Recipient: `deriveStealthPrivateKey(spendingKey, viewingKey,
 *      ephemeralPubKey)` → hex private key for the stealth address.
 */

// Bare subpath imports — `mobile/tsconfig.json` extends Expo's base which
// resolves to "node" mode, where the package's `exports` keys are
// `./secp256k1` / `./sha3` / `./utils` (no `.js` suffix). The web frontend
// uses the `.js`-suffixed form because its bundler resolution allows it,
// but mobile's TS resolution rejects it. Same module either way.
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { ethers } from 'ethers';

// noble v1.2.0 (mobile-resolved) names this `ProjectivePoint`; later
// noble (web-resolved) renames it `Point`. The web copy of this file
// uses `Point`; the surface we touch (`fromHex`, `BASE`, `multiply`,
// `add`, `toRawBytes`) is identical between the two.
const POINT = secp256k1.ProjectivePoint;
const CURVE_ORDER = secp256k1.CURVE.n;

// ─── Meta-address ────────────────────────────────────────────

export const META_ADDRESS_PREFIX = 'st:eth:0x';

export interface MetaAddress {
  spendingKey: string; // hex private key (sensitive)
  viewingKey: string;  // hex private key (sensitive)
  metaAddress: string; // "st:eth:0x<spendingPubKey><viewingPubKey>" (publishable)
}

export function generateMetaAddress(): MetaAddress {
  const spendingKeyBytes = secp256k1.utils.randomPrivateKey();
  const viewingKeyBytes = secp256k1.utils.randomPrivateKey();
  const spendingKey = bytesToHex(spendingKeyBytes);
  const viewingKey = bytesToHex(viewingKeyBytes);

  // Compressed (33-byte) pubkeys keep the meta-address short enough to
  // QR-encode without scaling pain.
  const S = bytesToHex(secp256k1.getPublicKey(spendingKeyBytes, true));
  const V = bytesToHex(secp256k1.getPublicKey(viewingKeyBytes, true));

  return { spendingKey, viewingKey, metaAddress: `${META_ADDRESS_PREFIX}${S}${V}` };
}

export function parseMetaAddress(metaAddress: string): {
  spendingPubKey: Uint8Array;
  viewingPubKey: Uint8Array;
} {
  if (!metaAddress.startsWith(META_ADDRESS_PREFIX)) {
    throw new Error('Invalid meta-address prefix (expected st:eth:0x...)');
  }
  const hex = metaAddress.slice(META_ADDRESS_PREFIX.length);
  if (hex.length !== 132) {
    throw new Error('Invalid meta-address length (expected 66 bytes compressed)');
  }
  return {
    spendingPubKey: hexToBytes(hex.slice(0, 66)),
    viewingPubKey: hexToBytes(hex.slice(66)),
  };
}

export function isMetaAddress(input: string): boolean {
  // Length-only check would let `parseMetaAddress` and the downstream
  // `hexToBytes` throw on a junk-but-right-length payload. The regex
  // gates non-hex characters cheaply (no library import needed).
  return input.startsWith(META_ADDRESS_PREFIX)
    && /^[0-9a-fA-F]{132}$/.test(input.slice(META_ADDRESS_PREFIX.length));
}

// ─── Stealth address generation (sender side) ────────────────

export interface StealthResult {
  stealthAddress: string;  // 0x-prefixed Ethereum address
  ephemeralPubKey: string; // 0x-prefixed compressed hex (share with recipient)
}

export function generateStealthAddress(metaAddress: string): StealthResult {
  // EIP-5564 sender path: ephemeral r per claim, ECDH(r, V) → offset,
  // stealth pubkey = S + offset·G, address = keccak256(uncompressed)[12:].
  const { spendingPubKey, viewingPubKey } = parseMetaAddress(metaAddress);

  const ephemeralPrivKey = secp256k1.utils.randomPrivateKey();
  const ephemeralPubKey = secp256k1.getPublicKey(ephemeralPrivKey, true);

  const V = POINT.fromHex(bytesToHex(viewingPubKey));
  const sharedPoint = V.multiply(bytesToBigInt(ephemeralPrivKey));
  const sharedSecret = keccak_256(sharedPoint.toRawBytes(true));

  const S = POINT.fromHex(bytesToHex(spendingPubKey));
  const stealthOffset = POINT.BASE.multiply(bytesToBigInt(sharedSecret));
  const stealthPubKey = S.add(stealthOffset);

  const uncompressed = stealthPubKey.toRawBytes(false).slice(1);
  const addressHash = keccak_256(uncompressed);
  const stealthAddress = ethers.getAddress('0x' + bytesToHex(addressHash.slice(12)));

  return {
    stealthAddress,
    ephemeralPubKey: '0x' + bytesToHex(ephemeralPubKey),
  };
}

// ─── Stealth private key derivation (recipient side) ─────────

export function deriveStealthPrivateKey(
  spendingKey: string,
  viewingKey: string,
  ephemeralPubKeyHex: string,
): string {
  const strip0x = (h: string) => (h.startsWith('0x') ? h.slice(2) : h);
  const epk = hexToBytes(strip0x(ephemeralPubKeyHex));

  const R = POINT.fromHex(bytesToHex(epk));
  const sharedPoint = R.multiply(bytesToBigInt(hexToBytes(strip0x(viewingKey))));
  const sharedSecret = keccak_256(sharedPoint.toRawBytes(true));

  const s = bytesToBigInt(hexToBytes(strip0x(spendingKey)));
  const offset = bytesToBigInt(sharedSecret);
  const stealthPrivKey = (s + offset) % CURVE_ORDER;

  return '0x' + stealthPrivKey.toString(16).padStart(64, '0');
}

export function stealthWallet(
  spendingKey: string,
  viewingKey: string,
  ephemeralPubKeyHex: string,
  provider?: ethers.Provider,
): ethers.Wallet {
  return new ethers.Wallet(
    deriveStealthPrivateKey(spendingKey, viewingKey, ephemeralPubKeyHex),
    provider,
  );
}

// ─── Utility ─────────────────────────────────────────────────

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt('0x' + bytesToHex(bytes));
}
