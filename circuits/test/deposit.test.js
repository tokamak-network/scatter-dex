/**
 * Deposit circuit unit tests
 *
 * [issue #128] Verifies the v2 binding circuit:
 *   commitment === Poseidon(
 *     TAG_COMMITMENT_V2, secret, token, amount, salt,
 *     pubKeyAx, pubKeyAy
 *   )
 *
 * This circuit prevents both:
 *   1. Pool-drain — 1 wei deposit with a commitment claiming an
 *      arbitrarily large balance
 *      (contracts/test/PoolDrainExploit.t.sol)
 *   2. Swap-the-key — a leaked `(secret, salt, balance)` signed
 *      with an attacker's BabyJub key
 *      (PR #127 Copilot HIGH → issue #128)
 *
 * Deposit also runs BabyCheck + identity rejection on the pubkey so
 * downstream circuits can rely on a well-formed pubkey invariant.
 */

const { buildPoseidon, buildEddsa, buildBabyjub } = require("circomlibjs");
const snarkjs = require("snarkjs");
const path = require("path");
const crypto = require("crypto");

const BUILD_DIR = path.join(__dirname, "../build");
const DEPOSIT_WASM = path.join(BUILD_DIR, "deposit_js/deposit.wasm");
const DEPOSIT_ZKEY = path.join(BUILD_DIR, "deposit_final.zkey");
const DEPOSIT_VKEY = path.join(BUILD_DIR, "deposit_vkey.json");

// Must match circuits/tags.circom
const TAG_COMMITMENT_V2 = 3n;

let poseidon, F, eddsa, babyJub;

function randomField() {
  const bytes = new Uint8Array(31);
  crypto.randomFillSync(bytes);
  let val = 0n;
  for (const b of bytes) val = (val << 8n) | BigInt(b);
  return val;
}

function randomBabyJubKeypair() {
  const privKey = crypto.randomBytes(32);
  const pub = eddsa.prv2pub(privKey);
  return {
    privKey,
    pubKeyAx: babyJub.F.toObject(pub[0]),
    pubKeyAy: babyJub.F.toObject(pub[1]),
  };
}

function computeCommitmentV2({ secret, token, amount, salt, pubKeyAx, pubKeyAy }) {
  return F.toObject(
    poseidon([TAG_COMMITMENT_V2, secret, token, amount, salt, pubKeyAx, pubKeyAy])
  );
}

async function generateDepositProof({ secret, token, amount, salt, pubKeyAx, pubKeyAy }) {
  const commitment = computeCommitmentV2({ secret, token, amount, salt, pubKeyAx, pubKeyAy });

  const input = {
    commitment: commitment.toString(),
    token: token.toString(),
    amount: amount.toString(),
    secret: secret.toString(),
    salt: salt.toString(),
    pubKeyAx: pubKeyAx.toString(),
    pubKeyAy: pubKeyAy.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    DEPOSIT_WASM,
    DEPOSIT_ZKEY,
  );

  return { proof, publicSignals, commitment };
}

describe("Deposit circuit (v2 — commitment binds BabyJub pubkey)", () => {
  beforeAll(async () => {
    poseidon = await buildPoseidon();
    F = poseidon.F;
    eddsa = await buildEddsa();
    babyJub = await buildBabyjub();
  }, 30000);

  test("happy path: valid commitment proof verifies", async () => {
    const secret = randomField();
    const salt = randomField();
    const token = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
    const amount = 100n * 10n ** 18n;
    const { pubKeyAx, pubKeyAy } = randomBabyJubKeypair();

    const { proof, publicSignals, commitment } = await generateDepositProof({
      secret, token, amount, salt, pubKeyAx, pubKeyAy,
    });

    // Public signals order matches `component main {public [...]}`
    expect(publicSignals[0]).toBe(commitment.toString());
    expect(publicSignals[1]).toBe(token.toString());
    expect(publicSignals[2]).toBe(amount.toString());

    const vkey = require(DEPOSIT_VKEY);
    const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    expect(ok).toBe(true);
  }, 30000);

  test("commitment tied to amount: cannot reuse proof with different amount", async () => {
    const secret = randomField();
    const salt = randomField();
    const token = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
    const honestAmount = 1n; // 1 wei
    const { pubKeyAx, pubKeyAy } = randomBabyJubKeypair();

    const { proof, publicSignals } = await generateDepositProof({
      secret, token, amount: honestAmount, salt, pubKeyAx, pubKeyAy,
    });

    // Attacker tampers with publicSignals[2] (amount)
    const tamperedSignals = [...publicSignals];
    tamperedSignals[2] = (10n ** 30n).toString();

    const vkey = require(DEPOSIT_VKEY);
    expect(await snarkjs.groth16.verify(vkey, tamperedSignals, proof)).toBe(false);
  }, 30000);

  test("commitment tied to token: cannot reuse proof with different token", async () => {
    const secret = randomField();
    const salt = randomField();
    const tokenA = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
    const amount = 50n * 10n ** 18n;
    const { pubKeyAx, pubKeyAy } = randomBabyJubKeypair();

    const { proof, publicSignals } = await generateDepositProof({
      secret, token: tokenA, amount, salt, pubKeyAx, pubKeyAy,
    });

    const tamperedSignals = [...publicSignals];
    tamperedSignals[1] = BigInt("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48").toString();

    const vkey = require(DEPOSIT_VKEY);
    expect(await snarkjs.groth16.verify(vkey, tamperedSignals, proof)).toBe(false);
  }, 30000);

  test("malformed witness: mismatched commitment fails witness generation", async () => {
    const secret = randomField();
    const salt = randomField();
    const token = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
    const amount = 100n * 10n ** 18n;
    const { pubKeyAx, pubKeyAy } = randomBabyJubKeypair();
    const wrongCommitment = randomField();

    const input = {
      commitment: wrongCommitment.toString(),
      token: token.toString(),
      amount: amount.toString(),
      secret: secret.toString(),
      salt: salt.toString(),
      pubKeyAx: pubKeyAx.toString(),
      pubKeyAy: pubKeyAy.toString(),
    };

    await expect(
      snarkjs.groth16.fullProve(input, DEPOSIT_WASM, DEPOSIT_ZKEY),
    ).rejects.toThrow(); // commitment === Poseidon(...) violated
  }, 30000);

  // [issue #128] Hardening check — deposit rejects off-curve pubkeys
  // so a later spend can never hit EdDSAPoseidonVerifier on a point
  // that isn't on BabyJub.
  test("rejects off-curve pubkey (BabyCheck fails)", async () => {
    const secret = randomField();
    const salt = randomField();
    const token = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
    const amount = 50n * 10n ** 18n;

    // (1, 1) is almost certainly NOT on the BabyJub curve.
    const pubKeyAx = 1n;
    const pubKeyAy = 1n;
    const commitment = computeCommitmentV2({
      secret, token, amount, salt, pubKeyAx, pubKeyAy,
    });

    await expect(
      snarkjs.groth16.fullProve(
        {
          commitment: commitment.toString(),
          token: token.toString(),
          amount: amount.toString(),
          secret: secret.toString(),
          salt: salt.toString(),
          pubKeyAx: pubKeyAx.toString(),
          pubKeyAy: pubKeyAy.toString(),
        },
        DEPOSIT_WASM,
        DEPOSIT_ZKEY,
      ),
    ).rejects.toThrow();
  }, 30000);

  // [issue #128] Hardening check — deposit rejects the BabyJub identity
  // point (0, 1). EdDSA signatures over the identity point are trivially
  // forgeable, so we refuse to let any escrow be bound to it.
  test("rejects BabyJub identity point (0, 1)", async () => {
    const secret = randomField();
    const salt = randomField();
    const token = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
    const amount = 50n * 10n ** 18n;

    const pubKeyAx = 0n;
    const pubKeyAy = 1n;
    const commitment = computeCommitmentV2({
      secret, token, amount, salt, pubKeyAx, pubKeyAy,
    });

    await expect(
      snarkjs.groth16.fullProve(
        {
          commitment: commitment.toString(),
          token: token.toString(),
          amount: amount.toString(),
          secret: secret.toString(),
          salt: salt.toString(),
          pubKeyAx: pubKeyAx.toString(),
          pubKeyAy: pubKeyAy.toString(),
        },
        DEPOSIT_WASM,
        DEPOSIT_ZKEY,
      ),
    ).rejects.toThrow();
  }, 30000);

  // [issue #128 PR #129 Copilot review] The other on-curve point with
  // x == 0 is (0, -1 mod p), which lives in BabyJub's cofactor-8
  // small-order subgroup. EdDSA over a small-order pubkey is broken
  // the same way the identity case is, so the deposit circuit's
  // `Ax != 0` check must reject it too. This test locks that invariant
  // in so a future refactor can't narrow the check down to "only
  // (0, 1)" without the test catching it.
  test("rejects BabyJub order-2 point (0, -1 mod p)", async () => {
    const secret = randomField();
    const salt = randomField();
    const token = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
    const amount = 50n * 10n ** 18n;

    // BN254 scalar field prime (the field BabyJub's coordinates live in).
    const BN254_FIELD =
      21888242871839275222246405745257275088548364400416034343698204186575808495617n;

    const pubKeyAx = 0n;
    const pubKeyAy = BN254_FIELD - 1n; // -1 mod p
    const commitment = computeCommitmentV2({
      secret, token, amount, salt, pubKeyAx, pubKeyAy,
    });

    await expect(
      snarkjs.groth16.fullProve(
        {
          commitment: commitment.toString(),
          token: token.toString(),
          amount: amount.toString(),
          secret: secret.toString(),
          salt: salt.toString(),
          pubKeyAx: pubKeyAx.toString(),
          pubKeyAy: pubKeyAy.toString(),
        },
        DEPOSIT_WASM,
        DEPOSIT_ZKEY,
      ),
    ).rejects.toThrow();
  }, 30000);
});
