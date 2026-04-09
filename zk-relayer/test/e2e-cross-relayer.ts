#!/usr/bin/env tsx
/**
 * E2E test: Cross-relayer matching via shared orderbook.
 *
 * Prerequisites:
 *   1. anvil running on localhost:8545
 *   2. Contracts deployed (run: ./scripts/dev.sh --mock, then stop the relayer)
 *   3. Shared orderbook server on localhost:4000
 *      (cd shared-orderbook && npm run dev)
 *
 * Usage:
 *   cd zk-relayer && npx tsx test/e2e-cross-relayer.ts
 *
 * What this tests:
 *   - Two relayers (A and B) start with shared orderbook integration
 *   - User A deposits WETH and submits a sell-WETH/buy-USDC order to Relayer A
 *   - User B deposits USDC and submits a sell-USDC/buy-WETH order to Relayer B
 *   - Relayers discover the cross-relayer match via shared orderbook
 *   - Trade Offer protocol executes: Relayer B → Relayer A → settlement
 *   - Both users' orders are settled on-chain with a single ZK proof
 */

import { ethers } from "ethers";
import crypto from "node:crypto";
import path from "path";
import { fileURLToPath } from "url";
import { poseidon2, poseidon4, poseidon5, poseidon8, poseidon9 } from "poseidon-lite";
import { getEdDSA as getEdDSAImpl } from "../src/core/zk-prover.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ─────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL ?? "http://localhost:8545";
const SHARED_ORDERBOOK_URL = process.env.SHARED_ORDERBOOK_URL ?? "http://localhost:4000";
const FEE_BPS = 30n;
const CLAIMS_TREE_DEPTH = 4;
const CLAIMS_TREE_SIZE = 2 ** CLAIMS_TREE_DEPTH;

// Relayer A: Anvil Account #1 (default relayer)
const RELAYER_A_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const RELAYER_A_PORT = 3002;

// Relayer B: Anvil Account #2
const RELAYER_B_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const RELAYER_B_PORT = 3003;

// User A: Anvil Account #7
const USER_A_KEY = "0xa267530f49f8280200edf313ee7af6b827f2a8bce2897751d06a843f644967b1";
// User B: Anvil Account #8
const USER_B_KEY = "0x47c99abed3324a2707c28affff1267e45918ec8c3f20b8aa892e8b065d2942dd";

const RECIPIENT_A = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"; // Anvil #4
const RECIPIENT_B = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"; // Anvil #5

// ─── ABIs ───────────────────────────────────────────────────

const WETH_ABI = [
  "function deposit() external payable",
  "function approve(address,uint256) external returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

const ERC20_ABI = [
  "function approve(address,uint256) external returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address,uint256) external",
];

const POOL_ABI = [
  "function deposit(uint256 commitment, address token, uint256 amount) external",
  "function getLastRoot() view returns (uint256)",
  "function nextIndex() view returns (uint32)",
  "event CommitmentInserted(uint256 indexed commitment, uint32 leafIndex, uint256 timestamp)",
];

const SETTLEMENT_ABI = [
  "function claimNullifiers(bytes32) view returns (bool)",
  "function nullifiers(bytes32) view returns (bool)",
  "function feeVault() view returns (address)",
  "function weth() view returns (address)",
];

// ─── Helpers ────────────────────────────────────────────────

function poseidonHash(inputs: bigint[]): bigint {
  switch (inputs.length) {
    case 2: return poseidon2(inputs);
    case 4: return poseidon4(inputs);
    case 5: return poseidon5(inputs);
    case 8: return poseidon8(inputs);
    case 9: return poseidon9(inputs);
    default: throw new Error(`poseidonHash: unsupported arity ${inputs.length}`);
  }
}

async function getEdDSAWithField() {
  const { eddsa, babyJub } = await getEdDSAImpl();
  return { eddsa, F: babyJub.F };
}

const BN254_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function randomFieldElement(): bigint {
  let value: bigint;
  do {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    bytes[0] &= 0x3f;
    value = 0n;
    for (const b of bytes) value = (value << 8n) | BigInt(b);
  } while (value >= BN254_ORDER);
  return value;
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  [ok] ${msg}`);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 10_000) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

function buildTree(leaves: bigint[], depth: number) {
  const zeros: bigint[] = [0n];
  for (let i = 1; i <= depth; i++) zeros.push(poseidonHash([zeros[i - 1], zeros[i - 1]]));
  const size = 2 ** depth;
  const padded = [...leaves];
  while (padded.length < size) padded.push(zeros[0]);
  const layers: bigint[][] = [padded];
  let current = padded;
  for (let i = 0; i < depth; i++) {
    const next: bigint[] = [];
    for (let j = 0; j < current.length; j += 2) next.push(poseidonHash([current[j], current[j + 1]]));
    layers.push(next);
    current = next;
  }
  return { root: current[0], layers };
}

// ─── Order builder ──────────────────────────────────────────

interface OrderParams {
  sellToken: string;
  buyToken: string;
  sellAmount: bigint;
  buyAmount: bigint;
  ownerSecret: bigint;
  balance: bigint;
  salt: bigint;
  leafIndex: number;
  recipientAddr: string;
  relayerAddr: string;
  chainTime: bigint;
  eddsaPrivKey: Buffer;
}

async function buildOrder(params: OrderParams) {
  const { eddsa, F } = await getEdDSAWithField();
  const pubKey = eddsa.prv2pub(params.eddsaPrivKey);
  const pubKeyAx = F.toObject(pubKey[0]);
  const pubKeyAy = F.toObject(pubKey[1]);

  const fee = (params.sellAmount * FEE_BPS) / 10000n;
  const totalLocked = params.sellAmount - fee;
  const claimSecret = randomFieldElement();
  const recipientBig = BigInt(params.recipientAddr);
  const tokenBig = BigInt(params.sellToken);
  const releaseTime = params.chainTime + 60n;

  const claims = [
    { secret: claimSecret, recipient: recipientBig, token: tokenBig, amount: totalLocked, releaseTime },
  ];

  const claimLeaves = claims.map((c) =>
    poseidonHash([c.secret, c.recipient, c.token, c.amount, c.releaseTime])
  );
  const paddedLeaves = [...claimLeaves];
  while (paddedLeaves.length < CLAIMS_TREE_SIZE) paddedLeaves.push(0n);
  const { root: claimsRoot } = buildTree(paddedLeaves, CLAIMS_TREE_DEPTH);

  const changeSalt = randomFieldElement();
  const changeAmount = params.balance - params.sellAmount;
  const expectedChangeCommitment = poseidonHash([params.ownerSecret, tokenBig, changeAmount, changeSalt]);

  const nonceRand = BigInt("0x" + [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2,"0")).join(""));
  const nonce = params.chainTime * 10n ** 12n + nonceRand;
  const expiry = params.chainTime + 86400n;

  const orderHash = poseidonHash([
    BigInt(params.sellToken), BigInt(params.buyToken),
    params.sellAmount, params.buyAmount,
    FEE_BPS, expiry, nonce, claimsRoot,
    BigInt(params.relayerAddr),
  ]);

  const sig = eddsa.signPoseidon(params.eddsaPrivKey, F.e(orderHash.toString()));
  const sigR8x = F.toObject(sig.R8[0]);
  const sigR8y = F.toObject(sig.R8[1]);

  return {
    body: {
      sellToken: params.sellToken,
      buyToken: params.buyToken,
      sellAmount: params.sellAmount.toString(),
      buyAmount: params.buyAmount.toString(),
      maxFee: FEE_BPS.toString(),
      expiry: expiry.toString(),
      nonce: nonce.toString(),
      pubKeyAx: pubKeyAx.toString(),
      pubKeyAy: pubKeyAy.toString(),
      sigS: sig.S.toString(),
      sigR8x: sigR8x.toString(),
      sigR8y: sigR8y.toString(),
      ownerSecret: params.ownerSecret.toString(),
      balance: params.balance.toString(),
      salt: params.salt.toString(),
      leafIndex: params.leafIndex,
      newSalt: changeSalt.toString(),
      expectedChangeCommitment: expectedChangeCommitment.toString(),
      claims: claims.map((c) => ({
        secret: c.secret.toString(),
        recipient: c.recipient.toString(),
        token: c.token.toString(),
        amount: c.amount.toString(),
        releaseTime: c.releaseTime.toString(),
      })),
    },
    pubKeyAx,
    nonce,
  };
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  console.log("===============================================================");
  console.log("  E2E: Cross-Relayer Matching via Shared Orderbook");
  console.log("===============================================================\n");

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // Safety check
  const chainId = (await provider.getNetwork()).chainId;
  if (chainId !== 31337n) throw new Error(`Refusing to run on chain ${chainId}`);

  // ─── Step 1: Verify infrastructure ────────────────────────
  console.log("[1/7] Verifying infrastructure...");

  // Check shared orderbook server
  const obHealth = await fetchWithTimeout(`${SHARED_ORDERBOOK_URL}/health`).catch(() => null);
  assert(obHealth?.ok === true, `Shared orderbook server at ${SHARED_ORDERBOOK_URL}`);

  // Check Relayer A
  const infoA = await fetchWithTimeout(`http://localhost:${RELAYER_A_PORT}/api/info`).then(r => r.json()).catch(() => null);
  assert(infoA?.address != null, `Relayer A at port ${RELAYER_A_PORT} (${infoA?.address})`);

  // Check Relayer B
  const infoB = await fetchWithTimeout(`http://localhost:${RELAYER_B_PORT}/api/info`).then(r => r.json()).catch(() => null);
  assert(infoB?.address != null, `Relayer B at port ${RELAYER_B_PORT} (${infoB?.address})`);

  assert(infoA.address.toLowerCase() !== infoB.address.toLowerCase(), "Relayers have different addresses");

  const poolAddr = infoA.commitmentPool;
  const settlementAddr = infoA.privateSettlement;
  console.log(`  CommitmentPool: ${poolAddr}`);
  console.log(`  PrivateSettlement: ${settlementAddr}`);

  const settlementForWeth = new ethers.Contract(
    settlementAddr, ["function weth() view returns (address)"], provider,
  );
  const weth: string = await settlementForWeth.weth();
  console.log(`  WETH: ${weth}`);

  // Get USDC address from token list (or use env)
  const usdc = process.env.USDC_ADDRESS ?? infoA.tokens?.USDC;
  if (!usdc) throw new Error("USDC address not found — set USDC_ADDRESS env var");
  console.log(`  USDC: ${usdc}`);

  // ─── Step 2: Fund users + deposit into CommitmentPool ─────
  console.log("\n[2/7] Funding users and depositing into CommitmentPool...");

  const walletA = new ethers.Wallet(USER_A_KEY, provider);
  const walletB = new ethers.Wallet(USER_B_KEY, provider);

  const wethContract = new ethers.Contract(weth, WETH_ABI, walletA);
  const usdcContract = new ethers.Contract(usdc, ERC20_ABI, walletB);
  const poolContractA = new ethers.Contract(poolAddr, POOL_ABI, walletA);
  const poolContractB = new ethers.Contract(poolAddr, POOL_ABI, walletB);

  // User A: wrap ETH → WETH and deposit
  const wethAmount = ethers.parseEther("5");
  await (await wethContract.deposit({ value: wethAmount })).wait();
  await (await wethContract.approve(poolAddr, ethers.MaxUint256)).wait();

  const secretA = randomFieldElement();
  const saltA = randomFieldElement();
  const commitmentA = poseidonHash([secretA, BigInt(weth), wethAmount, saltA]);
  const depositTxA = await poolContractA.deposit(commitmentA, weth, wethAmount);
  const receiptA = await depositTxA.wait();
  const poolIface = new ethers.Interface(POOL_ABI);
  let leafIndexA = -1;
  for (const log of receiptA.logs) {
    try {
      const parsed = poolIface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "CommitmentInserted") leafIndexA = Number(parsed.args.leafIndex);
    } catch { /* skip non-matching logs */ }
  }
  assert(leafIndexA >= 0, `User A deposited 5 WETH at leaf #${leafIndexA}`);

  // User B: mint USDC and deposit (MockToken has public mint)
  const usdcAmount = ethers.parseUnits("10000", 18); // 10,000 USDC
  // Try minting — if MockToken, deployer can mint. Use anvil account #0.
  const deployer = new ethers.Wallet(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", provider
  );
  const usdcMint = new ethers.Contract(usdc, ERC20_ABI, deployer);
  await (await usdcMint.mint(walletB.address, usdcAmount)).wait();

  const usdcWithB = new ethers.Contract(usdc, ERC20_ABI, walletB);
  await (await usdcWithB.approve(poolAddr, ethers.MaxUint256)).wait();

  const secretB = randomFieldElement();
  const saltB = randomFieldElement();
  const commitmentB = poseidonHash([secretB, BigInt(usdc), usdcAmount, saltB]);
  const depositTxB = await poolContractB.deposit(commitmentB, usdc, usdcAmount);
  const receiptB = await depositTxB.wait();
  let leafIndexB = -1;
  for (const log of receiptB.logs) {
    try {
      const parsed = poolIface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "CommitmentInserted") leafIndexB = Number(parsed.args.leafIndex);
    } catch { /* skip non-matching logs */ }
  }
  assert(leafIndexB >= 0, `User B deposited 10,000 USDC at leaf #${leafIndexB}`);

  // Snapshot nextIndex after deposits (before settlement) for later comparison
  const poolReadOnly = new ethers.Contract(poolAddr, POOL_ABI, provider);
  const nextIndexAfterDeposits = Number(await poolReadOnly.nextIndex());

  // ─── Step 3: Build orders ─────────────────────────────────
  console.log("\n[3/7] Building orders...");

  const latestBlock = await provider.getBlock("latest");
  if (!latestBlock) throw new Error("Failed to fetch latest block");
  const chainTime = BigInt(latestBlock.timestamp);

  const eddsaKeyA = Buffer.from(ethers.keccak256(ethers.toUtf8Bytes("e2e-cross-user-a")).slice(2), "hex");
  const eddsaKeyB = Buffer.from(ethers.keccak256(ethers.toUtf8Bytes("e2e-cross-user-b")).slice(2), "hex");

  const sellWethAmount = ethers.parseEther("2");       // User A sells 2 WETH
  const buyUsdcAmount = ethers.parseUnits("4000", 18); // User A wants 4000 USDC
  const sellUsdcAmount = ethers.parseUnits("4000", 18); // User B sells 4000 USDC
  const buyWethAmount = ethers.parseEther("2");         // User B wants 2 WETH

  // User A: sell WETH, buy USDC → submits to Relayer A
  const orderA = await buildOrder({
    sellToken: weth,
    buyToken: usdc,
    sellAmount: sellWethAmount,
    buyAmount: buyUsdcAmount,
    ownerSecret: secretA,
    balance: wethAmount,
    salt: saltA,
    leafIndex: leafIndexA,
    recipientAddr: RECIPIENT_A,
    relayerAddr: infoA.address,
    chainTime,
    eddsaPrivKey: eddsaKeyA,
  });
  console.log(`  Order A: sell 2 WETH, buy 4000 USDC (nonce: ${orderA.nonce})`);

  // User B: sell USDC, buy WETH → submits to Relayer B
  const orderB = await buildOrder({
    sellToken: usdc,
    buyToken: weth,
    sellAmount: sellUsdcAmount,
    buyAmount: buyWethAmount,
    ownerSecret: secretB,
    balance: usdcAmount,
    salt: saltB,
    leafIndex: leafIndexB,
    recipientAddr: RECIPIENT_B,
    relayerAddr: infoB.address,
    chainTime,
    eddsaPrivKey: eddsaKeyB,
  });
  console.log(`  Order B: sell 4000 USDC, buy 2 WETH (nonce: ${orderB.nonce})`);

  // ─── Step 4: Submit order A to Relayer A ──────────────────
  console.log("\n[4/7] Submitting Order A to Relayer A...");

  const resA = await fetchWithTimeout(`http://localhost:${RELAYER_A_PORT}/api/private-orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(orderA.body),
  }, 30_000);
  const dataA = await resA.json() as Record<string, unknown>;
  if (!resA.ok) throw new Error(`Order A failed: ${JSON.stringify(dataA)}`);
  assert(typeof dataA.status === "string", `Order A has status field`);
  assert(dataA.status === "pending" || dataA.status === "settled", `Order A accepted (status: ${dataA.status})`);

  // ─── Step 5: Submit order B to Relayer B ──────────────────
  console.log("\n[5/7] Submitting Order B to Relayer B...");

  // Wait briefly for Relayer A to post to shared orderbook
  await sleep(2000);

  const resB = await fetchWithTimeout(`http://localhost:${RELAYER_B_PORT}/api/private-orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(orderB.body),
  }, 30_000);
  const dataB = await resB.json() as Record<string, unknown>;
  if (!resB.ok) throw new Error(`Order B failed: ${JSON.stringify(dataB)}`);
  assert(typeof dataB.status === "string", `Order B has status field`);
  console.log(`  Order B status: ${dataB.status}`);

  // ─── Step 6: Wait for cross-relayer settlement ────────────
  console.log("\n[6/7] Waiting for cross-relayer settlement...");

  let settled = false;
  let txHash = dataB.txHash as string | undefined;

  // If immediate cross-relayer match, it might already be settled
  if (dataB.status === "settled") {
    settled = true;
    console.log(`  Immediate cross-relayer settlement! TX: ${txHash}`);
  } else {
    // Poll both relayers for settlement (reactive matching may take a moment)
    const POLL_TIMEOUT = 60;
    for (let i = 0; i < POLL_TIMEOUT; i++) {
      await sleep(1000);

      const statusA = await fetchWithTimeout(
        `http://localhost:${RELAYER_A_PORT}/api/private-orders/${orderA.pubKeyAx}/${orderA.nonce}`
      ).then(r => r.json()).catch(() => null) as Record<string, unknown> | null;

      const statusB = await fetchWithTimeout(
        `http://localhost:${RELAYER_B_PORT}/api/private-orders/${orderB.pubKeyAx}/${orderB.nonce}`
      ).then(r => r.json()).catch(() => null) as Record<string, unknown> | null;

      if (statusA?.status === "settled" || statusB?.status === "settled") {
        txHash = (statusA?.settleTxHash || statusB?.settleTxHash) as string;
        settled = true;
        break;
      }

      if (i % 10 === 0 && i > 0) process.stdout.write(".");
    }
    if (!settled) console.log(""); // newline after dots
  }

  assert(settled, `Cross-relayer settlement completed! TX: ${txHash}`);

  // ─── Step 7: Verify on-chain state ────────────────────────
  console.log("\n[7/7] Verifying on-chain state...");

  const settlementContract = new ethers.Contract(settlementAddr, SETTLEMENT_ABI, provider);

  // Verify nullifiers are spent (both maker and taker notes consumed)
  const nullA = poseidonHash([secretA, saltA]);
  const nullB = poseidonHash([secretB, saltB]);
  const nullASpent = await settlementContract.nullifiers(
    "0x" + nullA.toString(16).padStart(64, "0")
  );
  const nullBSpent = await settlementContract.nullifiers(
    "0x" + nullB.toString(16).padStart(64, "0")
  );

  assert(nullASpent, "User A's note nullifier is spent");
  assert(nullBSpent, "User B's note nullifier is spent");

  // Verify settlement created new change commitments
  const poolContractRead = new ethers.Contract(poolAddr, POOL_ABI, provider);
  const nextIndexAfterSettle = Number(await poolContractRead.nextIndex());
  assert(nextIndexAfterSettle > nextIndexAfterDeposits,
    `Settlement created ${nextIndexAfterSettle - nextIndexAfterDeposits} new commitment(s) (${nextIndexAfterDeposits} → ${nextIndexAfterSettle})`);

  // Verify FeeVault received fees (check both relayers — settling relayer earns the fee)
  const feeVaultAddr: string = await settlementContract.feeVault();
  if (feeVaultAddr !== ethers.ZeroAddress) {
    const FEE_VAULT_ABI = ["function balances(address,address) view returns (uint256)"];
    const vaultContract = new ethers.Contract(feeVaultAddr, FEE_VAULT_ABI, provider);
    // Maker's relayer (A) settles, so fees go to Relayer A
    const relayerAFeeWeth = await vaultContract.balances(infoA.address, weth);
    const relayerAFeeUsdc = await vaultContract.balances(infoA.address, usdc);
    // Also check Relayer B in case settlement was initiated by B
    const relayerBFeeWeth = await vaultContract.balances(infoB.address, weth);
    const relayerBFeeUsdc = await vaultContract.balances(infoB.address, usdc);
    const totalFee = relayerAFeeWeth + relayerAFeeUsdc + relayerBFeeWeth + relayerBFeeUsdc;
    console.log(`  FeeVault Relayer A: ${ethers.formatEther(relayerAFeeWeth)} WETH, ${ethers.formatUnits(relayerAFeeUsdc, 18)} USDC`);
    console.log(`  FeeVault Relayer B: ${ethers.formatEther(relayerBFeeWeth)} WETH, ${ethers.formatUnits(relayerBFeeUsdc, 18)} USDC`);
    assert(totalFee > 0n, "FeeVault received settlement fees from settling relayer");
  }

  console.log("\n===============================================================");
  console.log("  Cross-relayer E2E test PASSED!");
  console.log("===============================================================\n");
}

main().catch((err) => {
  console.error("\nE2E FAILED:", err.message || err);
  process.exit(1);
});
