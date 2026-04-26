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
