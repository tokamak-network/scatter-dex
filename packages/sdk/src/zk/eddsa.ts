/** EdDSA on Baby Jubjub for ZK-compatible order signing.
 *
 *  Why EdDSA: every spending circuit (authorize / claim / cancel)
 *  verifies a signature over the operation's Poseidon hash. ECDSA
 *  in-circuit is ~750K constraints; EdDSA on Baby Jubjub is ~5K.
 *  We use the wallet's native ECDSA exactly once — to
 *  deterministically derive the EdDSA key — and run every
 *  subsequent signature off the EdDSA key.
 *
 *  Derivation: the user signs a fixed message with the wallet
 *  (MetaMask / Rabby / Coinbase), the resulting ECDSA signature is
 *  keccak'd, and the 32-byte digest becomes the Baby Jubjub private
 *  key. This is deterministic — the same wallet always produces the
 *  same trading key — and never exposes the wallet's private key. */
import { ethers } from "ethers";
import { FIELD_MODULUS } from "./commitment";

/** Domain-separated derivation of a per-payout claim-secret seed from the
 *  wallet's deterministic EdDSA private key bytes (`keccak256` of the
 *  fixed-message ECDSA signature). Because the key is re-derivable from
 *  the wallet alone, so is the seed — there is no random seed to lose,
 *  and a recovery run can regenerate every claim secret just by
 *  re-signing. The domain tag keeps this value independent of the EdDSA
 *  key's own uses. Reduced into the BN254 scalar field for use as a
 *  Poseidon input.
 *
 *  Note: the seed is per-wallet (not per-payout); per-claim uniqueness
 *  comes from the leaf fields in `deriveClaimSecret`. Two byte-identical
 *  payouts (same recipients, amounts, releaseTime, order) would collide,
 *  but that surfaces as a `ClaimsGroupAlreadyExists` revert on the second
 *  settle — self-detecting, never silent loss. */
export function claimSeedFromKey(privateKey: Uint8Array): bigint {
  // The wallet-derived EdDSA private key is keccak256 of the signature →
  // always 32 bytes. Fail fast on anything else rather than silently
  // hashing a malformed key into a different (unrecoverable) seed.
  if (privateKey.length !== 32) {
    throw new Error(
      `claimSeedFromKey: expected a 32-byte key, got ${privateKey.length}`,
    );
  }
  const h = ethers.keccak256(
    ethers.concat([ethers.toUtf8Bytes("zkScatter:claim-seed:v1"), privateKey]),
  );
  return BigInt(h) % FIELD_MODULUS;
}

/** Default fixed message used by `deriveEdDSAKey` when callers don't
 *  pass their own. Keeping this stable across SDK versions matters:
 *  changing it would invalidate every existing user's EdDSA key. */
export const DEFAULT_DERIVE_MESSAGE =
  "Sign to generate your zkScatter trading key.\n\nThis key is used to sign orders privately.\nIt does not grant access to your funds.";

export interface EdDSAKeyPair {
  /** 32-byte Baby Jubjub private key (the keccak of the ECDSA sig). */
  privateKey: Uint8Array;
  /** Public point on Baby Jubjub: [Ax, Ay]. */
  publicKey: readonly [bigint, bigint];
}

export interface EdDSASignature {
  S: bigint;
  R8x: bigint;
  R8y: bigint;
}

// circomlibjs has no types; instances are callable objects with
// attached helpers. Narrowed where used, `unknown` in storage.
type Eddsa = {
  prv2pub(privKey: Uint8Array): [unknown, unknown];
  signPoseidon(privKey: Uint8Array, msg: unknown): {
    S: bigint;
    R8: [unknown, unknown];
  };
};
type Babyjub = { F: { e(x: bigint): unknown; toObject(x: unknown): bigint } };

let cached: { eddsa: Eddsa; babyJub: Babyjub } | null = null;
let cachePromise: Promise<{ eddsa: Eddsa; babyJub: Babyjub }> | null = null;

/** Lazy-build the circomlibjs Eddsa + Babyjub singletons.
 *
 *  The build cost (~50–150 ms each) is paid once per page; the
 *  in-flight Promise is memoized so two callers arriving before
 *  the first build settles share one initialization instead of
 *  starting parallel ones. */
async function getEddsa(): Promise<{ eddsa: Eddsa; babyJub: Babyjub }> {
  if (cached) return cached;
  if (!cachePromise) {
    const promise = (async () => {
      const mod = (await import("circomlibjs")) as unknown as {
        buildEddsa: () => Promise<Eddsa>;
        buildBabyjub: () => Promise<Babyjub>;
      };
      const [eddsa, babyJub] = await Promise.all([mod.buildEddsa(), mod.buildBabyjub()]);
      cached = { eddsa, babyJub };
      return cached;
    })();
    // Clear the in-flight Promise on rejection so a transient failure
    // (network blip on the dynamic import, OOM during table build)
    // doesn't latch — the next caller can retry instead of inheriting
    // the same poisoned Promise. `cached` only sets on success above,
    // so the only state to reset is `cachePromise`.
    promise.catch(() => {
      if (cachePromise === promise) cachePromise = null;
    });
    cachePromise = promise;
  }
  return cachePromise;
}

/** Eagerly initialise the EdDSA + BabyJub tables. Worker `preload`
 *  hooks should call this on startup so the first signing job
 *  doesn't pay the build cost on the user's hot path. */
export async function warmupEddsa(): Promise<void> {
  await getEddsa();
}

interface DeriveOpts {
  /** Override the default fixed message. Use only when migrating
   *  off an older message; changing it for new users would generate
   *  a different EdDSA key (and orphan their existing notes). */
  message?: string;
}

/** Derive the EdDSA keypair from a wallet signature.
 *
 *  Pass either an `ethers.Signer` (we'll prompt for `signMessage`)
 *  or a hex-encoded signature you already have. Returning the
 *  signature lets callers cache it for later flows that need the
 *  same material (e.g. AES-GCM key-wrapping for vault backup).
 *
 *  When a string signature is passed, `opts.message` has no effect
 *  (the signature was produced against whatever message the caller
 *  used). Passing both is treated as a programmer error — throws
 *  rather than silently ignoring the override. */
export async function deriveEdDSAKey(
  signerOrSignature: ethers.Signer | string,
  opts: DeriveOpts = {},
): Promise<{ keyPair: EdDSAKeyPair; signature: string }> {
  let signature: string;
  if (typeof signerOrSignature === "string") {
    if (opts.message !== undefined) {
      throw new Error(
        "deriveEdDSAKey: opts.message is ignored when a signature string is provided — drop one or the other",
      );
    }
    // EIP-191 ECDSA signatures from `personal_sign` are 65 bytes
    // (r ‖ s ‖ v) → 132 hex chars including the 0x prefix.
    if (!ethers.isHexString(signerOrSignature, 65)) {
      throw new Error(
        "deriveEdDSAKey: signature must be a 0x-prefixed 65-byte hex string",
      );
    }
    signature = signerOrSignature;
  } else {
    const message = opts.message ?? DEFAULT_DERIVE_MESSAGE;
    signature = await signerOrSignature.signMessage(message);
  }

  const hash = ethers.keccak256(signature);
  const privateKey = ethers.getBytes(hash);

  const { eddsa, babyJub } = await getEddsa();
  const pub = eddsa.prv2pub(privateKey);
  const publicKey: readonly [bigint, bigint] = [
    babyJub.F.toObject(pub[0]),
    babyJub.F.toObject(pub[1]),
  ];

  return {
    keyPair: { privateKey, publicKey },
    signature,
  };
}

/** Sign a message (a field element — usually a Poseidon order
 *  hash) with EdDSA. */
export async function signEdDSA(
  privateKey: Uint8Array,
  message: bigint,
): Promise<EdDSASignature> {
  const { eddsa, babyJub } = await getEddsa();
  const sig = eddsa.signPoseidon(privateKey, babyJub.F.e(message));
  return {
    S: sig.S,
    R8x: babyJub.F.toObject(sig.R8[0]),
    R8y: babyJub.F.toObject(sig.R8[1]),
  };
}

// ---------------------------------------------------------------------
// Plain JSON serialization
//
// Encryption (AES-GCM key wrapping with a per-account salt) lives
// outside the SDK — it's a storage-layer concern that depends on
// the host's secrets-handling model (browser localStorage vs RN
// Keychain). The notes storage adapters in Phase 6 own that.
// ---------------------------------------------------------------------

/** Serialize an EdDSA keypair to a JSON string for storage.
 *  The private key is hex-encoded; pubkey field elements are
 *  decimal strings (BigInt-safe). */
export function serializeKeyPair(kp: EdDSAKeyPair): string {
  return JSON.stringify({
    privateKey: ethers.hexlify(kp.privateKey),
    publicKey: [kp.publicKey[0].toString(), kp.publicKey[1].toString()],
  });
}

/** Inverse of `serializeKeyPair`. Throws a single
 *  `"deserializeKeyPair: malformed JSON"` for any structural issue
 *  — invalid JSON, wrong shape, non-string fields, BigInt parse
 *  failure — so callers don't have to discriminate between the
 *  underlying parse / coercion errors. */
export function deserializeKeyPair(json: string): EdDSAKeyPair {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("deserializeKeyPair: malformed JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("deserializeKeyPair: malformed JSON");
  }
  const obj = parsed as { privateKey?: unknown; publicKey?: unknown };
  if (
    typeof obj.privateKey !== "string" ||
    !Array.isArray(obj.publicKey) ||
    obj.publicKey.length !== 2 ||
    typeof obj.publicKey[0] !== "string" ||
    typeof obj.publicKey[1] !== "string"
  ) {
    throw new Error("deserializeKeyPair: malformed JSON");
  }
  try {
    return {
      privateKey: ethers.getBytes(obj.privateKey),
      publicKey: [BigInt(obj.publicKey[0]), BigInt(obj.publicKey[1])],
    };
  } catch {
    throw new Error("deserializeKeyPair: malformed JSON");
  }
}
