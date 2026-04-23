#!/usr/bin/env tsx
/**
 * E2E test: Authorize-flow cross-relayer matching via shared orderbook.
 *
 * Replaces the deleted Private-flow `e2e-cross-relayer.ts` (tracker #29
 * cleanup, PR #316). Verifies the path added in PR #308: two relayers
 * holding reciprocal authorize orders match via shared orderbook,
 * exchange a Trade Offer over P2P, and settle on-chain via
 * `PrivateSettlement.settleAuth`.
 *
 * Prerequisites (on chain 31337):
 *   1. anvil running on localhost:8545 with the standard Foundry mnemonic
 *   2. Contracts deployed (run: ./scripts/dev-fork.sh or ./scripts/dev.sh --mock)
 *   3. Shared orderbook server on localhost:4000
 *   4. Relayer A on localhost:3002 (account #1, registered by DeployLocal)
 *   5. Relayer B on localhost:3003 (account #2, registered post-deploy)
 *   6. Both relayers configured with SHARED_ORDERBOOK_URL
 *
 * Usage:
 *   cd zk-relayer && npx tsx test/e2e-authorize-cross-relayer.ts
 *
 * Flow tested:
 *   1. Alice (anvil #4) deposits WETH and submits a sell-WETH/buy-USDC
 *      authorize order to Relayer A
 *   2. Bob (anvil #5) deposits USDC and submits a sell-USDC/buy-WETH
 *      authorize order to Relayer B
 *   3. Each relayer publishes its summary to shared OB
 *   4. Cross-relayer match service detects compatibility, sends Trade
 *      Offer over /api/p2p/authorize-trade-offer
 *   5. Receiving relayer calls settleAuth on-chain
 *   6. Both nullifiers + claimsRoots are committed
 *   7. FeeVault credits each relayer with its user's buyToken fee
 *      (the 2026-04-14 fee-semantics redesign — PR #303)
 *   8. Each user generates a claim proof and pulls their tokens out
 *      via claimWithProof
 *
 * Failure modes covered: timeout if either order never settles
 * (60s default, override via E2E_SETTLE_TIMEOUT_MS).
 */

import { ethers } from "ethers";
import path from "path";
import { fileURLToPath } from "url";

import { getEdDSA as getEdDSAImpl } from "../src/core/zk-prover.js";
import { TAG_ESCROW_NULL, TAG_NONCE_NULL, TAG_CLAIM_NULL } from "../src/core/tags.js";
import { poseidonHash, computeCommitmentV2, randomFieldElement, toHex, assert, buildTree, getMerkleProof } from "./helpers/common.js";
import { makeDepositProof } from "./helpers/deposit-proof.mjs";
import { makeAuthorizeProof } from "./helpers/authorize-proof.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ─────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL ?? "http://localhost:8545";
const RELAYER_A_URL = process.env.RELAYER_A_URL ?? "http://localhost:3002";
const RELAYER_B_URL = process.env.RELAYER_B_URL ?? "http://localhost:3003";
const SHARED_OB_URL = process.env.SHARED_OB_URL ?? "http://localhost:4000";
const SETTLE_TIMEOUT_MS = Number(process.env.E2E_SETTLE_TIMEOUT_MS ?? 60_000);
const SETTLE_POLL_MS = 1500;

const CLAIMS_TREE_DEPTH = 4;
const CLAIMS_TREE_SIZE = 2 ** CLAIMS_TREE_DEPTH;

// USDC default — DeployLocal mock token; override via env for fork mode.
const USDC_ADDRESS = process.env.E2E_USDC_ADDRESS ?? "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853";

// Anvil deterministic accounts — Alice/Bob are users; #1/#2 are the
// relayer signers, set by dev-fork.sh / start-cross-relayer-e2e.sh.
const ALICE_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";  // anvil #4
const BOB_KEY = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e";   // anvil #5
const ALICE_ADDR = new ethers.Wallet(ALICE_KEY).address;
const BOB_ADDR = new ethers.Wallet(BOB_KEY).address;

// Relayer addresses for fee-vault assertions (fixed by anvil mnemonic)
const RELAYER_A_ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";  // anvil #1
const RELAYER_B_ADDR = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";  // anvil #2

// Trade parameters — sized small so this runs on a fresh dev env
const SELL_WETH = ethers.parseEther("1");
const BUY_USDC = 2_390_000_000n;            // 2,390 USDC (6 decimals)
const ORDER_MAX_FEE_BPS = 30n;              // matches relayer config
const RELEASE_DELAY_SEC = 60n;

// ─── ABIs ───────────────────────────────────────────────────

const WETH_ABI = [
  "function deposit() external payable",
  "function approve(address,uint256) external returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

const USDC_ABI = [
  "function mint(address,uint256) external",
  "function approve(address,uint256) external returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

const POOL_ABI = [
  "function deposit(uint256[2],uint256[2][2],uint256[2],uint256,address,uint256) external",
  "function getLastRoot() view returns (uint256)",
  "function isKnownRoot(uint256) view returns (bool)",
  "event CommitmentInserted(uint256 indexed commitment, uint32 leafIndex, uint256 timestamp)",
];

const SETTLEMENT_ABI = [
  "function nullifiers(bytes32) view returns (bool)",
  "function nonceNullifiers(bytes32) view returns (bool)",
  "function claimNullifiers(bytes32) view returns (bool)",
  "function claimsGroups(bytes32) view returns (uint128 totalLocked, uint128 totalClaimed, address token)",
  "function feeVault() view returns (address)",
  "function weth() view returns (address)",
];

const FEE_VAULT_ABI = [
  "function balances(address,address) view returns (uint256)",
];

const CLAIM_ABI = [
  "function claimWithProof(uint256[2],uint256[2][2],uint256[2],bytes32,bytes32,uint256,address,address,uint256) external",
];

// ─── Helpers ────────────────────────────────────────────────

interface KeyMaterial {
  privKey: Buffer;
  pubKeyAx: bigint;
  pubKeyAy: bigint;
}

interface UserCtx {
  label: string;
  wallet: ethers.NonceManager;
  addr: string;
  recipient: string;          // where claim proceeds land
  sellToken: string;
  buyToken: string;
  sellAmount: bigint;
  buyAmount: bigint;
  relayerUrl: string;
  relayerAddr: string;
  /** Pre-derived to keep the deposit-time commitment and the order-time
   *  EdDSA signature locked to the same key. Was previously derived
   *  twice (once at deposit, once at order build) from string-templated
   *  seeds — a one-character drift between sites silently broke the
   *  authorize proof. */
  key: KeyMaterial;
}

interface DepositInfo {
  ownerSecret: bigint;
  salt: bigint;
  commitment: bigint;
  leafIndex: number;
  pubKeyAx: bigint;
  pubKeyAy: bigint;
  eddsaPrivKey: Buffer;
  /** EdDSA signing primitives from circomlibjs */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eddsa: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  F: any;
}

interface OrderArtifacts {
  nullifier: bigint;
  nonceNullifier: bigint;
  claimsRoot: bigint;
  authNullifierHex: string;
  claimSecret: bigint;
  claimAmount: bigint;
  claimReleaseTime: bigint;
  claimsLayers: bigint[][];
}

async function fetchInfo(): Promise<{ poolAddr: string; settlementAddr: string }> {
  const res = await fetch(`${RELAYER_A_URL}/api/info`);
  if (!res.ok) throw new Error(`Relayer A unreachable at ${RELAYER_A_URL}`);
  const info = await res.json() as { commitmentPool: string; privateSettlement: string };
  return { poolAddr: info.commitmentPool, settlementAddr: info.privateSettlement };
}

async function deposit(
  user: UserCtx,
  pool: ethers.Contract,
  tokenAddr: string,
  amount: bigint,
): Promise<DepositInfo> {
  const eddsaCtx = await getEdDSAImpl();
  const F = eddsaCtx.babyJub.F;

  const ownerSecret = randomFieldElement();
  const salt = randomFieldElement();
  const commitment = computeCommitmentV2(ownerSecret, BigInt(tokenAddr), amount, salt, user.key.pubKeyAx, user.key.pubKeyAy);

  // `makeDepositProof` already returns Solidity-formatted {a,b,c}
  // tuples (with the pi_b coordinate transpose applied). Don't go
  // back into the raw snarkjs `pi_a/pi_b/pi_c` shape — that path is a
  // crash because the returned object doesn't have a `.proof` member.
  const proof = await makeDepositProof({
    secret: ownerSecret, salt, token: tokenAddr, commitment, amount,
    pubKeyAx: user.key.pubKeyAx, pubKeyAy: user.key.pubKeyAy,
  });

  const tx = await pool.deposit(proof.a, proof.b, proof.c, commitment, tokenAddr, amount);
  const receipt = await tx.wait();

  // Find leafIndex from the CommitmentInserted event
  const log = receipt!.logs.find((l: ethers.Log) => l.topics[0] === ethers.id("CommitmentInserted(uint256,uint32,uint256)"));
  if (!log) throw new Error("CommitmentInserted event not found");
  const decoded = pool.interface.decodeEventLog("CommitmentInserted", log.data, log.topics);
  const leafIndex = Number(decoded[1]);

  return {
    ownerSecret, salt, commitment, leafIndex,
    pubKeyAx: user.key.pubKeyAx, pubKeyAy: user.key.pubKeyAy,
    eddsaPrivKey: user.key.privKey,
    eddsa: eddsaCtx.eddsa,
    F,
  };
}

async function buildAndSubmitOrder(
  user: UserCtx,
  dep: DepositInfo,
  pool: ethers.Contract,
  /** Pool leaves indexed by leafIndex — accurate Merkle proof requires
   *  the array element at `dep.leafIndex` to be the user's commitment.
   *  Push-order would silently break if the pool already had prior
   *  deposits (re-runs, dev env activity). */
  leafByIndex: bigint[],
): Promise<OrderArtifacts> {
  // Claim recipient + secret — single claim sized to (buyAmount − fee).
  // settleAuth enforces `totalLocked + feeToken ≤ counterpartySell`, and
  // separately `feeToken * 10000 ≤ buyAmount * maxFee` — i.e. the fee is
  // only *bounded* by `floor(buyAmount × maxFee / 10000)`; the relayer
  // picks the actual amount at or below that ceiling. This test uses
  // `fee = floor(buyAmount × maxFee / 10000)` as its chosen value. Since
  // our orders use sellAmount === counterparty.buyAmount, packing
  // `claimAmount = buyAmount` would trip ClaimsCapExceeded the moment
  // the relayer adds any fee — reserve the cap for the fee.
  const claimSecret = randomFieldElement();
  const releaseTime = BigInt(Math.floor(Date.now() / 1000)) + RELEASE_DELAY_SEC;
  const expectedFee = (user.buyAmount * ORDER_MAX_FEE_BPS) / 10_000n;
  const claimAmount = user.buyAmount - expectedFee;
  const claim = {
    secret: claimSecret,
    recipient: BigInt(user.recipient),
    token: BigInt(user.buyToken),
    amount: claimAmount,
    releaseTime,
  };
  const claimLeaf = poseidonHash([claim.secret, claim.recipient, claim.token, claim.amount, claim.releaseTime]);
  const claimLeaves = new Array(CLAIMS_TREE_SIZE).fill(0n);
  claimLeaves[0] = claimLeaf;
  const { root: claimsRoot, layers: claimsLayers } = await buildTree(claimLeaves, CLAIMS_TREE_DEPTH);

  // Order parameters
  const nonce = randomFieldElement() % (1n << 32n);
  const expiry = BigInt(Math.floor(Date.now() / 1000)) + 86400n;

  // Commitment Merkle proof (depth 20). Caller supplies the leaves
  // already aligned to their on-chain leafIndex slots.
  const COMMIT_DEPTH = 20;
  const commitTree = await buildTree(leafByIndex, COMMIT_DEPTH);
  const commitProof = getMerkleProof(commitTree.layers, dep.leafIndex);

  // Order hash for EdDSA signing
  const orderHash = poseidonHash([
    BigInt(user.sellToken), BigInt(user.buyToken),
    user.sellAmount, user.buyAmount,
    ORDER_MAX_FEE_BPS, expiry, nonce,
    claimsRoot, BigInt(user.relayerAddr),
  ]);
  const sig = dep.eddsa.signPoseidon(dep.eddsaPrivKey, dep.F.e(orderHash));

  // Nullifiers
  const nullifier = poseidonHash([TAG_ESCROW_NULL, dep.ownerSecret, dep.salt]);
  const nonceNullifier = poseidonHash([TAG_NONCE_NULL, dep.ownerSecret, nonce]);

  // No change — full balance committed to the order
  const newCommitment = 0n;
  const newSalt = randomFieldElement();
  const totalLocked = claimAmount;

  // Generate authorize proof
  const authResult = await makeAuthorizeProof({
    commitmentRoot: commitTree.root,
    secret: dep.ownerSecret,
    balance: user.sellAmount,
    salt: dep.salt,
    path: commitProof.pathElements,
    pathIdx: commitProof.pathIndices,
    sellToken: BigInt(user.sellToken),
    buyToken: BigInt(user.buyToken),
    sellAmount: user.sellAmount,
    buyAmount: user.buyAmount,
    maxFee: ORDER_MAX_FEE_BPS,
    expiry, nonce, newSalt,
    relayer: BigInt(user.relayerAddr),
    pubKeyAx: dep.pubKeyAx, pubKeyAy: dep.pubKeyAy,
    sigS: sig.S, sigR8x: dep.F.toObject(sig.R8[0]), sigR8y: dep.F.toObject(sig.R8[1]),
    claims: [claim, ...new Array(CLAIMS_TREE_SIZE - 1).fill({ secret: 0n, recipient: 0n, token: 0n, amount: 0n, releaseTime: 0n })],
    claimCount: 1,
    nullifier, nonceNullifier, newCommitment,
    claimsRoot, totalLocked, orderHash,
  });

  // Submit to the user's relayer. `makeAuthorizeProof.formatted` already
  // applies the pi_b coordinate transpose for the Solidity verifier; just
  // rename proofA/B/C → a/b/c to match the AuthorizeOrderFile shape that
  // POST /api/authorize-orders expects.
  const orderFile = {
    proof: {
      a: authResult.formatted.proofA,
      b: authResult.formatted.proofB,
      c: authResult.formatted.proofC,
    },
    publicSignals: {
      pubKeyBind: authResult.publicSignals[0],
      commitmentRoot: authResult.publicSignals[1],
      nullifier: authResult.publicSignals[2],
      nonceNullifier: authResult.publicSignals[3],
      newCommitment: authResult.publicSignals[4],
      sellToken: authResult.publicSignals[5],
      buyToken: authResult.publicSignals[6],
      sellAmount: authResult.publicSignals[7],
      buyAmount: authResult.publicSignals[8],
      maxFee: authResult.publicSignals[9],
      expiry: authResult.publicSignals[10],
      claimsRoot: authResult.publicSignals[11],
      totalLocked: authResult.publicSignals[12],
      relayer: authResult.publicSignals[13],
      orderHash: authResult.publicSignals[14],
    },
    publicSignalsArray: authResult.publicSignals,
    // The relayer's POST handler (validateAuthorizeOrder) requires the
    // claimed pubKey separately so it can be cross-checked against
    // pubKeyBind in the proof and routed through the OFAC filter. The
    // raw `publicSignals.pubKeyBind` alone (it's a hash) doesn't let the
    // relayer recover ax/ay.
    pubKeyAx: dep.pubKeyAx.toString(),
    pubKeyAy: dep.pubKeyAy.toString(),
  };

  const submitRes = await fetch(`${user.relayerUrl}/api/authorize-orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(orderFile),
  });
  if (!submitRes.ok) {
    const body = await submitRes.text();
    throw new Error(`${user.label} order submission failed: ${submitRes.status} ${body.slice(0, 300)}`);
  }
  const submitBody = await submitRes.json() as { nullifier: string };
  console.log(`  ${user.label} submitted: nullifier=${submitBody.nullifier.slice(0, 18)}...`);

  return {
    nullifier, nonceNullifier, claimsRoot,
    authNullifierHex: toHex(nullifier, 32),
    claimSecret, claimAmount, claimReleaseTime: releaseTime,
    claimsLayers,
  };
}

async function waitForSettlement(
  settlement: ethers.Contract,
  artifactsA: OrderArtifacts,
  artifactsB: OrderArtifacts,
): Promise<void> {
  const start = Date.now();
  const aHex = artifactsA.authNullifierHex;
  const bHex = artifactsB.authNullifierHex;
  const aRoot = toHex(artifactsA.claimsRoot, 32);
  const bRoot = toHex(artifactsB.claimsRoot, 32);
  while (Date.now() - start < SETTLE_TIMEOUT_MS) {
    // `nullifiers(...)` alone would also flip on a cancel — guard with
    // `claimsGroups[root].totalLocked > 0` since registerClaimsGroup is
    // only called by `settleAuth`, `settleWithDex`, and
    // `scatterDirectAuth`, never by `cancelPrivate`. (The legacy
    // `scatterDirect` path does not register a claims group.)
    const [aSpent, bSpent, aGroup, bGroup] = await Promise.all([
      settlement.nullifiers(aHex),
      settlement.nullifiers(bHex),
      settlement.claimsGroups(aRoot),
      settlement.claimsGroups(bRoot),
    ]);
    if (aSpent && bSpent && BigInt(aGroup.totalLocked) > 0n && BigInt(bGroup.totalLocked) > 0n) {
      console.log(`  Both orders settled in ${((Date.now() - start) / 1000).toFixed(1)}s`);
      return;
    }
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
  }
  throw new Error(`settleAuth timeout after ${SETTLE_TIMEOUT_MS}ms — orders not settled (nullifier spent without claimsGroup registration would indicate a cancel race)`);
}

async function claimFor(
  user: UserCtx,
  art: OrderArtifacts,
  settlementAddr: string,
  provider: ethers.JsonRpcProvider,
  wallet: ethers.NonceManager,
): Promise<void> {
  // Advance time past releaseTime
  const block = await provider.getBlock("latest");
  const now = BigInt(block!.timestamp);
  if (now <= art.claimReleaseTime) {
    await provider.send("evm_increaseTime", [Number(art.claimReleaseTime - now) + 1]);
    await provider.send("evm_mine", []);
  }

  const claimNullifier = poseidonHash([TAG_CLAIM_NULL, art.claimSecret, 0n]);
  const claimMerkleProof = getMerkleProof(art.claimsLayers, 0);

  const snarkjs = await import("snarkjs");
  const CLAIM_WASM = path.join(__dirname, "../../circuits/build/claim_js/claim.wasm");
  const CLAIM_ZKEY = path.join(__dirname, "../../circuits/build/claim_final.zkey");

  const { proof } = await snarkjs.groth16.fullProve({
    claimsRoot: art.claimsRoot.toString(),
    nullifier: claimNullifier.toString(),
    amount: art.claimAmount.toString(),
    token: BigInt(user.buyToken).toString(),
    recipient: BigInt(user.recipient).toString(),
    releaseTime: art.claimReleaseTime.toString(),
    secret: art.claimSecret.toString(),
    leafIndex: "0",
    pathElements: claimMerkleProof.pathElements.map((e) => e.toString()),
    pathIndices: claimMerkleProof.pathIndices.map((i) => i.toString()),
  }, CLAIM_WASM, CLAIM_ZKEY);

  const claimContract = new ethers.Contract(settlementAddr, CLAIM_ABI, wallet);
  const tx = await claimContract.claimWithProof(
    [proof.pi_a[0], proof.pi_a[1]],
    [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]],
    [proof.pi_c[0], proof.pi_c[1]],
    toHex(art.claimsRoot, 32), toHex(claimNullifier, 32),
    art.claimAmount, user.buyToken, user.recipient, art.claimReleaseTime,
  );
  await tx.wait();
  console.log(`  ${user.label} claim: ${tx.hash}`);
}

// ─── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  E2E: Authorize-flow cross-relayer matching");
  console.log("═══════════════════════════════════════════════════════\n");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const chainId = (await provider.getNetwork()).chainId;
  if (chainId !== 31337n && chainId !== 31338n && !process.env.E2E_ALLOW_NON_LOCAL) {
    throw new Error(`Refusing to run on chain ${chainId}. Set E2E_ALLOW_NON_LOCAL=1 to override.`);
  }
  console.log(`Chain: ${chainId}`);

  const { poolAddr, settlementAddr } = await fetchInfo();
  console.log(`Pool: ${poolAddr}\nSettlement: ${settlementAddr}`);

  const settlementForWeth = new ethers.Contract(settlementAddr, SETTLEMENT_ABI, provider);
  const wethAddr: string = await settlementForWeth.weth();
  const feeVaultAddr: string = await settlementForWeth.feeVault();
  console.log(`WETH: ${wethAddr}\nUSDC: ${USDC_ADDRESS}\nFeeVault: ${feeVaultAddr}\n`);

  // ─── Set up Alice + Bob wallets and tokens ─────────────────
  const aliceWallet = new ethers.NonceManager(new ethers.Wallet(ALICE_KEY, provider));
  const bobWallet = new ethers.NonceManager(new ethers.Wallet(BOB_KEY, provider));

  // Recipients — distinct from users, distinct from relayers, so balance
  // assertions can't be confused with anything else paying these addresses.
  const aliceRecipient = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";  // anvil #6
  const bobRecipient = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";    // anvil #7

  console.log("[1/8] Funding Alice with WETH + Bob with USDC...");
  const aliceWeth = new ethers.Contract(wethAddr, WETH_ABI, aliceWallet);
  const bobUsdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, bobWallet);

  // Alice: wrap ETH → WETH, approve pool
  await (await aliceWeth.deposit({ value: SELL_WETH })).wait();
  await (await aliceWeth.approve(poolAddr, ethers.MaxUint256)).wait();
  // Bob: mint USDC, approve pool
  await (await bobUsdc.mint(BOB_ADDR, BUY_USDC)).wait();
  await (await bobUsdc.approve(poolAddr, ethers.MaxUint256)).wait();

  // ─── Step 2: each user deposits into the pool ──────────────
  console.log("\n[2/8] Depositing into CommitmentPool...");

  // Pre-derive both users' EdDSA pubkeys so Step 3 can pin them at deposit time.
  // The pubkey is committed inside the leaf (`computeCommitmentV2` includes ax/ay),
  // so the deposit and the order must use the same key.
  const eddsaInit = await getEdDSAImpl();
  const F = eddsaInit.babyJub.F;
  const aliceKeyHash = ethers.keccak256(ethers.toUtf8Bytes("e2e-alice-key")).slice(2);
  const bobKeyHash = ethers.keccak256(ethers.toUtf8Bytes("e2e-bob-key")).slice(2);
  const alicePubRaw = eddsaInit.eddsa.prv2pub(Buffer.from(aliceKeyHash, "hex"));
  const bobPubRaw = eddsaInit.eddsa.prv2pub(Buffer.from(bobKeyHash, "hex"));
  const alicePubAx = F.toObject(alicePubRaw[0]);
  const alicePubAy = F.toObject(alicePubRaw[1]);
  const bobPubAx = F.toObject(bobPubRaw[0]);
  const bobPubAy = F.toObject(bobPubRaw[1]);

  const alice: UserCtx = {
    label: "Alice", wallet: aliceWallet, addr: ALICE_ADDR, recipient: aliceRecipient,
    sellToken: wethAddr, buyToken: USDC_ADDRESS,
    sellAmount: SELL_WETH, buyAmount: BUY_USDC,
    relayerUrl: RELAYER_A_URL, relayerAddr: RELAYER_A_ADDR,
    key: { privKey: Buffer.from(aliceKeyHash, "hex"), pubKeyAx: alicePubAx, pubKeyAy: alicePubAy },
  };
  const bob: UserCtx = {
    label: "Bob", wallet: bobWallet, addr: BOB_ADDR, recipient: bobRecipient,
    sellToken: USDC_ADDRESS, buyToken: wethAddr,
    sellAmount: BUY_USDC, buyAmount: SELL_WETH,
    relayerUrl: RELAYER_B_URL, relayerAddr: RELAYER_B_ADDR,
    key: { privKey: Buffer.from(bobKeyHash, "hex"), pubKeyAx: bobPubAx, pubKeyAy: bobPubAy },
  };

  const alicePool = new ethers.Contract(poolAddr, POOL_ABI, aliceWallet);
  const bobPool = new ethers.Contract(poolAddr, POOL_ABI, bobWallet);

  const aliceDep = await deposit(alice, alicePool, wethAddr, SELL_WETH);
  const bobDep = await deposit(bob, bobPool, USDC_ADDRESS, BUY_USDC);
  console.log(`  Alice deposit leaf=${aliceDep.leafIndex}`);
  console.log(`  Bob deposit leaf=${bobDep.leafIndex}`);

  // ─── Step 3: build authorize orders and submit ─────────────
  console.log("\n[3/8] Building + submitting authorize orders...");
  // Read every `CommitmentInserted` event so the local Merkle tree we
  // build matches the on-chain tree byte-for-byte. The previous
  // "just the 2 known leaves, zeros elsewhere" shortcut broke in any
  // environment that had prior deposits (re-runs, mobile dev sessions,
  // earlier e2e passes that left commitments behind) — the computed
  // root would diverge from the on-chain root and settleAuth would
  // revert with UnknownRoot().
  //
  // Scan bounds: override via E2E_EVENT_FROM_BLOCK to start from the
  // pool deployment block on long-lived fork environments, where a
  // full-chain scan would hit RPC log-range / result-size limits or
  // just take forever. Default 0 covers fresh anvil.
  const fromBlock = Number(process.env.E2E_EVENT_FROM_BLOCK ?? 0);
  const poolReader = new ethers.Contract(poolAddr, POOL_ABI, provider);
  const allInserts = await poolReader.queryFilter(
    poolReader.filters.CommitmentInserted(),
    fromBlock,
    "latest",
  );
  const leafByIndex: bigint[] = [];
  // Track (block, logIndex) per slot so a mismatch error can point at
  // the specific event that placed the unexpected value — useful when
  // debugging an event scan that saw duplicates or wrong ordering.
  const leafSourceByIndex: Array<{ blockNumber: number; logIndex: number } | undefined> = [];
  for (const log of allInserts) {
    const event = log as ethers.EventLog;
    // Read named args from the EventLog — positional destructuring
    // silently drifts if the ABI adds a field, and the ethers runtime
    // already decodes by name.
    const { commitment, leafIndex } = event.args as unknown as {
      commitment: bigint;
      leafIndex: bigint; // decoded as bigint from the uint32 ABI slot
    };
    const idx = Number(leafIndex);
    while (leafByIndex.length <= idx) {
      leafByIndex.push(0n);
      leafSourceByIndex.push(undefined);
    }
    leafByIndex[idx] = commitment;
    leafSourceByIndex[idx] = { blockNumber: event.blockNumber, logIndex: event.index };
  }
  // Safety: our two fresh deposits must be present at their expected
  // slots. Include both values + origin on mismatch so a failure isn't
  // a scavenger hunt through block logs.
  const assertLeaf = (label: string, leafIndex: number, expected: bigint) => {
    const actual = leafByIndex[leafIndex];
    if (actual === expected) return;
    const src = leafSourceByIndex[leafIndex];
    const origin = src ? ` (from block ${src.blockNumber}, log index ${src.logIndex})` : "";
    throw new Error(
      `leafByIndex[${leafIndex}] mismatch for ${label}: ` +
      `expected ${expected.toString()}, actual ${actual?.toString() ?? "<unset>"}${origin}`,
    );
  };
  assertLeaf("Alice", aliceDep.leafIndex, aliceDep.commitment);
  assertLeaf("Bob", bobDep.leafIndex, bobDep.commitment);

  const aliceArt = await buildAndSubmitOrder(alice, aliceDep, alicePool, leafByIndex);
  const bobArt = await buildAndSubmitOrder(bob, bobDep, bobPool, leafByIndex);

  // ─── Step 4: wait for cross-relayer match + on-chain settle ─
  console.log("\n[4/8] Waiting for cross-relayer settleAuth...");
  const settlement = new ethers.Contract(settlementAddr, SETTLEMENT_ABI, provider);
  await waitForSettlement(settlement, aliceArt, bobArt);

  // ─── Step 5: assert nullifiers + claimsGroups ──────────────
  console.log("\n[5/8] Verifying nullifiers + claimsGroups...");
  for (const [label, art] of [["Alice", aliceArt], ["Bob", bobArt]] as const) {
    const aSpent = await settlement.nullifiers(art.authNullifierHex);
    assert(aSpent, `${label} order nullifier spent`);
    const group = await settlement.claimsGroups(toHex(art.claimsRoot, 32));
    assert(group.totalLocked === art.claimAmount, `${label} claimsGroup totalLocked = ${art.claimAmount}`);
  }

  // ─── Step 6: assert FeeVault routing ───────────────────────
  // Per the 2026-04-14 fee-semantics redesign (PR #303): each user's fee
  // is drawn from their own buy side and routed to the relayer that
  // accepted their order. So:
  //   Alice (buys USDC, on Relayer A) → Relayer A earns USDC fee
  //   Bob (buys WETH, on Relayer B)   → Relayer B earns WETH fee
  console.log("\n[6/8] Verifying FeeVault distribution...");
  const feeVault = new ethers.Contract(feeVaultAddr, FEE_VAULT_ABI, provider);
  const expectedFeeUsdc = (BUY_USDC * ORDER_MAX_FEE_BPS) / 10_000n;
  const expectedFeeWeth = (SELL_WETH * ORDER_MAX_FEE_BPS) / 10_000n;
  const relAUsdc = await feeVault.balances(RELAYER_A_ADDR, USDC_ADDRESS);
  const relBWeth = await feeVault.balances(RELAYER_B_ADDR, wethAddr);
  assert(BigInt(relAUsdc) === expectedFeeUsdc, `Relayer A USDC fee credit = ${expectedFeeUsdc}`);
  assert(BigInt(relBWeth) === expectedFeeWeth, `Relayer B WETH fee credit = ${expectedFeeWeth}`);

  // ─── Step 7: each user claims their tokens ─────────────────
  // Snapshot Bob's native ETH before his claim fires: PrivateSettlement
  // auto-unwraps WETH in `claimWithProof`, so Bob's recipient ends up
  // with native ETH (not WETH). Asserting the ETH delta is the only
  // honest check; `WETH.balanceOf(bobRecipient)` will always read 0.
  console.log("\n[7/8] Claiming...");
  const bobEthBefore = await provider.getBalance(bobRecipient);
  await claimFor(alice, aliceArt, settlementAddr, provider, aliceWallet);
  await claimFor(bob, bobArt, settlementAddr, provider, bobWallet);
  const bobEthAfter = await provider.getBalance(bobRecipient);

  // ─── Step 8: verify recipient balances ─────────────────────
  // Recipients receive `claimAmount` (= buyAmount − fee), not the
  // gross buyAmount — the fee was already routed to FeeVault in step 6.
  // Alice's side stays WETH→USDC so `balanceOf` is still right for her;
  // Bob's WETH is unwrapped to ETH at claim time (see snapshot above).
  console.log("\n[8/8] Verifying recipient balances...");
  const usdcRead = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
  const aliceRecvBal = await usdcRead.balanceOf(aliceRecipient);
  const bobEthDelta = BigInt(bobEthAfter) - BigInt(bobEthBefore);
  assert(BigInt(aliceRecvBal) === aliceArt.claimAmount, `Alice recipient received ${aliceArt.claimAmount} USDC`);
  assert(bobEthDelta === bobArt.claimAmount, `Bob recipient received ${bobArt.claimAmount} native ETH (Settlement auto-unwraps WETH)`);

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  ✅ AUTHORIZE CROSS-RELAYER E2E — ALL CHECKS PASSED");
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch((e) => {
  console.error("\n❌ E2E FAILED:", e.message || e);
  console.error(e.stack);
  process.exit(1);
});
