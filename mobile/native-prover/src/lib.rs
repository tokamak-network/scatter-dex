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
}

crate::set_circom_circuits! {
    ("multiplier2_final.zkey", circom_prover::witness::WitnessFn::RustWitness(witness::multiplier2_witness)),
    ("authorize_final.zkey", circom_prover::witness::WitnessFn::RustWitness(witness::authorize_witness)),
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


// HALO2_TEMPLATE
halo2_stub!();

// NOIR_TEMPLATE
noir_stub!();

// GNARK_TEMPLATE
gnark_stub!();
