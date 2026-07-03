import { ethers } from "ethers";

/** `encrypt`/`decrypt` pair consumable by
 *  {@link IndexedDbAdapterOpts} (and any other storage adapter that
 *  takes the same hooks). */
export interface NoteCipher {
  encrypt: (plaintext: string) => Promise<string>;
  decrypt: (ciphertext: string) => Promise<string>;
}

// Envelope: `v1:<b64 iv>:<b64 ciphertext>`. The version prefix lets a
// future scheme change (different KDF label, key rotation) coexist with
// old records during migration.
const ENVELOPE_V1 = "v1";

// Fixed HKDF context strings. The `info` label domain-separates this
// key from anything else derived off the same wallet signature — the
// EdDSA private key is keccak256(signature) with no HKDF step, so the
// two derivations can never collide.
const HKDF_SALT = "zkscatter-note-cipher";
const HKDF_INFO = "zkscatter-note-idb-aes-gcm-v1";

function getSubtle(): SubtleCrypto {
  // `encrypt()` also needs `getRandomValues` for IVs — validate both up
  // front so a partial WebCrypto polyfill fails with a clear error
  // instead of a mid-encrypt TypeError.
  const c = globalThis.crypto;
  if (!c?.subtle || typeof c.getRandomValues !== "function") {
    throw new Error(
      "createSignatureNoteCipher: WebCrypto (globalThis.crypto.subtle + getRandomValues) is required",
    );
  }
  return c.subtle;
}

/** Derive an AES-GCM-256 note cipher from a wallet ECDSA signature —
 *  the same 65-byte `personal_sign` output `deriveEdDSAKey` returns, so
 *  an app that already derived its trading key can enable note
 *  encryption-at-rest without a second wallet prompt.
 *
 *  Key path: HKDF-SHA256(ikm = signature bytes, salt/info = fixed
 *  domain-separation labels) → non-extractable AES-GCM-256 CryptoKey.
 *  The key lives only in memory (like the signature itself); losing it
 *  is fine — it's re-derivable from the wallet by re-signing.
 *
 *  Each `encrypt` call uses a fresh random 96-bit IV, so identical
 *  plaintexts produce unlinkable ciphertexts. `decrypt` throws on a
 *  tampered envelope (GCM auth failure) — storage adapters treat that
 *  as a skip, not a crash. */
export function createSignatureNoteCipher(signature: string): NoteCipher {
  // Same exact-length check `deriveEdDSAKey` applies to this input.
  if (!ethers.isHexString(signature, 65)) {
    throw new Error(
      "createSignatureNoteCipher: signature must be a 0x-prefixed 65-byte hex string",
    );
  }
  const subtle = getSubtle();
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // One derivation per cipher instance, shared by every call.
  const keyPromise = (async () => {
    // Copy into a fresh Uint8Array — ethers returns
    // `Uint8Array<ArrayBufferLike>`, which TS won't accept as BufferSource.
    const ikm = await subtle.importKey(
      "raw",
      new Uint8Array(ethers.getBytes(signature)),
      "HKDF",
      false,
      ["deriveKey"],
    );
    return subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: enc.encode(HKDF_SALT),
        info: enc.encode(HKDF_INFO),
      },
      ikm,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  })();

  return {
    async encrypt(plaintext: string): Promise<string> {
      const key = await keyPromise;
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const ct = await subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        enc.encode(plaintext),
      );
      return `${ENVELOPE_V1}:${ethers.encodeBase64(iv)}:${ethers.encodeBase64(new Uint8Array(ct))}`;
    },

    async decrypt(ciphertext: string): Promise<string> {
      const [version, ivB64, ctB64] = ciphertext.split(":");
      if (version !== ENVELOPE_V1 || !ivB64 || !ctB64) {
        throw new Error(`note cipher: unrecognized envelope (${version ?? "empty"})`);
      }
      const key = await keyPromise;
      // `new Uint8Array(...)` copies — same BufferSource-typing
      // workaround as the HKDF import above.
      const pt = await subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(ethers.decodeBase64(ivB64)) },
        key,
        new Uint8Array(ethers.decodeBase64(ctB64)),
      );
      return dec.decode(pt);
    },
  };
}
