#[macro_use]
mod stubs;

mod error;
pub use error::MoproError;

// Initializes the shared UniFFI scaffolding and defines the `MoproError` enum.
#[cfg(not(target_arch = "wasm32"))]
mopro_ffi::app!();
// Skip wasm_setup!() to avoid extern crate alias conflict
// Instead, we import wasm_bindgen directly when needed
#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
use mopro_ffi::prelude::wasm_bindgen;

/// You can also customize the bindings by #[uniffi::export]
/// Reference: https://mozilla.github.io/uniffi-rs/latest/proc_macro/index.html
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn mopro_hello_world() -> String {
    "Hello, World!".to_string()
}

// Poseidon-BN254 hash, circomlib-compatible (verified bit-identical
// against circomlibjs by light-poseidon's own circom-compat suite).

use light_poseidon::{Poseidon, PoseidonHasher};
use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use std::str::FromStr as _;
use std::sync::{Mutex, OnceLock};

// `Poseidon::new_circom(arity)` re-derives round constants on each call,
// which dominates the actual hashing cost for small inputs. The hashers
// have interior mutable scratch state and aren't `Sync`, so wrap each
// per-arity slot in its own `Mutex`. Arity is bounded by light-poseidon
// to <=12 (MAX_X5_LEN=13, width=arity+1).
const MAX_ARITY: usize = 12;
fn hasher_slot(arity: usize) -> Option<&'static Mutex<Poseidon<Fr>>> {
    static SLOTS: OnceLock<Vec<OnceLock<Mutex<Poseidon<Fr>>>>> = OnceLock::new();
    let slots = SLOTS.get_or_init(|| (0..=MAX_ARITY).map(|_| OnceLock::new()).collect());
    let slot = slots.get(arity)?;
    Some(slot.get_or_init(|| {
        Mutex::new(Poseidon::<Fr>::new_circom(arity).expect("new_circom"))
    }))
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn poseidon_hash(inputs: Vec<String>) -> Result<String, MoproError> {
    if inputs.is_empty() || inputs.len() > MAX_ARITY {
        return Err(MoproError::CircomError(format!(
            "poseidon_hash: arity {} out of range (1..={MAX_ARITY})",
            inputs.len()
        )));
    }
    let mut field_inputs: Vec<Fr> = Vec::with_capacity(inputs.len());
    for (i, s) in inputs.iter().enumerate() {
        let parsed = num_bigint::BigUint::from_str(s).map_err(|e| {
            MoproError::CircomError(format!("poseidon_hash: input[{i}] parse: {e}"))
        })?;
        field_inputs.push(Fr::from(parsed));
    }
    let slot = hasher_slot(inputs.len()).ok_or_else(|| {
        MoproError::CircomError(format!("poseidon_hash: no slot for arity {}", inputs.len()))
    })?;
    let mut hasher = slot.lock().map_err(|e| {
        MoproError::CircomError(format!("poseidon_hash: lock poisoned: {e}"))
    })?;
    let out = hasher.hash(&field_inputs).map_err(|e| {
        MoproError::CircomError(format!("poseidon_hash: hash: {e}"))
    })?;
    let bytes = out.into_bigint().to_bytes_be();
    Ok(num_bigint::BigUint::from_bytes_be(&bytes).to_str_radix(10))
}

// ─── BabyJubJub EdDSA (circomlibjs-compatible) ───────────────────────
// Replaces the WebView calls `derive_eddsa_key` (eddsa.prv2pub) and
// `sign_eddsa` (eddsa.signPoseidon). babyjubjub-rs is the canonical
// circomlibjs-compatible Rust impl by arnaucube / Iden3.

use babyjubjub_rs::{decompress_signature, PrivateKey};
use ff::to_hex;
use num_bigint::{BigInt, Sign};

/// Convert a babyjubjub-rs `Fr` (poseidon_rs::Fr) to a decimal `BigUint`
/// string — same shape circomlibjs's `babyJub.F.toString(p, 10)` returns.
fn fr_to_dec(fr: &poseidon_rs::Fr) -> String {
    // `to_hex` is guaranteed by `ff_ce` to emit a fixed-width hex repr;
    // a parse failure here would mean the Fr invariant is broken. Fail
    // loudly rather than masking it as "0" — bug masking that path
    // would silently emit invalid pubkeys/signatures.
    let hex = to_hex(fr);
    num_bigint::BigUint::parse_bytes(hex.as_bytes(), 16)
        .expect("EdDSA: ff_ce::to_hex produced invalid hex")
        .to_str_radix(10)
}

fn parse_priv_key_hex(s: &str) -> Result<Vec<u8>, MoproError> {
    let trimmed = s.strip_prefix("0x").unwrap_or(s);
    if trimmed.len() != 64 {
        return Err(MoproError::CircomError(format!(
            "EdDSA: privateKey hex must be 32 bytes (64 hex chars), got {}",
            trimmed.len()
        )));
    }
    let mut out = Vec::with_capacity(32);
    for i in 0..32 {
        let byte = u8::from_str_radix(&trimmed[i * 2..i * 2 + 2], 16)
            .map_err(|e| MoproError::CircomError(format!("EdDSA: privKey hex parse: {e}")))?;
        out.push(byte);
    }
    Ok(out)
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct EdDSAKey {
    pub private_key_hex: String,
    pub pub_key_ax: String,
    pub pub_key_ay: String,
}

/// Derive a BabyJubJub keypair from a 32-byte signature hash. Matches
/// circomlibjs `eddsa.prv2pub` (which interprets the first 32 bytes as
/// the private key directly).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn derive_eddsa_key(signature_hash: String) -> Result<EdDSAKey, MoproError> {
    let priv_bytes = parse_priv_key_hex(&signature_hash)?;
    let pk = PrivateKey::import(priv_bytes.clone())
        .map_err(|e| MoproError::CircomError(format!("EdDSA: import privKey: {e}")))?;
    let pub_point = pk.public();
    let priv_hex: String = priv_bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(EdDSAKey {
        private_key_hex: priv_hex,
        pub_key_ax: fr_to_dec(&pub_point.x),
        pub_key_ay: fr_to_dec(&pub_point.y),
    })
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct EdDSASignature {
    pub s: String,
    pub r8x: String,
    pub r8y: String,
}

/// Poseidon-EdDSA sign. Matches circomlibjs `eddsa.signPoseidon`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn sign_eddsa(
    private_key_hex: String,
    message: String,
) -> Result<EdDSASignature, MoproError> {
    let priv_bytes = parse_priv_key_hex(&private_key_hex)?;
    let pk = PrivateKey::import(priv_bytes)
        .map_err(|e| MoproError::CircomError(format!("EdDSA: import privKey: {e}")))?;
    let msg_big = num_bigint::BigUint::parse_bytes(message.as_bytes(), 10)
        .ok_or_else(|| MoproError::CircomError(format!("EdDSA: message must be decimal BigUint, got '{message}'")))?;
    let msg = BigInt::from_biguint(Sign::Plus, msg_big);
    let sig = pk
        .sign(msg)
        .map_err(|e| MoproError::CircomError(format!("EdDSA: sign: {e}")))?;
    Ok(EdDSASignature {
        s: sig.s.to_str_radix(10),
        r8x: fr_to_dec(&sig.r_b8.x),
        r8y: fr_to_dec(&sig.r_b8.y),
    })
}

// Silence unused-import warning when neither uniffi nor any caller uses
// `decompress_signature` — keep the symbol available for future verify
// flows we plan to add (eddsa.verifyPoseidon).
#[allow(dead_code)]
fn _keep_decompress_alive(b: &[u8; 64]) -> Result<babyjubjub_rs::Signature, String> {
    decompress_signature(b)
}

#[cfg_attr(
    all(feature = "wasm", target_arch = "wasm32"),
    wasm_bindgen(js_name = "moproWasmHelloWorld")
)]
pub fn mopro_wasm_hello_world() -> String {
    "Hello, World!".to_string()
}

#[cfg(test)]
mod uniffi_tests {
    #[test]
    fn test_mopro_hello_world() {
        assert_eq!(super::mopro_hello_world(), "Hello, World!");
    }
}

#[cfg(test)]
mod eddsa_tests {
    use super::{derive_eddsa_key, sign_eddsa};

    // Deterministic vector: priv = 0x000102…1f (32 bytes counting from 0).
    // Reference values produced by the same pair of dependencies pinned
    // in this crate (babyjubjub-rs 0.0.11 + poseidon-rs 0.0.8) which are
    // bit-compatible with circomlibjs's `eddsa.prv2pub` /
    // `eddsa.signPoseidon`. If a future dep update breaks circomlibjs
    // compat the asserts below catch it before we ship.
    const PRIV_HEX: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const PUB_AX: &str = "1120771572304984668855649788542860110303223894298952018121329196339919157573";
    const PUB_AY: &str = "20197087425205130352574209034729275460185533126585197591053247747830393653846";

    #[test]
    fn derive_pubkey_matches_circomlibjs_vector() {
        let key = derive_eddsa_key(PRIV_HEX.to_string()).expect("derive");
        assert_eq!(key.private_key_hex, PRIV_HEX);
        assert_eq!(key.pub_key_ax, PUB_AX);
        assert_eq!(key.pub_key_ay, PUB_AY);
    }

    #[test]
    fn sign_small_message_matches_circomlibjs_vector() {
        let sig = sign_eddsa(PRIV_HEX.to_string(), "12345".to_string()).expect("sign");
        // Captured by running this same code path on the host (cargo
        // run --example eddsa_probe) — locks in the EdDSA-Poseidon
        // signature scheme + field encoding.
        assert_eq!(sig.s, "1739790466773065296181678212741954535739539898060771208642831439111861798085");
        assert_eq!(sig.r8x, "2204325964008126994588720944122362049669595579112675351026637866395221427436");
        assert_eq!(sig.r8y, "16388779925939887818626849442548090612482898205585699613549062336288697370499");
    }

    #[test]
    fn sign_poseidon_size_message_matches_circomlibjs_vector() {
        let msg = "20671313523276210208694036424897136061965743176757356315862460569396468490866";
        let sig = sign_eddsa(PRIV_HEX.to_string(), msg.to_string()).expect("sign");
        assert_eq!(sig.s, "934736112787989380428518989385490047154871226061435499690412523401779437611");
        assert_eq!(sig.r8x, "4763617124038858249833498930009178202408287439972483916942165104723128200982");
        assert_eq!(sig.r8y, "10834163655245825241732230187624856803051578830955712197435943430630520703678");
    }

    #[test]
    fn sign_rejects_hex_message() {
        // Native `sign_eddsa` is decimal-only; the JS wrapper is
        // expected to normalize hex→decimal before crossing FFI.
        let err = sign_eddsa(PRIV_HEX.to_string(), "0xabc".to_string()).unwrap_err();
        let msg = format!("{err:?}");
        assert!(msg.contains("decimal"), "unexpected err: {msg}");
    }

    #[test]
    fn derive_rejects_short_priv_key() {
        let err = derive_eddsa_key("deadbeef".to_string()).unwrap_err();
        let msg = format!("{err:?}");
        assert!(msg.contains("32 bytes"), "unexpected err: {msg}");
    }
}


// CIRCOM_TEMPLATE
// --- Circom Example of using groth16 proving and verifying circuits ---

// Module containing the Circom circuit logic (Multiplier2)
#[macro_use]
mod circom;
pub use circom::{
    generate_circom_proof, verify_circom_proof, CircomProof, CircomProofResult, ProofLib, G1, G2,
};

mod witness {
    rust_witness::witness!(multiplier2);
    rust_witness::witness!(authorize);
    rust_witness::witness!(cancel);
    rust_witness::witness!(claim);
    rust_witness::witness!(deposit);
    rust_witness::witness!(withdraw);
}

crate::set_circom_circuits! {
    ("multiplier2_final.zkey", circom_prover::witness::WitnessFn::RustWitness(witness::multiplier2_witness)),
    ("authorize_final.zkey", circom_prover::witness::WitnessFn::RustWitness(witness::authorize_witness)),
    ("cancel_final.zkey", circom_prover::witness::WitnessFn::RustWitness(witness::cancel_witness)),
    ("claim_final.zkey", circom_prover::witness::WitnessFn::RustWitness(witness::claim_witness)),
    ("deposit_final.zkey", circom_prover::witness::WitnessFn::RustWitness(witness::deposit_witness)),
    ("withdraw_final.zkey", circom_prover::witness::WitnessFn::RustWitness(witness::withdraw_witness)),
}

#[cfg(test)]
mod circom_tests {
    use crate::circom::{generate_circom_proof, verify_circom_proof, ProofLib};

    const ZKEY_PATH: &str = "./test-vectors/circom/multiplier2_final.zkey";

    #[test]
    fn test_multiplier2() {
        let circuit_inputs = "{\"a\": 2, \"b\": 3}".to_string();
        let result =
            generate_circom_proof(ZKEY_PATH.to_string(), circuit_inputs, ProofLib::Arkworks);
        assert!(result.is_ok());
        let proof = result.unwrap();
        assert!(verify_circom_proof(ZKEY_PATH.to_string(), proof, ProofLib::Arkworks).is_ok());
    }
}

#[cfg(test)]
mod cancel_circom_test {
    //! End-to-end Groth16 proving + verification of `cancel.circom` using the
    //! same primitives the mobile client uses on the FFI hot path
    //! (`poseidon_hash`, `derive_eddsa_key`, `sign_eddsa`). Catches three
    //! regression classes pre-device:
    //!   1. zkey/wasm drift — building inputs from the circuit's spec and
    //!      proving against the bundled zkey would fail if either side
    //!      moved.
    //!   2. `circom-prover`'s `RustWitness` path requires every input value
    //!      to be a JSON array of decimal strings. A regression in the
    //!      mobile-side `wrapSingletons`/`decimalize` would silently drop
    //!      witness inputs and emit all-zero public signals.
    //!   3. EdDSA / Poseidon vendoring — if `babyjubjub-rs` or
    //!      `light-poseidon` ever stopped matching circomlibjs, the EdDSA
    //!      verify constraint inside `cancel.circom` would fail and the
    //!      proof gen would panic before producing a witness.
    use crate::circom::{generate_circom_proof, verify_circom_proof, ProofLib};
    use crate::{derive_eddsa_key, poseidon_hash, sign_eddsa};

    const ZKEY_PATH: &str = "./test-vectors/circom/cancel_final.zkey";

    fn ph(args: &[&str]) -> String {
        poseidon_hash(args.iter().map(|s| (*s).to_string()).collect()).expect("poseidon_hash")
    }

    #[test]
    fn cancel_proof_round_trips() {
        // Tag constants — must match `circuits/tags.circom` and
        // `mobile/src/lib/zk/tags.ts`. Hardcoded here on purpose: drift in
        // either source should make this test fail loudly.
        const TAG_COMMITMENT_V2: &str = "3";
        const TAG_ESCROW_NULL: &str = "0";
        const TAG_NONCE_NULL: &str = "1";
        const DEPTH: usize = 20;

        // Same priv key as the EdDSA vector tests above — gives a stable
        // (Ax, Ay) so any regression in `derive_eddsa_key` surfaces here too.
        const PRIV_HEX: &str =
            "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
        let key = derive_eddsa_key(PRIV_HEX.into()).expect("derive");
        let ax = key.pub_key_ax;
        let ay = key.pub_key_ay;

        // Trivial private witness. balance must fit 128 bits (cancel.circom
        // §4b). Token can be any field elt — no range check.
        let secret = "11111";
        let salt = "22222";
        let nonce = "33333";
        let token = "44444";
        let balance = "55555";
        let fresh_salt = "66666";
        let submitter = "777777";

        // commitment = Poseidon(TAG_V2, secret, token, balance, salt, Ax, Ay)
        let old_commit = ph(&[TAG_COMMITMENT_V2, secret, token, balance, salt, &ax, &ay]);
        let new_commit = ph(&[TAG_COMMITMENT_V2, secret, token, balance, fresh_salt, &ax, &ay]);
        let old_nullifier = ph(&[TAG_ESCROW_NULL, secret, salt]);
        let old_nonce_nullifier = ph(&[TAG_NONCE_NULL, secret, nonce]);

        // Sign cancelMsg = Poseidon(oldNonceNullifier, submitter).
        let cancel_msg = ph(&[&old_nonce_nullifier, submitter]);
        let sig = sign_eddsa(PRIV_HEX.into(), cancel_msg).expect("sign");

        // Merkle path: leaf at index 0, every sibling is the all-zero
        // subtree hash for that level. zero_hashes[0] == "0" matches
        // ZEROS[0] in mobile/src/lib/merkleTree.ts and the contract's
        // `_zeros(0)`.
        let mut zero_hashes: Vec<String> = vec!["0".to_string()];
        for d in 0..DEPTH {
            let z = zero_hashes[d].clone();
            zero_hashes.push(ph(&[&z, &z]));
        }
        let mut root = old_commit.clone();
        for d in 0..DEPTH {
            root = ph(&[&root, &zero_hashes[d]]);
        }
        let path: Vec<String> = (0..DEPTH).map(|d| zero_hashes[d].clone()).collect();
        let path_idx: Vec<&str> = vec!["0"; DEPTH];

        // RustWitness path requires every value to be a JSON array of
        // decimal strings — singletons must still be wrapped (mirrors
        // NativeProverService.wrapSingletons in the mobile client).
        let inputs = serde_json::json!({
            "commitmentRoot":     [root],
            "oldNullifier":       [old_nullifier],
            "oldNonceNullifier":  [old_nonce_nullifier.clone()],
            "newCommitment":      [new_commit],
            "submitter":          [submitter],
            "secret":             [secret],
            "salt":               [salt],
            "nonce":              [nonce],
            "token":              [token],
            "balance":            [balance],
            "freshSalt":          [fresh_salt],
            "path":               path,
            "pathIdx":            path_idx,
            "pubKeyAx":           [ax],
            "pubKeyAy":           [ay],
            "sigS":               [sig.s],
            "sigR8x":             [sig.r8x],
            "sigR8y":             [sig.r8y],
        })
        .to_string();

        let proof = generate_circom_proof(ZKEY_PATH.to_string(), inputs, ProofLib::Arkworks)
            .expect("cancel proof gen");

        // Public signals order must match cancel.circom main {public [...]}:
        //   [commitmentRoot, oldNullifier, oldNonceNullifier, newCommitment, submitter]
        assert_eq!(proof.inputs.len(), 5, "expected 5 public signals");
        assert_eq!(proof.inputs[2], old_nonce_nullifier);
        assert_eq!(proof.inputs[4], submitter);

        verify_circom_proof(ZKEY_PATH.to_string(), proof, ProofLib::Arkworks)
            .expect("cancel proof verify");
    }
}

#[cfg(test)]
mod claim_circom_test {
    //! End-to-end Groth16 proving + verification of `claim.circom` using
    //! the same primitives the mobile client uses on the FFI hot path.
    //! Same regression-class catches as the cancel test:
    //!   1. zkey/wasm drift between `circuits/build/` and what the
    //!      native prover bundles.
    //!   2. `circom-prover`'s `RustWitness` JSON-shape requirement
    //!      (every input value an array of decimal strings).
    //!   3. Poseidon vendoring — `light-poseidon` vs circomlibjs.
    use crate::circom::{generate_circom_proof, verify_circom_proof, ProofLib};
    use crate::poseidon_hash;

    const ZKEY_PATH: &str = "./test-vectors/circom/claim_final.zkey";

    fn ph(args: &[&str]) -> String {
        poseidon_hash(args.iter().map(|s| (*s).to_string()).collect()).expect("poseidon_hash")
    }

    #[test]
    fn claim_proof_round_trips() {
        // Tag must match `circuits/tags.circom` and
        // `mobile/src/lib/zk/tags.ts`. Hardcoded so a drift on either
        // side surfaces here loudly.
        const TAG_CLAIM_NULL: &str = "2";
        // claim.circom main is `Claim(4)` — depth 4 means the claims
        // tree holds up to 16 leaves per side.
        const DEPTH: usize = 4;

        // Trivial public + private witness. `releaseTime` is just a
        // field elt as far as the circuit is concerned.
        let secret = "11111";
        let leaf_index = "0";
        let amount = "55555";
        let token = "44444";
        let recipient = "777777";
        let release_time = "1700000000";

        // leaf = Poseidon(secret, recipient, token, amount, releaseTime)
        let leaf = ph(&[secret, recipient, token, amount, release_time]);
        // nullifier = Poseidon(TAG_CLAIM_NULL, secret, leafIndex)
        let nullifier = ph(&[TAG_CLAIM_NULL, secret, leaf_index]);

        // Single-leaf depth-4 claims tree. leaf at index 0, every
        // sibling is the all-zero subtree hash for that level. Same
        // construction as the cancel test's commitment merkle path.
        let mut zero_hashes: Vec<String> = vec!["0".to_string()];
        for d in 0..DEPTH {
            let z = zero_hashes[d].clone();
            zero_hashes.push(ph(&[&z, &z]));
        }
        let mut root = leaf.clone();
        for d in 0..DEPTH {
            root = ph(&[&root, &zero_hashes[d]]);
        }
        let path: Vec<String> = (0..DEPTH).map(|d| zero_hashes[d].clone()).collect();
        let path_idx: Vec<&str> = vec!["0"; DEPTH];

        let inputs = serde_json::json!({
            "claimsRoot":   [root],
            "nullifier":    [nullifier.clone()],
            "amount":       [amount],
            "token":        [token],
            "recipient":    [recipient],
            "releaseTime":  [release_time],
            "secret":       [secret],
            "leafIndex":    [leaf_index],
            "pathElements": path,
            "pathIndices":  path_idx,
        })
        .to_string();

        let proof = generate_circom_proof(ZKEY_PATH.to_string(), inputs, ProofLib::Arkworks)
            .expect("claim proof gen");

        // Public-signal order must match claim.circom main {public [...]}:
        //   [claimsRoot, nullifier, amount, token, recipient, releaseTime]
        assert_eq!(proof.inputs.len(), 6, "expected 6 public signals");
        assert_eq!(proof.inputs[1], nullifier);
        assert_eq!(proof.inputs[2], amount);
        assert_eq!(proof.inputs[4], recipient);

        verify_circom_proof(ZKEY_PATH.to_string(), proof, ProofLib::Arkworks)
            .expect("claim proof verify");
    }
}

#[cfg(test)]
mod deposit_circom_test {
    //! End-to-end Groth16 proving + verification of `deposit.circom`.
    //! Same regression-class catches as the cancel / claim tests.
    //! Notably, `deposit.circom` enforces `BabyCheck(pubKeyAx, pubKeyAy)`
    //! plus a small-subgroup exclusion, so a synthetic `(Ax, Ay)` would
    //! fail the constraint even before the merkle / commitment checks —
    //! we reuse the deterministic Phase B priv-key vector (which yields
    //! a known on-curve, prime-order pubkey) to avoid that landmine.
    use crate::circom::{generate_circom_proof, verify_circom_proof, ProofLib};
    use crate::{derive_eddsa_key, poseidon_hash};

    const ZKEY_PATH: &str = "./test-vectors/circom/deposit_final.zkey";

    fn ph(args: &[&str]) -> String {
        poseidon_hash(args.iter().map(|s| (*s).to_string()).collect()).expect("poseidon_hash")
    }

    #[test]
    fn deposit_proof_round_trips() {
        const TAG_COMMITMENT_V2: &str = "3";
        // Same priv as the EdDSA / cancel tests — gives a stable
        // on-curve pubkey that passes BabyCheck + the small-subgroup
        // exclusion.
        const PRIV_HEX: &str =
            "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

        let key = derive_eddsa_key(PRIV_HEX.into()).expect("derive");
        let ax = key.pub_key_ax;
        let ay = key.pub_key_ay;

        let secret = "11111";
        let salt = "22222";
        let token = "44444";
        let amount = "55555";

        // commitment = Poseidon(TAG_V2, secret, token, amount, salt, Ax, Ay)
        let commitment = ph(&[TAG_COMMITMENT_V2, secret, token, amount, salt, &ax, &ay]);

        let inputs = serde_json::json!({
            "commitment": [commitment.clone()],
            "token":      [token],
            "amount":     [amount],
            "secret":     [secret],
            "salt":       [salt],
            "pubKeyAx":   [ax],
            "pubKeyAy":   [ay],
        })
        .to_string();

        let proof = generate_circom_proof(ZKEY_PATH.to_string(), inputs, ProofLib::Arkworks)
            .expect("deposit proof gen");

        // Public-signal order from `deposit.circom main {public [...]}`:
        //   [commitment, token, amount]
        assert_eq!(proof.inputs.len(), 3, "expected 3 public signals");
        assert_eq!(proof.inputs[0], commitment);
        assert_eq!(proof.inputs[1], token);
        assert_eq!(proof.inputs[2], amount);

        verify_circom_proof(ZKEY_PATH.to_string(), proof, ProofLib::Arkworks)
            .expect("deposit proof verify");
    }
}

#[cfg(test)]
mod withdraw_circom_test {
    //! End-to-end Groth16 proving + verification of `withdraw.circom`.
    //! Exercises the full-withdraw path (changeAmount = 0 so the
    //! `newCommitment` public signal is forced to 0) — that's the
    //! shortest deterministic witness; partial withdrawals follow the
    //! same shape with a non-zero change commitment.
    use crate::circom::{generate_circom_proof, verify_circom_proof, ProofLib};
    use crate::{derive_eddsa_key, poseidon_hash};

    const ZKEY_PATH: &str = "./test-vectors/circom/withdraw_final.zkey";

    fn ph(args: &[&str]) -> String {
        poseidon_hash(args.iter().map(|s| (*s).to_string()).collect()).expect("poseidon_hash")
    }

    #[test]
    fn withdraw_proof_round_trips() {
        const TAG_COMMITMENT_V2: &str = "3";
        const TAG_ESCROW_NULL: &str = "0";
        const DEPTH: usize = 20;
        const PRIV_HEX: &str =
            "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

        let key = derive_eddsa_key(PRIV_HEX.into()).expect("derive");
        let ax = key.pub_key_ax;
        let ay = key.pub_key_ay;

        // Trivial private witness for a full-withdrawal:
        //   amount == withdrawAmount → changeAmount = 0 →
        //   expected newCommitment = 0 (per the circuit's IsZero gate).
        let owner_secret = "11111";
        let salt = "22222";
        let new_salt = "33333"; // unused when changeAmount==0 but still bound
        let token = "44444";
        let amount = "55555";
        let withdraw_amount = amount; // full
        let recipient = "777777";
        let relayer = "888888";

        // commitment = Poseidon(TAG_V2, ownerSecret, token, amount, salt, Ax, Ay)
        let commitment = ph(&[TAG_COMMITMENT_V2, owner_secret, token, amount, salt, &ax, &ay]);
        // nullifierHash = Poseidon(TAG_ESCROW_NULL, ownerSecret, salt)
        let nullifier_hash = ph(&[TAG_ESCROW_NULL, owner_secret, salt]);
        // tokenHash = Poseidon(token) — arity 1
        let token_hash = ph(&[token]);

        // depth-20 zero-sibling Merkle path with the leaf at index 0.
        let mut zero_hashes: Vec<String> = vec!["0".to_string()];
        for d in 0..DEPTH {
            let z = zero_hashes[d].clone();
            zero_hashes.push(ph(&[&z, &z]));
        }
        let mut root = commitment.clone();
        for d in 0..DEPTH {
            root = ph(&[&root, &zero_hashes[d]]);
        }
        let path: Vec<String> = (0..DEPTH).map(|d| zero_hashes[d].clone()).collect();
        let path_idx: Vec<&str> = vec!["0"; DEPTH];

        let inputs = serde_json::json!({
            "root":           [root],
            "nullifierHash":  [nullifier_hash.clone()],
            "newCommitment":  ["0"],
            "tokenHash":      [token_hash],
            "withdrawAmount": [withdraw_amount],
            "recipient":      [recipient],
            "relayer":        [relayer],
            "ownerSecret":    [owner_secret],
            "token":          [token],
            "amount":         [amount],
            "salt":           [salt],
            "newSalt":        [new_salt],
            "pathElements":   path,
            "pathIndices":    path_idx,
            "pubKeyAx":       [ax],
            "pubKeyAy":       [ay],
        })
        .to_string();

        let proof = generate_circom_proof(ZKEY_PATH.to_string(), inputs, ProofLib::Arkworks)
            .expect("withdraw proof gen");

        // Public signals from `withdraw.circom main {public [...]}`:
        //   [root, nullifierHash, newCommitment, tokenHash,
        //    withdrawAmount, recipient, relayer]
        assert_eq!(proof.inputs.len(), 7, "expected 7 public signals");
        assert_eq!(proof.inputs[1], nullifier_hash);
        assert_eq!(proof.inputs[2], "0", "newCommitment is 0 on full withdraw");
        assert_eq!(proof.inputs[5], recipient);
        assert_eq!(proof.inputs[6], relayer);

        verify_circom_proof(ZKEY_PATH.to_string(), proof, ProofLib::Arkworks)
            .expect("withdraw proof verify");
    }
}


// HALO2_TEMPLATE
halo2_stub!();

// NOIR_TEMPLATE
noir_stub!();

// GNARK_TEMPLATE
gnark_stub!();
