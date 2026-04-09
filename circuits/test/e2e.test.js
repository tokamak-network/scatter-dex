/**
 * E2E test: real ZK proof generation + on-chain verification
 *
 * Flow: deposit commitment → withdraw with real Groth16 proof
 */

const { buildPoseidon } = require("circomlibjs");
const snarkjs = require("snarkjs");
const path = require("path");
const { execSync } = require("child_process");

const BUILD_DIR = path.join(__dirname, "../build");
const WITHDRAW_WASM = path.join(BUILD_DIR, "withdraw_js/withdraw.wasm");
const WITHDRAW_ZKEY = path.join(BUILD_DIR, "withdraw_final.zkey");
const WITHDRAW_VKEY = path.join(BUILD_DIR, "withdraw_vkey.json");

const CLAIM_WASM = path.join(BUILD_DIR, "claim_js/claim.wasm");
const CLAIM_ZKEY = path.join(BUILD_DIR, "claim_final.zkey");
const CLAIM_VKEY = path.join(BUILD_DIR, "claim_vkey.json");

const TREE_DEPTH = 20;
const CLAIMS_DEPTH = 4;

let poseidon, F;

function randomField() {
  const bytes = new Uint8Array(31);
  require("crypto").randomFillSync(bytes);
  let val = 0n;
  for (const b of bytes) val = (val << 8n) | BigInt(b);
  return val;
}

async function buildMerkleTree(leaves, depth) {
  const zeros = [0n];
  for (let i = 1; i <= depth; i++) {
    zeros.push(F.toObject(poseidon([zeros[i - 1], zeros[i - 1]])));
  }

  const size = 2 ** depth;
  const padded = [...leaves];
  while (padded.length < size) padded.push(0n);

  const layers = [padded];
  let cur = padded;
  for (let i = 0; i < depth; i++) {
    const next = [];
    for (let j = 0; j < cur.length; j += 2) {
      next.push(F.toObject(poseidon([cur[j], cur[j + 1]])));
    }
    layers.push(next);
    cur = next;
  }
  return { root: cur[0], layers };
}

function getMerkleProof(layers, idx) {
  const pathElements = [];
  const pathIndices = [];
  let index = idx;
  for (let i = 0; i < layers.length - 1; i++) {
    const isRight = index % 2;
    const sibling = isRight ? index - 1 : index + 1;
    pathElements.push(layers[i][sibling] ?? 0n);
    pathIndices.push(isRight);
    index = Math.floor(index / 2);
  }
  return { pathElements, pathIndices };
}

describe("ZK E2E Tests", () => {
  beforeAll(async () => {
    poseidon = await buildPoseidon();
    F = poseidon.F;
  }, 30000);

  test("Withdraw circuit: generate and verify proof", async () => {
    // Generate commitment note
    const ownerSecret = randomField();
    const token = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9"); // WETH addr
    const amount = BigInt("1000000000000000000"); // 1 ETH
    const salt = randomField();

    const commitment = F.toObject(poseidon([ownerSecret, token, amount, salt]));
    // [M4] Domain-separated escrow nullifier (tag = 0)
    const nullifierHash = F.toObject(poseidon([0n, ownerSecret, salt]));
    const tokenHash = F.toObject(poseidon([token]));

    // Build Merkle tree with this commitment
    const leafIndex = 0;
    const { root, layers } = await buildMerkleTree([commitment], TREE_DEPTH);
    const { pathElements, pathIndices } = getMerkleProof(layers, leafIndex);

    // Full withdrawal (no change)
    const withdrawAmount = amount;
    const recipient = BigInt("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    const relayer = 0n;
    const newSalt = randomField();

    const input = {
      root: root.toString(),
      nullifierHash: nullifierHash.toString(),
      newCommitment: "0", // full withdrawal
      tokenHash: tokenHash.toString(),
      withdrawAmount: withdrawAmount.toString(),
      recipient: recipient.toString(),
      relayer: relayer.toString(),
      ownerSecret: ownerSecret.toString(),
      token: token.toString(),
      amount: amount.toString(),
      salt: salt.toString(),
      newSalt: newSalt.toString(),
      pathElements: pathElements.map(e => e.toString()),
      pathIndices: pathIndices.map(i => i.toString()),
    };

    // Generate proof
    console.time("withdraw proof generation");
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input, WITHDRAW_WASM, WITHDRAW_ZKEY
    );
    console.timeEnd("withdraw proof generation");

    // Verify proof off-chain
    const vkey = require(WITHDRAW_VKEY);
    const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    expect(valid).toBe(true);

    console.log("Withdraw proof verified! Public signals:", publicSignals.length);
  }, 60000);

  test("Withdraw circuit: partial withdrawal with change", async () => {
    const ownerSecret = randomField();
    const token = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
    const amount = BigInt("5000000000000000000"); // 5 ETH
    const salt = randomField();

    const commitment = F.toObject(poseidon([ownerSecret, token, amount, salt]));
    // [M4] Domain-separated escrow nullifier (tag = 0)
    const nullifierHash = F.toObject(poseidon([0n, ownerSecret, salt]));
    const tokenHash = F.toObject(poseidon([token]));

    const leafIndex = 0;
    const { root, layers } = await buildMerkleTree([commitment], TREE_DEPTH);
    const { pathElements, pathIndices } = getMerkleProof(layers, leafIndex);

    // Partial withdrawal: withdraw 2 ETH, keep 3 ETH as change
    const withdrawAmount = BigInt("2000000000000000000");
    const changeAmount = amount - withdrawAmount;
    const newSalt = randomField();
    const newCommitment = F.toObject(poseidon([ownerSecret, token, changeAmount, newSalt]));

    const recipient = BigInt("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");

    const input = {
      root: root.toString(),
      nullifierHash: nullifierHash.toString(),
      newCommitment: newCommitment.toString(),
      tokenHash: tokenHash.toString(),
      withdrawAmount: withdrawAmount.toString(),
      recipient: recipient.toString(),
      relayer: "0",
      ownerSecret: ownerSecret.toString(),
      token: token.toString(),
      amount: amount.toString(),
      salt: salt.toString(),
      newSalt: newSalt.toString(),
      pathElements: pathElements.map(e => e.toString()),
      pathIndices: pathIndices.map(i => i.toString()),
    };

    console.time("partial withdraw proof");
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input, WITHDRAW_WASM, WITHDRAW_ZKEY
    );
    console.timeEnd("partial withdraw proof");

    const vkey = require(WITHDRAW_VKEY);
    const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    expect(valid).toBe(true);

    console.log("Partial withdraw verified! Change commitment created.");
  }, 60000);

  test("Claim circuit: generate and verify proof", async () => {
    // Create claim leaf
    const secret = randomField();
    const recipient = BigInt("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    const token = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
    const amount = BigInt("500000000000000000"); // 0.5 ETH
    const releaseTime = BigInt(Math.floor(Date.now() / 1000));

    const leaf = F.toObject(poseidon([secret, recipient, token, amount, releaseTime]));
    const leafIndex = 0;
    // [M4] Domain-separated claim nullifier (tag = 2)
    const nullifier = F.toObject(poseidon([2n, secret, BigInt(leafIndex)]));

    // Build claims Merkle tree (depth 4, max 16 leaves)
    const { root: claimsRoot, layers } = await buildMerkleTree([leaf], CLAIMS_DEPTH);
    const { pathElements, pathIndices } = getMerkleProof(layers, leafIndex);

    const input = {
      claimsRoot: claimsRoot.toString(),
      nullifier: nullifier.toString(),
      amount: amount.toString(),
      token: token.toString(),
      recipient: recipient.toString(),
      releaseTime: releaseTime.toString(),
      secret: secret.toString(),
      leafIndex: leafIndex.toString(),
      pathElements: pathElements.map(e => e.toString()),
      pathIndices: pathIndices.map(i => i.toString()),
    };

    console.time("claim proof generation");
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input, CLAIM_WASM, CLAIM_ZKEY
    );
    console.timeEnd("claim proof generation");

    const vkey = require(CLAIM_VKEY);
    const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    expect(valid).toBe(true);

    console.log("Claim proof verified! Public signals:", publicSignals.length);
  }, 60000);

  test("Claim circuit: multiple claims from same root", async () => {
    const token = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
    const releaseTime = BigInt(Math.floor(Date.now() / 1000));

    // Create 3 claim leaves
    const claims = [];
    for (let i = 0; i < 3; i++) {
      const secret = randomField();
      const recipient = BigInt("0x" + (i + 1).toString(16).padStart(40, "0"));
      const amount = BigInt((i + 1) * 100) * BigInt("1000000000000000000");
      const leaf = F.toObject(poseidon([secret, recipient, token, amount, releaseTime]));
      claims.push({ secret, recipient, token, amount, releaseTime, leaf });
    }

    const leaves = claims.map(c => c.leaf);
    const { root: claimsRoot, layers } = await buildMerkleTree(leaves, CLAIMS_DEPTH);

    // Verify each claim independently
    for (let i = 0; i < claims.length; i++) {
      const c = claims[i];
      const { pathElements, pathIndices } = getMerkleProof(layers, i);
      // [M4] Domain-separated claim nullifier (tag = 2)
      const nullifier = F.toObject(poseidon([2n, c.secret, BigInt(i)]));

      const input = {
        claimsRoot: claimsRoot.toString(),
        nullifier: nullifier.toString(),
        amount: c.amount.toString(),
        token: c.token.toString(),
        recipient: c.recipient.toString(),
        releaseTime: c.releaseTime.toString(),
        secret: c.secret.toString(),
        leafIndex: i.toString(),
        pathElements: pathElements.map(e => e.toString()),
        pathIndices: pathIndices.map(j => j.toString()),
      };

      const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        input, CLAIM_WASM, CLAIM_ZKEY
      );
      const vkey = require(CLAIM_VKEY);
      const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
      expect(valid).toBe(true);
    }

    console.log("All 3 claims from same root verified independently!");
  }, 120000);
});
