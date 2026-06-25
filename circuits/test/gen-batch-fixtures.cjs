/**
 * Generate REAL tier-64 / tier-128 authorize.circom proof fixtures for the
 * BatchAuthorizeVerifier Foundry tests.
 *
 * For each tier it builds two independent happy-path authorize inputs, runs
 * snarkjs `fullProve` with that tier's wasm+zkey, sanity-verifies each proof
 * against the tier vkey (oracle), and writes the Solidity calldata
 * (pA, pB, pC, pubSignals[15]) for both proofs to
 * contracts/test/fixtures/batch_authorize_<tier>.json.
 *
 * The batch verifier is tier-agnostic assembly; the only per-tier difference
 * is the vkey. These fixtures let the Foundry suite prove verifyBatchProof
 * actually accepts real same-tier proof pairs (and rejects tampered ones).
 *
 * Run: node circuits/test/gen-batch-fixtures.cjs
 */
const { buildPoseidon, buildEddsa, buildBabyjub } = require("circomlibjs");
const snarkjs = require("snarkjs");
const path = require("path");
const fs = require("fs");

const BUILD_DIR = path.join(__dirname, "../build");
const OUT_DIR = path.join(__dirname, "../../contracts/test/fixtures");

const TREE_DEPTH = 20;
const TAG_ESCROW_NULL = 0n;
const TAG_NONCE_NULL = 1n;
const TAG_COMMITMENT_V2 = 3n;

let poseidon, F, eddsa, babyJub;

const randomField = () => {
  const bytes = require("crypto").randomBytes(31);
  return BigInt("0x" + bytes.toString("hex"));
};

async function buildMerkleTree(leaves, depth) {
  const size = 2 ** depth;
  const padded = [...leaves];
  while (padded.length < size) padded.push(0n);
  let cur = padded;
  for (let i = 0; i < depth; i++) {
    const next = [];
    for (let j = 0; j < cur.length; j += 2) next.push(F.toObject(poseidon([cur[j], cur[j + 1]])));
    cur = next;
  }
  return { root: cur[0] };
}

function computeSparseSingleLeafProof(leaf, depth, leafIndex) {
  const zeros = [0n];
  for (let i = 1; i <= depth; i++) zeros.push(F.toObject(poseidon([zeros[i - 1], zeros[i - 1]])));
  const pathElements = [], pathIndices = [];
  let current = leaf, index = leafIndex;
  for (let i = 0; i < depth; i++) {
    const isRight = index % 2;
    pathElements.push(zeros[i]);
    pathIndices.push(isRight);
    current = isRight ? F.toObject(poseidon([zeros[i], current])) : F.toObject(poseidon([current, zeros[i]]));
    index = Math.floor(index / 2);
  }
  return { root: current, pathElements, pathIndices };
}

function padClaims(claims, maxClaims) {
  const padded = [...claims];
  while (padded.length < maxClaims) padded.push({ secret: 0n, recipient: 0n, token: 0n, amount: 0n, releaseTime: 0n });
  return padded;
}

async function buildAuthorizeInput(claimsDepth, maxClaims, o) {
  const pub = eddsa.prv2pub(o.privKey);
  const pubKeyAx = babyJub.F.toObject(pub[0]);
  const pubKeyAy = babyJub.F.toObject(pub[1]);
  const commitment = F.toObject(poseidon([TAG_COMMITMENT_V2, o.secret, o.sellToken, o.balance, o.salt, pubKeyAx, pubKeyAy]));
  const { root, pathElements, pathIndices } = computeSparseSingleLeafProof(commitment, TREE_DEPTH, 0);
  const nullifier = F.toObject(poseidon([TAG_ESCROW_NULL, o.secret, o.salt]));
  const nonceNullifier = F.toObject(poseidon([TAG_NONCE_NULL, o.secret, o.nonce]));
  const newBalance = o.balance - o.sellAmount;
  const newCommitment = newBalance === 0n ? 0n
    : F.toObject(poseidon([TAG_COMMITMENT_V2, o.secret, o.sellToken, newBalance, o.newSalt, pubKeyAx, pubKeyAy]));
  const padded = padClaims(o.claims, maxClaims);
  const claimLeaves = padded.map((c, i) =>
    i < o.claims.length ? F.toObject(poseidon([c.secret, c.recipient, c.token, c.amount, c.releaseTime])) : 0n);
  const { root: claimsRoot } = await buildMerkleTree(claimLeaves, claimsDepth);
  const totalLocked = o.claims.reduce((acc, c) => acc + c.amount, 0n);
  const orderHash = F.toObject(poseidon([o.sellToken, o.buyToken, o.sellAmount, o.buyAmount, o.maxFee, o.expiry, o.nonce, claimsRoot, o.relayer]));
  const sig = eddsa.signPoseidon(o.privKey, F.e(orderHash));
  return {
    commitmentRoot: root.toString(), nullifier: nullifier.toString(), nonceNullifier: nonceNullifier.toString(),
    newCommitment: newCommitment.toString(), sellToken: o.sellToken.toString(), buyToken: o.buyToken.toString(),
    sellAmount: o.sellAmount.toString(), buyAmount: o.buyAmount.toString(), maxFee: o.maxFee.toString(),
    expiry: o.expiry.toString(), claimsRoot: claimsRoot.toString(), totalLocked: totalLocked.toString(),
    relayer: o.relayer.toString(), orderHash: orderHash.toString(),
    secret: o.secret.toString(), balance: o.balance.toString(), salt: o.salt.toString(),
    path: pathElements.map(String), pathIdx: pathIndices.map(String),
    nonce: o.nonce.toString(), newSalt: o.newSalt.toString(),
    pubKeyAx: pubKeyAx.toString(), pubKeyAy: pubKeyAy.toString(),
    sigS: sig.S.toString(), sigR8x: babyJub.F.toObject(sig.R8[0]).toString(), sigR8y: babyJub.F.toObject(sig.R8[1]).toString(),
    claimSecrets: padded.map((c) => c.secret.toString()), claimRecipients: padded.map((c) => c.recipient.toString()),
    claimTokens: padded.map((c) => c.token.toString()), claimAmounts: padded.map((c) => c.amount.toString()),
    claimReleaseTimes: padded.map((c) => c.releaseTime.toString()), claimCount: o.claims.length.toString(),
  };
}

function sampleOrder() {
  const sellToken = BigInt("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
  const buyToken = BigInt("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  const balance = 10n * 10n ** 18n;
  const buyAmount = 21000n * 10n ** 18n;
  // Every field is freshly random per call, so two orders never collide.
  // Circuit constraint (authorize_template.circom): totalLocked*10000 >=
  // buyAmount*(10000-maxFee) — locked claims must cover the received amount
  // net of fee. Lock the full buyAmount in a single claim.
  return {
    secret: randomField(), salt: randomField(), sellToken, balance, buyToken,
    sellAmount: balance, buyAmount, maxFee: 60n,
    expiry: 1893456000n, nonce: randomField(), newSalt: randomField(),
    claims: [{ secret: randomField(), recipient: BigInt("0x" + "11".repeat(20)), token: buyToken, amount: buyAmount, releaseTime: 0n }],
    relayer: BigInt("0x" + "22".repeat(20)), privKey: require("crypto").randomBytes(32),
  };
}

// snarkjs exportSolidityCallData → parse into {pA,pB,pC,pub}
async function calldata(proof, pubSignals) {
  const s = await snarkjs.groth16.exportSolidityCallData(proof, pubSignals);
  const [pA, pB, pC, pub] = JSON.parse("[" + s + "]");
  return { pA, pB, pC, pub };
}

async function genTier(tier, claimsDepth, maxClaims) {
  const jsDir = path.join(BUILD_DIR, `authorize_${tier}_js`);
  const wasm = path.join(jsDir, fs.readdirSync(jsDir).find((f) => f.endsWith(".wasm")));
  const zkey = path.join(BUILD_DIR, `authorize_${tier}_final.zkey`);
  const vkey = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, `authorize_${tier}_vkey.json`)));
  const proofs = [];
  for (let k = 0; k < 2; k++) {
    const input = await buildAuthorizeInput(claimsDepth, maxClaims, sampleOrder());
    const t0 = Date.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
    const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    if (!ok) throw new Error(`tier ${tier} proof ${k} failed vkey verify`);
    console.log(`  tier ${tier} proof ${k}: gen+verify ${Date.now() - t0}ms, ${publicSignals.length} signals, vkey OK`);
    proofs.push(await calldata(proof, publicSignals));
  }
  const out = { tier, proof1: proofs[0], proof2: proofs[1] };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `batch_authorize_${tier}.json`), JSON.stringify(out, null, 2));
  console.log(`  → wrote contracts/test/fixtures/batch_authorize_${tier}.json`);
}

(async () => {
  poseidon = await buildPoseidon(); F = poseidon.F; eddsa = await buildEddsa(); babyJub = await buildBabyjub();
  await genTier(64, 6, 64);
  await genTier(128, 7, 128);
  console.log("done.");
})().catch((e) => { console.error(e); process.exit(1); });
