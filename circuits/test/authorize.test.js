/**
 * Half-proof PoC — authorize.circom unit tests
 *
 * Verifies that an end-user can produce a self-contained authorization
 * proof for one side of a trade, with no relayer access to their secret,
 * salt, balance, or claim preimages.
 */

const { buildPoseidon, buildEddsa, buildBabyjub } = require("circomlibjs");
const snarkjs = require("snarkjs");
const path = require("path");
const crypto = require("crypto");

const BUILD_DIR = path.join(__dirname, "../build");
const WASM = path.join(BUILD_DIR, "authorize_js/authorize.wasm");
const ZKEY = path.join(BUILD_DIR, "authorize_final.zkey");
const VKEY_PATH = path.join(BUILD_DIR, "authorize_vkey.json");

const TREE_DEPTH = 20;
const CLAIMS_DEPTH = 4;
const MAX_CLAIMS = 16;

// ── Domain tags (must match circuits/tags.circom) ──
const TAG_ESCROW_NULL = 0n;
const TAG_NONCE_NULL = 1n;

let poseidon, F, eddsa, babyJub;

function randomField() {
  const bytes = new Uint8Array(31);
  crypto.randomFillSync(bytes);
  let val = 0n;
  for (const b of bytes) val = (val << 8n) | BigInt(b);
  return val;
}

async function buildMerkleTree(leaves, depth) {
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

/** Pad an array to MAX_CLAIMS with zero entries (so the circuit accepts it). */
function padClaims(claims) {
  const padded = [...claims];
  while (padded.length < MAX_CLAIMS) {
    padded.push({ secret: 0n, recipient: 0n, token: 0n, amount: 0n, releaseTime: 0n });
  }
  return padded;
}

/** Build a circuit input object for one happy-path order. */
async function buildAuthorizeInput({
  secret,
  salt,
  sellToken,
  balance,
  buyToken,
  sellAmount,
  buyAmount,
  maxFee,
  expiry,
  nonce,
  newSalt,
  claims,
  relayer,
  privKey,
}) {
  // Commitment + tree
  const commitment = F.toObject(poseidon([secret, sellToken, balance, salt]));
  const leafIndex = 0;
  const { root, layers } = await buildMerkleTree([commitment], TREE_DEPTH);
  const { pathElements, pathIndices } = getMerkleProof(layers, leafIndex);

  // Nullifiers (domain-separated)
  const nullifier = F.toObject(poseidon([TAG_ESCROW_NULL, secret, salt]));
  const nonceNullifier = F.toObject(poseidon([TAG_NONCE_NULL, secret, nonce]));

  // New (residual) commitment
  const newBalance = balance - sellAmount;
  const newCommitment = newBalance === 0n
    ? 0n
    : F.toObject(poseidon([secret, sellToken, newBalance, newSalt]));

  // Claims root + total locked
  const padded = padClaims(claims);
  const claimLeaves = padded.map((c) =>
    c.amount === 0n
      ? 0n
      : F.toObject(poseidon([c.secret, c.recipient, c.token, c.amount, c.releaseTime]))
  );
  const { root: claimsRoot } = await buildMerkleTree(claimLeaves, CLAIMS_DEPTH);
  const totalLocked = claims.reduce((acc, c) => acc + c.amount, 0n);

  // Order hash
  const orderHash = F.toObject(
    poseidon([sellToken, buyToken, sellAmount, buyAmount, maxFee, expiry, nonce, claimsRoot, relayer])
  );

  // EdDSA signature over orderHash
  const orderHashBytes = F.e(orderHash);
  const sig = eddsa.signPoseidon(privKey, orderHashBytes);
  const pub = eddsa.prv2pub(privKey);

  return {
    // public
    commitmentRoot: root.toString(),
    nullifier: nullifier.toString(),
    nonceNullifier: nonceNullifier.toString(),
    newCommitment: newCommitment.toString(),
    sellToken: sellToken.toString(),
    buyToken: buyToken.toString(),
    sellAmount: sellAmount.toString(),
    buyAmount: buyAmount.toString(),
    maxFee: maxFee.toString(),
    expiry: expiry.toString(),
    claimsRoot: claimsRoot.toString(),
    totalLocked: totalLocked.toString(),
    relayer: relayer.toString(),
    orderHash: orderHash.toString(),
    // private
    secret: secret.toString(),
    balance: balance.toString(),
    salt: salt.toString(),
    path: pathElements.map((e) => e.toString()),
    pathIdx: pathIndices.map((i) => i.toString()),
    nonce: nonce.toString(),
    newSalt: newSalt.toString(),
    pubKeyAx: babyJub.F.toObject(pub[0]).toString(),
    pubKeyAy: babyJub.F.toObject(pub[1]).toString(),
    sigS: sig.S.toString(),
    sigR8x: babyJub.F.toObject(sig.R8[0]).toString(),
    sigR8y: babyJub.F.toObject(sig.R8[1]).toString(),
    claimSecrets: padded.map((c) => c.secret.toString()),
    claimRecipients: padded.map((c) => c.recipient.toString()),
    claimTokens: padded.map((c) => c.token.toString()),
    claimAmounts: padded.map((c) => c.amount.toString()),
    claimReleaseTimes: padded.map((c) => c.releaseTime.toString()),
    claimCount: claims.length.toString(),
  };
}

describe("authorize.circom (Half-proof PoC)", () => {
  beforeAll(async () => {
    poseidon = await buildPoseidon();
    F = poseidon.F;
    eddsa = await buildEddsa();
    babyJub = await buildBabyjub();
  }, 60000);

  test("happy path: full-balance order with one claim", async () => {
    const secret = randomField();
    const salt = randomField();
    const sellToken = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9"); // WETH
    const buyToken = BigInt("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");  // USDC
    const balance = 10n * 10n ** 18n;
    const sellAmount = balance; // sell entire balance
    const buyAmount = 21000n * 10n ** 18n;
    const maxFee = 60n;
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const nonce = 1n;
    const newSalt = randomField();
    const relayer = BigInt("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");

    const claims = [{
      secret: randomField(),
      recipient: BigInt("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"),
      token: buyToken,
      amount: 21000n * 10n ** 18n,
      releaseTime: expiry,
    }];

    const privKey = crypto.randomBytes(32);

    const input = await buildAuthorizeInput({
      secret, salt, sellToken, balance, buyToken,
      sellAmount, buyAmount, maxFee, expiry, nonce, newSalt,
      claims, relayer, privKey,
    });

    const t0 = Date.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
    const dt = Date.now() - t0;
    console.log(`  authorize proof gen: ${dt}ms (single side, ${publicSignals.length} public signals)`);

    const vkey = require(VKEY_PATH);
    const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    expect(ok).toBe(true);
  }, 120000);

  test("partial-spend: residual commitment is non-zero and proof verifies", async () => {
    const secret = randomField();
    const salt = randomField();
    const sellToken = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
    const buyToken = BigInt("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    const balance = 10n * 10n ** 18n;
    const sellAmount = 3n * 10n ** 18n; // 30%
    const buyAmount = 6000n * 10n ** 18n;
    const maxFee = 60n;
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const nonce = 2n;
    const newSalt = randomField();
    const relayer = BigInt("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");

    const claims = [{
      secret: randomField(),
      recipient: BigInt("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"),
      token: buyToken,
      amount: 6000n * 10n ** 18n,
      releaseTime: expiry,
    }];

    const privKey = crypto.randomBytes(32);

    const input = await buildAuthorizeInput({
      secret, salt, sellToken, balance, buyToken,
      sellAmount, buyAmount, maxFee, expiry, nonce, newSalt,
      claims, relayer, privKey,
    });

    expect(BigInt(input.newCommitment)).not.toBe(0n);

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
    const vkey = require(VKEY_PATH);
    expect(await snarkjs.groth16.verify(vkey, publicSignals, proof)).toBe(true);
  }, 120000);

  test("rejects sellAmount > balance (witness gen fails)", async () => {
    const secret = randomField();
    const salt = randomField();
    const sellToken = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
    const buyToken = BigInt("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    const balance = 10n * 10n ** 18n;
    const sellAmount = 11n * 10n ** 18n; // > balance
    const buyAmount = 21000n * 10n ** 18n;

    const privKey = crypto.randomBytes(32);

    // Use a fake newCommitment to satisfy the residual hash check
    // (the balCheck will fail before we get there).
    const input = {
      ...(await buildAuthorizeInput({
        secret, salt, sellToken, balance, buyToken,
        sellAmount: balance, buyAmount, maxFee: 60n,
        expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
        nonce: 3n, newSalt: randomField(),
        claims: [{
          secret: randomField(),
          recipient: BigInt("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"),
          token: buyToken,
          amount: 21000n * 10n ** 18n,
          releaseTime: BigInt(Math.floor(Date.now() / 1000) + 3600),
        }],
        relayer: BigInt("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"),
        privKey,
      })),
      sellAmount: sellAmount.toString(), // tamper after build
    };

    await expect(
      snarkjs.groth16.fullProve(input, WASM, ZKEY)
    ).rejects.toThrow();
  }, 120000);

  test("rejects totalLocked < buyAmount (insufficient receive)", async () => {
    const secret = randomField();
    const salt = randomField();
    const sellToken = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
    const buyToken = BigInt("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    const balance = 10n * 10n ** 18n;
    const sellAmount = balance;
    const buyAmount = 21000n * 10n ** 18n;
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const privKey = crypto.randomBytes(32);

    // Claims sum to LESS than buyAmount → minimum-receive check should fail
    const claims = [{
      secret: randomField(),
      recipient: BigInt("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"),
      token: buyToken,
      amount: 100n * 10n ** 18n, // far below buyAmount
      releaseTime: expiry,
    }];

    const input = await buildAuthorizeInput({
      secret, salt, sellToken, balance, buyToken,
      sellAmount, buyAmount, maxFee: 60n, expiry, nonce: 4n,
      newSalt: randomField(),
      claims, relayer: BigInt("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"),
      privKey,
    });

    await expect(
      snarkjs.groth16.fullProve(input, WASM, ZKEY)
    ).rejects.toThrow();
  }, 120000);
});
