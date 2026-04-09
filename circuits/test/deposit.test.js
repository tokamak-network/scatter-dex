/**
 * Deposit circuit unit tests
 *
 * Verifies the deposit binding circuit:
 *   commitment === Poseidon(secret, token, amount, salt)
 *
 * This circuit prevents the pool-drain vulnerability where a user can deposit
 * 1 wei but submit a commitment claiming an arbitrary balance.
 * See: contracts/test/PoolDrainExploit.t.sol
 */

const { buildPoseidon } = require("circomlibjs");
const snarkjs = require("snarkjs");
const path = require("path");

const BUILD_DIR = path.join(__dirname, "../build");
const DEPOSIT_WASM = path.join(BUILD_DIR, "deposit_js/deposit.wasm");
const DEPOSIT_ZKEY = path.join(BUILD_DIR, "deposit_final.zkey");
const DEPOSIT_VKEY = path.join(BUILD_DIR, "deposit_vkey.json");

let poseidon, F;

function randomField() {
  const bytes = new Uint8Array(31);
  require("crypto").randomFillSync(bytes);
  let val = 0n;
  for (const b of bytes) val = (val << 8n) | BigInt(b);
  return val;
}

async function generateDepositProof({ secret, token, amount, salt }) {
  const commitment = F.toObject(poseidon([secret, token, amount, salt]));

  const input = {
    commitment: commitment.toString(),
    token: token.toString(),
    amount: amount.toString(),
    secret: secret.toString(),
    salt: salt.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    DEPOSIT_WASM,
    DEPOSIT_ZKEY,
  );

  return { proof, publicSignals, commitment };
}

describe("Deposit circuit", () => {
  beforeAll(async () => {
    poseidon = await buildPoseidon();
    F = poseidon.F;
  }, 30000);

  test("happy path: valid commitment proof verifies", async () => {
    const secret = randomField();
    const salt = randomField();
    const token = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
    const amount = 100n * 10n ** 18n;

    const { proof, publicSignals, commitment } = await generateDepositProof({
      secret,
      token,
      amount,
      salt,
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
    // Honest deposit
    const secret = randomField();
    const salt = randomField();
    const token = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
    const honestAmount = 1n; // 1 wei

    const { proof, publicSignals } = await generateDepositProof({
      secret,
      token,
      amount: honestAmount,
      salt,
    });

    // Attacker tampers with publicSignals[2] (amount) to claim a huge balance
    const tamperedSignals = [...publicSignals];
    tamperedSignals[2] = (10n ** 30n).toString();

    const vkey = require(DEPOSIT_VKEY);
    const okTampered = await snarkjs.groth16.verify(vkey, tamperedSignals, proof);
    expect(okTampered).toBe(false); // ← attack rejected
  }, 30000);

  test("commitment tied to token: cannot reuse proof with different token", async () => {
    const secret = randomField();
    const salt = randomField();
    const tokenA = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
    const amount = 50n * 10n ** 18n;

    const { proof, publicSignals } = await generateDepositProof({
      secret,
      token: tokenA,
      amount,
      salt,
    });

    // Tamper token to a different ERC20
    const tamperedSignals = [...publicSignals];
    tamperedSignals[1] = BigInt("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48").toString();

    const vkey = require(DEPOSIT_VKEY);
    const ok = await snarkjs.groth16.verify(vkey, tamperedSignals, proof);
    expect(ok).toBe(false);
  }, 30000);

  test("malformed witness: mismatched commitment fails witness generation", async () => {
    const secret = randomField();
    const salt = randomField();
    const token = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
    const amount = 100n * 10n ** 18n;

    // Compute the correct commitment but pretend it's a different value
    const wrongCommitment = randomField();

    const input = {
      commitment: wrongCommitment.toString(),
      token: token.toString(),
      amount: amount.toString(),
      secret: secret.toString(),
      salt: salt.toString(),
    };

    await expect(
      snarkjs.groth16.fullProve(input, DEPOSIT_WASM, DEPOSIT_ZKEY),
    ).rejects.toThrow(); // constraint commitment === Poseidon(...) violated
  }, 30000);
});
