#!/usr/bin/env tsx
/**
 * E2E test: Pay-style same-token scatter via `scatterDirectAuth` on local anvil.
 *
 * Flow tested (Pay's actual settlement path — no DEX, no counterparty):
 *   1. Wire MockAuthorizeVerifier + clear RelayerRegistry (single-user test)
 *   2. Mint USDC, deposit into CommitmentPool
 *   3. Build authorize proof with sellToken == buyToken (self-pay invariant)
 *   4. Generate authorize.circom proof
 *   5. Call scatterDirectAuth — settles locally, registers claims group
 *   6. Verify: nullifiers spent, claims group registered with the right tier
 *   7. Advance time, generate claim proof, call claimWithProof
 *   8. Verify: recipient received USDC
 *
 * Prerequisites:
 *   anvil --silent &
 *   cd contracts && forge script script/DeployLocal.s.sol --tc DeployLocal \
 *     --rpc-url http://localhost:8545 --broadcast \
 *     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
 *
 * Usage:
 *   cd zk-relayer && \
 *     E2E_POOL_ADDRESS=<pool> \
 *     E2E_SETTLEMENT_ADDRESS=<settlement> \
 *     E2E_USDC_ADDRESS=<usdc> \
 *     arch -arm64 npx tsx test/e2e-scatter-direct-auth.ts
 */

import { ethers } from "ethers";
import path from "path";
import { fileURLToPath } from "url";

import { performance } from "perf_hooks";

import { AUTHORIZE_PROOF_TUPLE } from "@zkscatter/sdk";
import { callScatterDirectAuth, type SettleAuthSide } from "@zkscatter/sdk/contracts";
import { TIER_16, padClaims, COMMIT_TREE_DEPTH } from "@zkscatter/sdk/zk";
import { getEdDSA as getEdDSAImpl } from "../src/core/zk-prover.js";
import {
  TAG_ESCROW_NULL,
  TAG_NONCE_NULL,
  TAG_CLAIM_NULL,
} from "../src/core/tags.js";
import {
  poseidonHash,
  computeCommitmentV2,
  randomFieldElement,
  toHex,
  assert,
  buildTree,
  getMerkleProof,
} from "./helpers/common.js";

// @ts-ignore — JS module
import { makeDepositProof } from "./helpers/deposit-proof.mjs";
// @ts-ignore — JS module
import { makeAuthorizeProof } from "./helpers/authorize-proof.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL ?? "http://localhost:8545";
const POOL_ADDR = process.env.E2E_POOL_ADDRESS!;
const SETTLEMENT_ADDR = process.env.E2E_SETTLEMENT_ADDRESS!;
const USDC_ADDRESS = process.env.E2E_USDC_ADDRESS!;
const USER_KEY = process.env.E2E_PRIVATE_KEY
  ?? "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";

if (!POOL_ADDR || !SETTLEMENT_ADDR || !USDC_ADDRESS) {
  throw new Error(
    "Missing required env: E2E_POOL_ADDRESS, E2E_SETTLEMENT_ADDRESS, E2E_USDC_ADDRESS",
  );
}

// Number of recipient claims to put on the maker side. Capped by the
// active circuit tier (16 today). N=1 measures the floor; N=16 measures
// the worst case Pay v1 will hit. 64 / 128 require their own circuits
// (B.5 ceremony track) and aren't reachable from this script today.
const RECIPIENTS_N = (() => {
  const v = Number(process.env.E2E_RECIPIENTS ?? 1);
  if (!Number.isInteger(v) || v < 1 || v > TIER_16.cap) {
    throw new Error(
      `E2E_RECIPIENTS must be 1..${TIER_16.cap} (got ${process.env.E2E_RECIPIENTS}). ` +
        `Higher counts need tier 64 / 128 circuits, which are not yet shipped.`,
    );
  }
  return v;
})();

const CLAIMS_TREE_DEPTH = TIER_16.claimsTreeDepth;

/** Deterministic recipient addresses derived from a seed.
 *  Each recipient is the **last 20 bytes** of `keccak256("pay-recipient-i")`
 *  (the standard EVM address derivation), so the same N always produces
 *  the same set across runs and the test stays reproducible. */
function deterministicRecipients(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const hash = ethers.keccak256(ethers.toUtf8Bytes(`pay-recipient-${i}`));
    out.push(ethers.getAddress("0x" + hash.slice(-40)));
  }
  return out;
}

/** Step-timing collector. Records elapsed milliseconds per labelled
 *  block so the run prints a per-step / total breakdown at the end —
 *  the headline output for the N=1/8/16 latency comparison. */
class Timing {
  private steps: { label: string; ms: number }[] = [];
  private last = performance.now();
  mark(label: string) {
    const now = performance.now();
    this.steps.push({ label, ms: now - this.last });
    this.last = now;
  }
  report() {
    const total = this.steps.reduce((s, x) => s + x.ms, 0);
    console.log("\n──────── Timing report ────────");
    console.log(`  Recipients (N): ${RECIPIENTS_N}`);
    for (const s of this.steps) {
      console.log(`    ${s.label.padEnd(30)} ${s.ms.toFixed(1).padStart(8)} ms`);
    }
    console.log(`    ${"TOTAL".padEnd(30)} ${total.toFixed(1).padStart(8)} ms`);
    console.log("───────────────────────────────");
  }
}

// ─── ABIs ──────────────────────────────────────────────────

const ERC20_ABI = [
  "function approve(address,uint256) external returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address,uint256) external",
];

const POOL_ABI = [
  "function deposit(uint256[2],uint256[2][2],uint256[2],uint256,address,uint256) external",
  "function getLastRoot() view returns (uint256)",
  "function isKnownRoot(uint256) view returns (bool)",
  "event CommitmentInserted(uint256 indexed commitment, uint32 leafIndex, uint256 timestamp)",
];

const SETTLEMENT_ABI = [
  // scatterDirectAuth carries the authorize tuple straight from the
  // SDK constant — single dep, no DEX router / counterparty params.
  `function scatterDirectAuth(tuple(tuple${AUTHORIZE_PROOF_TUPLE} proof, uint96 fee) p) external`,
  "function setAuthorizeVerifier(uint8,address) external",
  "function setRelayerRegistry(address) external",
  "function nullifiers(bytes32) view returns (bool)",
  "function nonceNullifiers(bytes32) view returns (bool)",
  "function claimsGroups(bytes32) view returns (uint128 totalLocked, uint128 totalClaimed, address token, uint8 tier)",
  "function owner() view returns (address)",
  "function relayerRegistry() view returns (address)",
  "function claimWithProof(uint256[2],uint256[2][2],uint256[2],bytes32,bytes32,uint256,address,address,uint256) external",
  "event ScatterDirectAuthSettled(bytes32 indexed nullifier, bytes32 indexed nonceNullifier, bytes32 claimsRoot, address indexed relayer, uint96 fee)",
  "event PrivateClaim(bytes32 indexed claimsRoot, bytes32 indexed nullifier, address indexed recipient, address token, uint256 amount)",
];

// ─── Main ──────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  E2E: scatterDirectAuth (N=${RECIPIENTS_N} recipients)`);
  console.log("═══════════════════════════════════════════════════════\n");
  const timing = new Timing();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const chainId = (await provider.getNetwork()).chainId;
  if (chainId !== 31337n && !process.env.E2E_ALLOW_NON_LOCAL) {
    throw new Error(`Refusing to run on chain ${chainId}. Set E2E_ALLOW_NON_LOCAL=1 to override.`);
  }

  const baseWallet = new ethers.Wallet(USER_KEY, provider);
  const wallet = new ethers.NonceManager(baseWallet);
  const userAddr = baseWallet.address;
  console.log(`User:       ${userAddr}`);
  console.log(`Pool:       ${POOL_ADDR}`);
  console.log(`Settlement: ${SETTLEMENT_ADDR}`);
  console.log(`USDC:       ${USDC_ADDRESS}\n`);

  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
  const pool = new ethers.Contract(POOL_ADDR, POOL_ABI, wallet);
  const settlement = new ethers.Contract(SETTLEMENT_ADDR, SETTLEMENT_ABI, wallet);

  // ─── Step 1: Wire MockAuthorizeVerifier + clear relayer registry ──
  console.log("[1/8] Setup — MockAuthorizeVerifier + clear RelayerRegistry...");
  const ownerAddr: string = await settlement.owner();
  await provider.send("anvil_impersonateAccount", [ownerAddr]);
  await provider.send("anvil_setBalance", [ownerAddr, ethers.toBeHex(ethers.parseEther("100"))]);
  const ownerSigner = await provider.getSigner(ownerAddr);
  const settlementAsOwner = new ethers.Contract(SETTLEMENT_ADDR, SETTLEMENT_ABI, ownerSigner);

  const MOCK_AUTH_ARTIFACT = path.join(
    __dirname,
    "../../contracts/out/MockAuthorizeVerifier.sol/MockAuthorizeVerifier.json",
  );
  const fs = await import("fs");
  if (!fs.existsSync(MOCK_AUTH_ARTIFACT)) {
    throw new Error(
      "MockAuthorizeVerifier artifact not found. Run `cd contracts && forge build --force` first.",
    );
  }
  const mockAuthBytecode = JSON.parse(fs.readFileSync(MOCK_AUTH_ARTIFACT, "utf8")).bytecode.object;
  const mockAuthFactory = new ethers.ContractFactory(
    ["function verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[15]) external view returns (bool)"],
    mockAuthBytecode,
    wallet,
  );
  const mockAuth = await mockAuthFactory.deploy();
  await mockAuth.waitForDeployment();
  const mockAuthAddr = await mockAuth.getAddress();
  await (await settlementAsOwner.setAuthorizeVerifier(TIER_16.cap, mockAuthAddr)).wait();
  console.log(`  ✓ MockAuthorizeVerifier wired: ${mockAuthAddr}`);

  // Clear the relayer registry — this test runs as a single user that
  // also acts as their own relayer (Pay self-pay model). The
  // contract's `onlyRelayer` modifier is bypassed when the registry
  // is unset.
  await (await settlementAsOwner.setRelayerRegistry(ethers.ZeroAddress)).wait();
  console.log(`  ✓ RelayerRegistry cleared (single-user test)`);

  // Stop impersonating before user-facing steps so any later misuse
  // of the owner role surfaces as a permission revert instead of
  // silently succeeding under the lingering impersonation.
  await provider.send("anvil_stopImpersonatingAccount", [ownerAddr]);
  timing.mark("setup (mock verifier + registry)");

  // ─── Step 2: Mint USDC + deposit ──────────────────────────
  console.log("\n[2/8] Mint USDC + deposit into CommitmentPool...");

  const depositAmount = ethers.parseEther("100"); // 100 USDC (mock token uses 18 decimals)
  await (await usdc.mint(userAddr, depositAmount)).wait();
  await (await usdc.approve(POOL_ADDR, ethers.MaxUint256)).wait();

  // EdDSA key
  const { eddsa, F } = await (async () => {
    const { eddsa: e, babyJub } = await getEdDSAImpl();
    return { eddsa: e, F: babyJub.F };
  })();
  const eddsaPrivKey = Buffer.from(
    ethers.keccak256(ethers.toUtf8Bytes("e2e-scatter-direct-key")).slice(2),
    "hex",
  );
  const pubKeyRaw = eddsa.prv2pub(eddsaPrivKey);
  const pubKeyAx = F.toObject(pubKeyRaw[0]);
  const pubKeyAy = F.toObject(pubKeyRaw[1]);

  const ownerSecret = randomFieldElement();
  const salt = randomFieldElement();
  const commitment = computeCommitmentV2(
    ownerSecret,
    BigInt(USDC_ADDRESS),
    depositAmount,
    salt,
    pubKeyAx,
    pubKeyAy,
  );

  const depositProof = await makeDepositProof({
    secret: ownerSecret,
    salt,
    token: USDC_ADDRESS,
    commitment,
    amount: depositAmount,
    pubKeyAx,
    pubKeyAy,
  });
  const depositTx = await pool.deposit(
    depositProof.a,
    depositProof.b,
    depositProof.c,
    commitment,
    USDC_ADDRESS,
    depositAmount,
  );
  const depositReceipt = await depositTx.wait();

  const poolIface = new ethers.Interface(POOL_ABI);
  let leafIndex = -1;
  for (const log of depositReceipt.logs) {
    try {
      const parsed = poolIface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "CommitmentInserted") leafIndex = Number(parsed.args.leafIndex);
    } catch {
      /* skip */
    }
  }
  assert(leafIndex >= 0, `Deposit at leaf #${leafIndex}`);
  timing.mark("deposit (proof + tx)");

  // ─── Step 3: Build authorize proof inputs (same-token!) ────
  console.log("\n[3/8] Building self-pay order (sellToken == buyToken)...");

  const sellAmount = ethers.parseEther("50"); // 50 USDC out
  const buyAmount = sellAmount;                // self-pay: same token, same amount
  const fee = 0n;
  const totalLocked = sellAmount;              // every wei goes to claims (no relayer fee)

  const latestBlock = await provider.getBlock("latest");
  const chainTime = BigInt(latestBlock!.timestamp);
  const expiry = chainTime + 86400n;
  const nonce = chainTime * 1000n + BigInt(Date.now() % 1000);
  const releaseTime = chainTime + 60n;

  const changeAmount = depositAmount - sellAmount;
  const changeSalt = randomFieldElement();

  // Spread `totalLocked` evenly across N recipients. Any rounding
  // remainder lands on the last recipient so the per-claim sum still
  // equals totalLocked exactly (the circuit + contract both check
  // this — a 1-wei drift fails the proof).
  const recipientAddrs = deterministicRecipients(RECIPIENTS_N);
  const perRecipient = totalLocked / BigInt(RECIPIENTS_N);
  const remainder = totalLocked - perRecipient * BigInt(RECIPIENTS_N);
  const claims = recipientAddrs.map((addr, i) => ({
    secret: randomFieldElement(),
    recipient: BigInt(addr),
    token: BigInt(USDC_ADDRESS),
    amount: i === RECIPIENTS_N - 1 ? perRecipient + remainder : perRecipient,
    releaseTime,
  }));

  // Build commitment tree from on-chain events. Scan from genesis
  // up to (and including) the deposit's own block — anvil's chain
  // is short-lived so genesis is fine, and the upper bound keeps the
  // tree state pinned to what the proof was built against (later
  // commitments would change the root).
  //
  // Pre-allocate by `leafIndex + 1` so out-of-order log delivery
  // can't grow the array past the deposit's index, and sort by
  // (block, transactionIndex, logIndex) so multi-deposit blocks
  // produce a stable order.
  const depositBlock = depositReceipt.blockNumber;
  const events = await pool.queryFilter(
    pool.filters.CommitmentInserted(),
    0,
    depositBlock,
  );
  events.sort(
    (a, b) =>
      a.blockNumber - b.blockNumber ||
      a.transactionIndex - b.transactionIndex ||
      a.index - b.index,
  );
  const leaves: bigint[] = new Array(leafIndex + 1).fill(0n);
  for (const ev of events) {
    const e = ev as ethers.EventLog;
    const idx = Number(e.args.leafIndex);
    if (idx < leaves.length) leaves[idx] = BigInt(e.args.commitment);
  }
  // Reference the SDK constant so this test breaks loudly if the
  // commitment-tree depth ever changes (it's consensus-critical and
  // must match circuits/IncrementalMerkleTree.sol).
  const commitTree = buildTree(leaves, COMMIT_TREE_DEPTH);
  const commitProof = getMerkleProof(commitTree.layers, leafIndex);

  // Claims tree — pad up to the tier capacity with the standard
  // `0n` dummy so the on-chain tree always carries `tier.cap` leaves.
  const claimLeafHashes = claims.map((c) =>
    poseidonHash([c.secret, c.recipient, c.token, c.amount, c.releaseTime]),
  );
  const paddedClaimLeaves = padClaims(claimLeafHashes, TIER_16, 0n);
  const { root: claimsRootValue, layers: claimsLayers } = buildTree(
    paddedClaimLeaves,
    CLAIMS_TREE_DEPTH,
  );

  const escrowNullifier = poseidonHash([TAG_ESCROW_NULL, ownerSecret, salt]);
  const nonceNullifier = poseidonHash([TAG_NONCE_NULL, ownerSecret, nonce]);
  const newCommitmentValue =
    changeAmount > 0n
      ? computeCommitmentV2(
          ownerSecret,
          BigInt(USDC_ADDRESS),
          changeAmount,
          changeSalt,
          pubKeyAx,
          pubKeyAy,
        )
      : 0n;

  const orderHash = poseidonHash([
    BigInt(USDC_ADDRESS),
    BigInt(USDC_ADDRESS), // buyToken == sellToken
    sellAmount,
    buyAmount,
    0n,
    expiry,
    nonce,
    claimsRootValue,
    BigInt(userAddr),
  ]);
  const sig = eddsa.signPoseidon(eddsaPrivKey, F.e(orderHash.toString()));

  // ─── Step 4: Generate authorize proof ──────────────────────
  console.log("\n[4/8] Generating authorize.circom proof (~5s)...");

  const proofResult = await makeAuthorizeProof({
    commitmentRoot: commitTree.root,
    secret: ownerSecret,
    balance: depositAmount,
    salt,
    path: commitProof.pathElements,
    pathIdx: commitProof.pathIndices,
    sellToken: BigInt(USDC_ADDRESS),
    buyToken: BigInt(USDC_ADDRESS), // ← same-token (Pay self-pay invariant)
    sellAmount,
    buyAmount,
    maxFee: 0n,
    expiry,
    nonce,
    newSalt: changeSalt,
    relayer: BigInt(userAddr),
    pubKeyAx,
    pubKeyAy,
    sigS: sig.S,
    sigR8x: F.toObject(sig.R8[0]),
    sigR8y: F.toObject(sig.R8[1]),
    claims,
    claimCount: claims.length,
    nullifier: escrowNullifier,
    nonceNullifier,
    newCommitment: newCommitmentValue,
    claimsRoot: claimsRootValue,
    totalLocked,
    orderHash,
  });

  const ps = proofResult.publicSignals;
  assert(ps.length === 15, `Proof has 15 public signals`);
  timing.mark("authorize proof (snarkjs)");

  // ─── Step 5: scatterDirectAuth via SDK helper ─────────────
  console.log("\n[5/8] Calling scatterDirectAuth...");

  // SDK's `callScatterDirectAuth` packs the AuthorizeProof tuple from
  // the proof result + side scalars and submits the tx. Same shape
  // Pay UI / Pro will use post-Phase-1b — keeping the test on the
  // same path proves the helper handles every field correctly.
  const side: SettleAuthSide = {
    proof: {
      // SDK's AuthorizeProofResult expects the Solidity-formatted
      // Groth16 tuple (proofA / proofB swapped pairs / proofC) under
      // `.proof.{a,b,c}`. The local `formatted` field already has
      // exactly that shape; the public signals are decimal strings
      // from snarkjs that need to be promoted to bigints.
      proof: {
        a: proofResult.formatted.proofA,
        b: proofResult.formatted.proofB,
        c: proofResult.formatted.proofC,
      },
      publicSignals: ps.map((s: string) => BigInt(s)),
      pubKeyBind: BigInt(ps[0]),
      commitmentRoot: BigInt(ps[1]),
      nullifier: BigInt(ps[2]),
      nonceNullifier: BigInt(ps[3]),
      newCommitment: BigInt(ps[4]),
      claimsRoot: BigInt(ps[11]),
      totalLocked: BigInt(ps[12]),
      orderHash: BigInt(ps[14]),
    },
    sellToken: USDC_ADDRESS,
    buyToken: USDC_ADDRESS,
    sellAmount,
    buyAmount,
    maxFee: 0n,
    expiry,
    relayer: userAddr,
    tier: TIER_16.cap,
  };
  const settleTx = await callScatterDirectAuth(wallet, SETTLEMENT_ADDR, side, fee);
  const settleReceipt = await settleTx.wait();
  assert(settleReceipt?.status === 1, `scatterDirectAuth tx: ${settleTx.hash}`);
  timing.mark("scatterDirectAuth tx");

  // ─── Step 6: Verify on-chain state ────────────────────────
  console.log("\n[6/8] Verifying on-chain state...");

  const escrowSpent = await settlement.nullifiers(toHex(BigInt(ps[2]), 32));
  assert(escrowSpent, "Escrow nullifier consumed");

  const nonceSpent = await settlement.nonceNullifiers(toHex(BigInt(ps[3]), 32));
  assert(nonceSpent, "Nonce nullifier consumed");

  const group = await settlement.claimsGroups(toHex(claimsRootValue, 32));
  assert(group.token.toLowerCase() === USDC_ADDRESS.toLowerCase(), `Claims group token = USDC`);
  assert(group.totalLocked === totalLocked, `Claims group locked = ${ethers.formatEther(group.totalLocked)} USDC`);
  // The headline check — multi-tier dispatch byte is recorded on the
  // group, exactly the way claimWithProof reads it back to pick a
  // claim verifier. PR #528's infrastructure end-to-end.
  assert(group.tier === BigInt(TIER_16.cap), `Claims group tier = ${group.tier} (expected ${TIER_16.cap})`);

  // ─── Step 7: Claim ────────────────────────────────────────
  console.log("\n[7/8] Generating claim proof + claimWithProof...");

  const currentBlock = await provider.getBlock("latest");
  const currentTime = BigInt(currentBlock!.timestamp);
  if (currentTime <= releaseTime) {
    await provider.send("evm_increaseTime", [Number(releaseTime - currentTime) + 1]);
    await provider.send("evm_mine", []);
  }

  // Claim only recipient #0 — the scatter step already proved every
  // recipient is reachable from the claims root, and timing the
  // single-recipient claim flow keeps the Step 7 measurement clean
  // (linear-in-N would obscure the per-claim cost).
  const claim = claims[0]!;
  const claimIdx = 0;
  const claimRecipient = recipientAddrs[claimIdx]!;
  const claimNullifier = poseidonHash([TAG_CLAIM_NULL, claim.secret, BigInt(claimIdx)]);
  const claimMerkleProof = getMerkleProof(claimsLayers, claimIdx);

  const snarkjs = await import("snarkjs");
  const CLAIM_WASM = path.join(__dirname, "../../circuits/build/claim_js/claim.wasm");
  const CLAIM_ZKEY = path.join(__dirname, "../../circuits/build/claim_final.zkey");
  const { proof: claimZkProof } = await snarkjs.groth16.fullProve(
    {
      claimsRoot: claimsRootValue.toString(),
      nullifier: claimNullifier.toString(),
      amount: claim.amount.toString(),
      token: BigInt(USDC_ADDRESS).toString(),
      recipient: BigInt(claimRecipient).toString(),
      releaseTime: claim.releaseTime.toString(),
      secret: claim.secret.toString(),
      leafIndex: claimIdx.toString(),
      pathElements: claimMerkleProof.pathElements.map((e) => e.toString()),
      pathIndices: claimMerkleProof.pathIndices.map((i) => i.toString()),
    },
    CLAIM_WASM,
    CLAIM_ZKEY,
  );

  const recipientUsdcBefore = (await usdc.balanceOf(claimRecipient)) as bigint;
  const claimTx = await settlement.claimWithProof(
    [claimZkProof.pi_a[0], claimZkProof.pi_a[1]],
    [
      [claimZkProof.pi_b[0][1], claimZkProof.pi_b[0][0]],
      [claimZkProof.pi_b[1][1], claimZkProof.pi_b[1][0]],
    ],
    [claimZkProof.pi_c[0], claimZkProof.pi_c[1]],
    toHex(claimsRootValue, 32),
    toHex(claimNullifier, 32),
    claim.amount,
    USDC_ADDRESS,
    claimRecipient,
    claim.releaseTime,
    { gasLimit: 1_000_000 },
  );
  await claimTx.wait();
  assert(true, `claimWithProof tx: ${claimTx.hash}`);
  timing.mark("claim (proof + tx)");

  // ─── Step 8: Verify recipient received USDC ───────────────
  console.log("\n[8/8] Verifying recipient balance...");

  const recipientUsdcAfter = (await usdc.balanceOf(claimRecipient)) as bigint;
  const delta = recipientUsdcAfter - recipientUsdcBefore;
  assert(delta === claim.amount, `Recipient delta = ${ethers.formatEther(delta)} USDC`);

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  ✅ E2E scatterDirectAuth — ALL 8 STEPS PASSED");
  console.log("═══════════════════════════════════════════════════════");
  timing.report();
}

main()
  .then(() => {
    // snarkjs holds open WASM worker references that prevent the node
    // event loop from draining naturally; force-exit after the main
    // promise resolves so a shell script wrapping this with `&&` can
    // proceed instead of hanging.
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n❌ E2E FAILED:", err.message);
    console.error(err);
    process.exit(1);
  });
