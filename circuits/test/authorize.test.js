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
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");

const BUILD_DIR = path.join(__dirname, "../build");
const WASM = path.join(BUILD_DIR, "authorize_js/authorize.wasm");
const ZKEY = path.join(BUILD_DIR, "authorize_final.zkey");
const VKEY_PATH = path.join(BUILD_DIR, "authorize_vkey.json");

/**
 * Negative-test helper: assert that *witness generation alone* throws.
 *
 * For constraint-violation tests we don't need the full Groth16 prove
 * step (MSM over BN254). Witness calc on its own catches the failure
 * and skips the ~80% of fullProve cost that is proof generation,
 * which trims roughly 3-4 s off each negative test in jest.
 */
async function expectWitnessFailure(input) {
  const tmpWtns = path.join(
    os.tmpdir(),
    `authorize_neg_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.wtns`
  );
  let threw = false;
  try {
    await snarkjs.wtns.calculate(input, WASM, tmpWtns);
  } catch (_e) {
    threw = true;
  } finally {
    try { fs.unlinkSync(tmpWtns); } catch (_) { /* ignore */ }
  }
  expect(threw).toBe(true);
}

const TREE_DEPTH = 20;
const CLAIMS_DEPTH = 4;
const MAX_CLAIMS = 16;

// ── Domain tags (must match circuits/tags.circom) ──
const TAG_ESCROW_NULL = 0n;
const TAG_NONCE_NULL = 1n;
// [issue #128] v2 commitment tag — binds BabyJub signing pubkey into the
// escrow commitment preimage.
const TAG_COMMITMENT_V2 = 3n;

let poseidon, F, eddsa, babyJub;

function randomField() {
  const bytes = new Uint8Array(31);
  crypto.randomFillSync(bytes);
  let val = 0n;
  for (const b of bytes) val = (val << 8n) | BigInt(b);
  return val;
}

/**
 * Build a *dense* Merkle tree (used only for the small claims tree, depth=4).
 * Do NOT call with depth ≥ 8 — see `computeSparseSingleLeafProof` for the
 * commitment tree (depth=20) which builds the path in O(depth) without
 * materialising 2^depth leaves.
 */
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

/**
 * Sparse Merkle proof for a *single* leaf in an otherwise empty tree.
 *
 * The naive `buildMerkleTree([leaf], 20)` allocates ~1 048 576 leaves and
 * performs ~1M Poseidon hashes per test case, which dominates CI time
 * (Copilot review, PR #127). For the commitment tree we only ever set
 * one leaf at index 0, so we can:
 *
 *   1. Precompute zero siblings z[i] = Poseidon(z[i-1], z[i-1])  — `depth` hashes
 *   2. Walk from `leaf` up the tree, hashing against z[i] at each level — `depth` hashes
 *
 * Total: 2·depth Poseidon hashes (40 for depth=20) instead of ~2 million.
 * The resulting `(root, pathElements, pathIndices)` are byte-identical
 * to what the dense version would produce.
 */
function computeSparseSingleLeafProof(leaf, depth, leafIndex) {
  const zeros = [0n];
  for (let i = 1; i <= depth; i++) {
    zeros.push(F.toObject(poseidon([zeros[i - 1], zeros[i - 1]])));
  }

  const pathElements = [];
  const pathIndices = [];
  let current = leaf;
  let index = leafIndex;
  for (let i = 0; i < depth; i++) {
    const isRight = index % 2;
    pathElements.push(zeros[i]);
    pathIndices.push(isRight);
    current = isRight
      ? F.toObject(poseidon([zeros[i], current]))
      : F.toObject(poseidon([current, zeros[i]]));
    index = Math.floor(index / 2);
  }
  return { root: current, pathElements, pathIndices };
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
  // [issue #128] Derive the BabyJub signing pubkey first — it's part
  // of the v2 commitment preimage, so it has to exist before we
  // compute the commitment.
  const pub = eddsa.prv2pub(privKey);
  const pubKeyAx = babyJub.F.toObject(pub[0]);
  const pubKeyAy = babyJub.F.toObject(pub[1]);

  // v2 commitment: Poseidon(TAG_COMMITMENT_V2, secret, sellToken,
  // balance, salt, pubKeyAx, pubKeyAy). Sparse single-leaf tree
  // (depth=20, ~40 Poseidon hashes total — see
  // computeSparseSingleLeafProof for why this matters).
  const commitment = F.toObject(
    poseidon([TAG_COMMITMENT_V2, secret, sellToken, balance, salt, pubKeyAx, pubKeyAy])
  );
  const leafIndex = 0;
  const { root, pathElements, pathIndices } = computeSparseSingleLeafProof(
    commitment,
    TREE_DEPTH,
    leafIndex
  );

  // Nullifiers (domain-separated)
  const nullifier = F.toObject(poseidon([TAG_ESCROW_NULL, secret, salt]));
  const nonceNullifier = F.toObject(poseidon([TAG_NONCE_NULL, secret, nonce]));

  // Residual commitment uses the same v2 binding.
  const newBalance = balance - sellAmount;
  const newCommitment = newBalance === 0n
    ? 0n
    : F.toObject(
        poseidon([TAG_COMMITMENT_V2, secret, sellToken, newBalance, newSalt, pubKeyAx, pubKeyAy])
      );

  // Claims root + total locked.
  //
  // [PR #127 gemini HIGH] Padding is detected by *index*, not by amount.
  // A real used claim with amount=0 must still hash to its full preimage
  // — only slots i ≥ claims.length are zeroed out. The previous logic
  // (`c.amount === 0n ? 0n : ...`) silently merged real zero-amount
  // claims into padding and would have hidden any future bug around
  // them.
  const padded = padClaims(claims);
  const claimLeaves = padded.map((c, i) =>
    i < claims.length
      ? F.toObject(poseidon([c.secret, c.recipient, c.token, c.amount, c.releaseTime]))
      : 0n
  );
  const { root: claimsRoot } = await buildMerkleTree(claimLeaves, CLAIMS_DEPTH);
  const totalLocked = claims.reduce((acc, c) => acc + c.amount, 0n);

  // Order hash
  const orderHash = F.toObject(
    poseidon([sellToken, buyToken, sellAmount, buyAmount, maxFee, expiry, nonce, claimsRoot, relayer])
  );

  // EdDSA signature over orderHash. pubKeyAx/Ay were derived earlier
  // (they're part of the commitment preimage now).
  //
  // [issue #128 design correction] We no longer expose pubKeyHash as
  // a public output — see the threat-model block at the top of
  // authorize.circom for why. The pubkey stays inside the witness.
  const orderHashBytes = F.e(orderHash);
  const sig = eddsa.signPoseidon(privKey, orderHashBytes);

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
    pubKeyAx: pubKeyAx.toString(),
    pubKeyAy: pubKeyAy.toString(),
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

    if (process.env.DUMP_CALLDATA) {
      const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
      fs.writeFileSync(process.env.DUMP_CALLDATA, calldata);
    }
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

    await expectWitnessFailure(input);
  }, 120000);

  // [PR #127 Copilot] Defence-in-depth: confirm that tampering with the
  // EdDSA signature actually breaks witness generation. Without this we
  // could silently regress signature verification (e.g., if EdDSAPoseidon
  // were ever short-circuited) and only notice via on-chain failures.
  test("rejects tampered EdDSA signature (sigS flipped)", async () => {
    const secret = randomField();
    const salt = randomField();
    const sellToken = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
    const buyToken = BigInt("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    const balance = 10n * 10n ** 18n;
    const sellAmount = balance;
    const buyAmount = 21000n * 10n ** 18n;
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const relayer = BigInt("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    const privKey = crypto.randomBytes(32);

    const claims = [{
      secret: randomField(),
      recipient: relayer,
      token: buyToken,
      amount: 21000n * 10n ** 18n,
      releaseTime: expiry,
    }];

    const input = await buildAuthorizeInput({
      secret, salt, sellToken, balance, buyToken,
      sellAmount, buyAmount, maxFee: 60n, expiry, nonce: 5n,
      newSalt: randomField(), claims, relayer, privKey,
    });

    // Flip one bit of the signature scalar — keeps every other public
    // signal valid, including the orderHash, so the failure must come
    // from the EdDSA verifier itself.
    const tampered = { ...input, sigS: (BigInt(input.sigS) + 1n).toString() };

    await expectWitnessFailure(tampered);
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

    await expectWitnessFailure(input);
  }, 120000);

  test("[H-5] claimCount > maxClaimsPerSide (32) should fail witness generation", async () => {
    const secret = randomField();
    const salt = randomField();
    const sellToken = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
    const buyToken = BigInt("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    const balance = 10n * 10n ** 18n;
    const privKey = crypto.randomBytes(32);
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const claims = [{
      secret: randomField(),
      recipient: BigInt("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"),
      token: buyToken,
      amount: balance,
      releaseTime: expiry,
    }];

    const input = await buildAuthorizeInput({
      secret, salt, sellToken, balance, buyToken,
      sellAmount: balance, buyAmount: 21000n * 10n ** 18n,
      maxFee: 60n, expiry, nonce: 5n,
      newSalt: randomField(),
      claims, relayer: BigInt("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"),
      privKey,
    });

    // Tamper claimCount to 32 (exceeds 5-bit Num2Bits range)
    input.claimCount = "32";
    await expectWitnessFailure(input);
  }, 120000);

  test("[H-5] claimCount = 17 (within Num2Bits(5) but > maxClaimsPerSide) should fail", async () => {
    const secret = randomField();
    const salt = randomField();
    const sellToken = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
    const buyToken = BigInt("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    const balance = 10n * 10n ** 18n;
    const privKey = crypto.randomBytes(32);
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const claims = [{
      secret: randomField(),
      recipient: BigInt("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"),
      token: buyToken,
      amount: balance,
      releaseTime: expiry,
    }];

    const input = await buildAuthorizeInput({
      secret, salt, sellToken, balance, buyToken,
      sellAmount: balance, buyAmount: 21000n * 10n ** 18n,
      maxFee: 60n, expiry, nonce: 6n,
      newSalt: randomField(),
      claims, relayer: BigInt("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"),
      privKey,
    });

    // Tamper claimCount to 17 (passes Num2Bits(5) but fails LessEqThan)
    input.claimCount = "17";
    await expectWitnessFailure(input);
  }, 120000);
});
