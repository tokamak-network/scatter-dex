#!/usr/bin/env node
/**
 * E2E test: deposit → withdraw round-trip via the real SDK
 * + CommitmentPool, parametrised by token.
 *
 *   TOKEN=WETH npx tsx apps/pro/scripts/e2e-deposit-withdraw.mjs
 *   TOKEN=USDC npx tsx apps/pro/scripts/e2e-deposit-withdraw.mjs
 *
 * Requires anvil running with the LocalDeploy contracts wired
 * (default `dev.sh --mock`) and the user account verified through
 * the IdentityGate (Pay/Pro identity flow already done in-session).
 *
 * Validates the on-chain path the modal uses (deposit proof + pool
 * verifier accept, withdraw proof + verifier accept, balance moves).
 * Does NOT exercise WETH.deposit{value}-then-wrap or
 * WETH.withdraw-then-unwrap — those wrap-around-the-pool calls are
 * a UI concern and work fine in the browser with MetaMask nonce
 * management; they only fail in this node script because ethers'
 * automatic nonce cache races with multiple back-to-back txs from
 * the same EOA.
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
const TOKENS = {
  WETH: { address: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318", decimals: 18, label: "WETH" },
  USDC: { address: "0x610178dA211FEF7D417bC0e6FeD39F05609AD788", decimals: 6, label: "USDC" },
};
const ANVIL_0_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ROOT = resolve(import.meta.dirname, "../../..");
const WASM = (c) => readFileSync(`${ROOT}/circuits/build/${c}_js/${c}.wasm`);
const ZKEY = (c) => readFileSync(`${ROOT}/circuits/build/${c}_final.zkey`);

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

const TOKEN_KEY = (process.env.TOKEN ?? "WETH").toUpperCase();
const TOKEN = TOKENS[TOKEN_KEY];
if (!TOKEN) {
  console.error(`Unknown TOKEN=${TOKEN_KEY}. Valid: ${Object.keys(TOKENS).join(", ")}`);
  process.exit(2);
}

function fmt(v) {
  return ethers.formatUnits(v, TOKEN.decimals);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const signer = new ethers.Wallet(ANVIL_0_PK, provider);
  const me = await signer.getAddress();
  console.log(`signer:  ${me}`);
  console.log(`token:   ${TOKEN.label} (${TOKEN.address})\n`);

  const erc20 = new ethers.Contract(TOKEN.address, ERC20_ABI, signer);
  const pool = new ethers.Contract(POOL, COMMITMENT_POOL_ABI, signer);

  const amount = 10n ** BigInt(TOKEN.decimals); // 1 token
  const startBal = await erc20.balanceOf(me);
  console.log(`start ${TOKEN.label}: ${fmt(startBal)}`);
  if (startBal < amount) {
    throw new Error(`insufficient ${TOKEN.label} (have ${fmt(startBal)}, need ${fmt(amount)})`);
  }

  // 1. eddsa + note
  const { keyPair } = await deriveEdDSAKey(signer);
  const note = generateNote(TOKEN.address, amount, keyPair.publicKey);
  const commitment = await computeCommitment(note);

  // 2. Approve pool
  console.log("\n[1] approve");
  await (await erc20.approve(POOL, amount)).wait();

  // 3. Hydrate pre-deposit tree
  console.log("[2] hydrate tree");
  const filter = pool.filters.CommitmentInserted();
  const events = await pool.queryFilter(filter, 0, "latest");
  const sorted = events
    .map((e) => ({
      leafIndex: Number(e.args.leafIndex),
      commitment: BigInt(e.args.commitment),
    }))
    .sort((a, b) => a.leafIndex - b.leafIndex);
  const preLeaves = sorted.map((e) => e.commitment);

  // 4. Deposit
  console.log("[3] deposit");
  const dp = await generateDepositProof(note, { wasm: WASM("deposit"), zkey: ZKEY("deposit") });
  const { a: da, b: db, c: dc } = dp.proof;
  const depTx = await pool.deposit(da, db, dc, dp.commitment, TOKEN.address, amount);
  const depReceipt = await depTx.wait();
  const myEvents = await pool.queryFilter(filter, depReceipt.blockNumber, depReceipt.blockNumber);
  const myEvent = myEvents.find((e) => BigInt(e.args.commitment) === commitment);
  if (!myEvent) throw new Error("commitment not inserted");
  const myLeafIndex = Number(myEvent.args.leafIndex);
  console.log(`     block ${depReceipt.blockNumber}, leafIndex ${myLeafIndex}`);

  // 5. Merkle proof
  console.log("[4] build merkle proof");
  const allLeaves = [...preLeaves, commitment];
  const built = await buildMerkleTree(allLeaves, 20);
  const path = getMerkleProof(built.layers, myLeafIndex);
  const merkleProof = {
    root: built.root,
    pathElements: path.pathElements,
    pathIndices: path.pathIndices,
  };
  const knownRoot = await pool.isKnownRoot(merkleProof.root);
  if (!knownRoot) throw new Error("root not known on-chain (tree drift)");

  // 6. Withdraw proof
  console.log("[5] withdraw proof");
  const wp = await generateWithdrawProof(
    { note, merkleProof, withdrawAmount: amount, recipient: me },
    { wasm: WASM("withdraw"), zkey: ZKEY("withdraw") },
  );

  // 7. Pool withdraw
  console.log("[6] pool.withdraw");
  const wTx = await pool.withdraw(
    wp.proof.a, wp.proof.b, wp.proof.c,
    wp.root, wp.nullifierHash, wp.newCommitment,
    TOKEN.address, amount, me,
    ethers.ZeroAddress,
  );
  const wReceipt = await wTx.wait();
  console.log(`     block ${wReceipt.blockNumber}, tx ${wTx.hash}`);

  // 8. Final
  const endBal = await erc20.balanceOf(me);
  const delta = endBal - startBal;
  console.log(`\nend   ${TOKEN.label}: ${fmt(endBal)}`);
  console.log(`delta:        ${fmt(delta)} (expected 0 — deposit then withdraw cancel)`);
  if (delta !== 0n) {
    throw new Error(`${TOKEN.label} delta non-zero (${fmt(delta)})`);
  }
  console.log(`\n✓ ${TOKEN.label} deposit → withdraw round-trip succeeded`);
}

main().catch((e) => {
  console.error("\n✗ FAILED:", e.message);
  if (e.data) console.error("  revert data:", e.data);
  process.exit(1);
});
