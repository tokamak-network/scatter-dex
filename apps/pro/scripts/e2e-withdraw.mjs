#!/usr/bin/env node
/**
 * E2E test: deposit ETH → wait for inclusion → withdraw → unwrap →
 * verify native ETH balance increased.
 *
 * Run from repo root with the dev stack already up:
 *   node apps/pro/scripts/e2e-withdraw.mjs
 *
 * Requires anvil running with the LocalDeploy contracts wired in
 * (default `dev.sh --mock` configuration).
 */
import { ethers } from "ethers";
import {
  computeCommitment,
  generateDepositProof,
  generateWithdrawProof,
  generateNote,
  buildMerkleTree,
  getMerkleProof,
  deriveEdDSAKey,
} from "@zkscatter/sdk/zk";
import { COMMITMENT_POOL_ABI } from "@zkscatter/sdk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RPC = "http://localhost:8545";
const POOL = "0x95401dc811bb5740090279Ba06cfA8fcF6113778";
const WETH = "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318";
const ANVIL_0_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const ROOT = resolve(import.meta.dirname, "../../..");
const WASM = (c) => readFileSync(`${ROOT}/circuits/build/${c}_js/${c}.wasm`);
const ZKEY = (c) => readFileSync(`${ROOT}/circuits/build/${c}_final.zkey`);

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function deposit() payable",
  "function withdraw(uint256)",
];

function logBalance(label, v) {
  console.log(`  ${label.padEnd(28)} ${ethers.formatEther(v)} ETH`);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const signer = new ethers.Wallet(ANVIL_0_PK, provider);
  const me = await signer.getAddress();
  console.log(`signer: ${me}`);

  const weth = new ethers.Contract(WETH, ERC20_ABI, signer);
  const pool = new ethers.Contract(POOL, COMMITMENT_POOL_ABI, signer);

  const startNative = await provider.getBalance(me);
  const startWeth = await weth.balanceOf(me);
  console.log("\n=== Start balances ===");
  logBalance("native ETH", startNative);
  logBalance("WETH", startWeth);

  // ── 1. Wrap 1 ETH ─────────────────────────────────────────
  console.log("\n=== 1. Wrap 1 ETH → WETH ===");
  const amount = 10n ** 18n;
  let tx = await weth.deposit({ value: amount });
  await tx.wait();
  console.log(`  wrap tx: ${tx.hash}`);

  // ── 2. Derive eddsa + generate note ───────────────────────
  console.log("\n=== 2. Derive eddsa key + generate note ===");
  const { keyPair } = await deriveEdDSAKey(signer);
  const note = generateNote(WETH, amount, keyPair.publicKey);
  const commitment = await computeCommitment(note);
  console.log(`  commitment: 0x${commitment.toString(16)}`);

  // ── 3. Approve pool to pull WETH ──────────────────────────
  console.log("\n=== 3. Approve pool ===");
  tx = await weth.approve(POOL, amount);
  await tx.wait();

  // ── 4. Build pre-deposit tree from on-chain CommitmentInserted events ──
  console.log("\n=== 4. Hydrate pool tree from chain ===");
  const filter = pool.filters.CommitmentInserted();
  const events = await pool.queryFilter(filter, 0, "latest");
  const sorted = events
    .map((e) => ({
      leafIndex: Number(e.args.leafIndex),
      commitment: BigInt(e.args.commitment),
    }))
    .sort((a, b) => a.leafIndex - b.leafIndex);
  const leaves = sorted.map((e) => e.commitment);
  console.log(`  ${leaves.length} commitments on-chain`);

  // ── 5. Deposit ────────────────────────────────────────────
  console.log("\n=== 5. Generate deposit proof + call pool.deposit ===");
  const depositAssets = { wasm: WASM("deposit"), zkey: ZKEY("deposit") };
  const depositProof = await generateDepositProof(note, depositAssets);
  const { a, b, c } = depositProof.proof;
  tx = await pool.deposit(a, b, c, depositProof.commitment, WETH, amount);
  const depositReceipt = await tx.wait();
  console.log(`  deposit tx: ${tx.hash} (block ${depositReceipt.blockNumber})`);

  // Read the leafIndex from the just-emitted event
  const newEvents = await pool.queryFilter(filter, depositReceipt.blockNumber, depositReceipt.blockNumber);
  const myEvent = newEvents.find(
    (e) => BigInt(e.args.commitment) === commitment,
  );
  if (!myEvent) throw new Error("CommitmentInserted not found for our commitment");
  const myLeafIndex = Number(myEvent.args.leafIndex);
  console.log(`  my leafIndex: ${myLeafIndex}`);

  // ── 6. Build merkle proof from all on-chain leaves ───────
  console.log("\n=== 6. Build merkle proof ===");
  const allLeaves = [...leaves, commitment];
  const built = await buildMerkleTree(allLeaves, 20);
  const path = getMerkleProof(built.layers, myLeafIndex);
  const merkleProof = {
    root: built.root,
    pathElements: path.pathElements,
    pathIndices: path.pathIndices,
  };
  console.log(`  root: 0x${built.root.toString(16)}`);

  const knownRoot = await pool.isKnownRoot(merkleProof.root);
  console.log(`  isKnownRoot: ${knownRoot}`);
  if (!knownRoot) throw new Error("root not known on-chain — tree drift");

  // ── 7. Withdraw proof ────────────────────────────────────
  console.log("\n=== 7. Generate withdraw proof ===");
  const withdrawAssets = { wasm: WASM("withdraw"), zkey: ZKEY("withdraw") };
  const wp = await generateWithdrawProof(
    { note, merkleProof, withdrawAmount: amount, recipient: me },
    withdrawAssets,
  );
  console.log(`  root match: ${wp.root === merkleProof.root}`);
  console.log(`  nullifierHash: 0x${wp.nullifierHash.toString(16)}`);

  // ── 8. Pool withdraw ─────────────────────────────────────
  console.log("\n=== 8. Call pool.withdraw ===");
  tx = await pool.withdraw(
    wp.proof.a,
    wp.proof.b,
    wp.proof.c,
    wp.root,
    wp.nullifierHash,
    wp.newCommitment,
    WETH,
    amount,
    me,
    ethers.ZeroAddress,
  );
  const wReceipt = await tx.wait();
  console.log(`  withdraw tx: ${tx.hash} (block ${wReceipt.blockNumber})`);

  // ── 9. Unwrap WETH → native ──────────────────────────────
  console.log("\n=== 9. Unwrap WETH → native ===");
  tx = await weth.withdraw(amount);
  await tx.wait();
  console.log(`  unwrap tx: ${tx.hash}`);

  // ── 10. Final balances ───────────────────────────────────
  const endNative = await provider.getBalance(me);
  const endWeth = await weth.balanceOf(me);
  console.log("\n=== End balances ===");
  logBalance("native ETH", endNative);
  logBalance("WETH", endWeth);

  const nativeDiff = endNative - startNative;
  const wethDiff = endWeth - startWeth;
  console.log("\n=== Delta ===");
  logBalance("native ETH delta", nativeDiff);
  logBalance("WETH delta", wethDiff);

  // After wrap(+1) → deposit(-1) → withdraw(+1) → unwrap(-1) we end up
  // with native ETH unchanged minus gas, WETH unchanged. So delta should
  // be roughly -gas on native (tiny negative) and 0 on WETH.
  const tol = 10n ** 17n; // 0.1 ETH gas tolerance
  if (-nativeDiff > tol) {
    throw new Error(`native ETH dropped by more than 0.1 ETH (gas): ${ethers.formatEther(nativeDiff)}`);
  }
  if (wethDiff !== 0n) {
    throw new Error(`WETH balance changed (expected 0): ${ethers.formatEther(wethDiff)}`);
  }
  console.log("\n✓ E2E round-trip succeeded (deposit → withdraw → unwrap)");
  console.log("  native ETH delta ≈ -gas, WETH unchanged");
}

main().catch((e) => {
  console.error("\n✗ FAILED:", e.message);
  if (e.data) console.error("  revert data:", e.data);
  process.exit(1);
});
