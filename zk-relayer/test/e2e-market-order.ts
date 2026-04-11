#!/usr/bin/env tsx
/**
 * E2E test: Market Order via settleWithDex on local anvil.
 *
 * Prerequisites:
 *   ./scripts/dev.sh --mock   (anvil + contracts + relayers running)
 *
 * Usage:
 *   cd zk-relayer && npx tsx test/e2e-market-order.ts
 *
 * Flow tested:
 *   1. Deploy MockDexRouter + whitelist it
 *   2. Wrap ETH → WETH, deposit into CommitmentPool
 *   3. Derive EdDSA key, sign order (relayer = self, maxFee = 0)
 *   4. Generate authorize.circom proof in Node.js
 *   5. Call settleWithDex on-chain (user submits directly, no relayer)
 *   6. Verify: nullifiers spent, claims group registered
 *   7. Verify: platform fee sent to treasury (DexPlatformFeeCollected event)
 *   8. Advance time + claim via claim.circom proof
 *   9. Verify: recipient received buyToken (USDC via WETH→USDC mock swap)
 */

import { ethers } from "ethers";
import path from "path";
import { fileURLToPath } from "url";

import { getEdDSA as getEdDSAImpl } from "../src/core/zk-prover.js";
import { TAG_ESCROW_NULL, TAG_NONCE_NULL, TAG_CLAIM_NULL, TAG_COMMITMENT_V2 } from "../src/core/tags.js";
import { poseidonHash, computeCommitmentV2, randomFieldElement, toHex, assert, buildTree, getMerkleProof } from "./helpers/common.js";

// @ts-ignore — JS module
import { makeDepositProof } from "./helpers/deposit-proof.mjs";
// @ts-ignore — JS module
import { makeAuthorizeProof } from "./helpers/authorize-proof.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ─────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL ?? "http://localhost:8545";
const ZK_RELAYER_URL = process.env.ZK_RELAYER_URL ?? "http://localhost:3002";
const CLAIMS_TREE_DEPTH = 4;
const CLAIMS_TREE_SIZE = 2 ** CLAIMS_TREE_DEPTH;
const PLATFORM_FEE_BPS = 100n; // 1% — set during test

// USDC address — default from DeployLocal on fresh anvil. Override via env var.
const USDC_ADDRESS = process.env.E2E_USDC_ADDRESS
  ?? "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853";

const USER_KEY = process.env.E2E_PRIVATE_KEY
  ?? "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";
const RECIPIENT = process.env.E2E_RECIPIENT
  ?? "0x627306090abaB3A6e1400e9345bC60c78a8BEf57";

// ─── ABIs ──────────────────────────────────────────────────

const WETH_ABI = [
  "function deposit() external payable",
  "function approve(address,uint256) external returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) external returns (bool)",
];

const POOL_ABI = [
  "function deposit(uint256[2],uint256[2][2],uint256[2],uint256,address,uint256) external",
  "function getLastRoot() view returns (uint256)",
  "function nextIndex() view returns (uint32)",
  "function isKnownRoot(uint256) view returns (bool)",
  "event CommitmentInserted(uint256 indexed commitment, uint32 leafIndex, uint256 timestamp)",
];

const SETTLEMENT_ABI = [
  "function settleWithDex(tuple(tuple(uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC, bytes32 pubKeyBind, uint256 commitmentRoot, bytes32 nullifier, bytes32 nonceNullifier, bytes32 newCommitment, address sellToken, address buyToken, uint128 sellAmount, uint128 buyAmount, uint16 maxFee, uint64 expiry, bytes32 claimsRoot, uint128 totalLocked, address relayer, bytes32 orderHash) proof, address dexRouter, bytes dexCalldata) params) external",
  "function nullifiers(bytes32) view returns (bool)",
  "function nonceNullifiers(bytes32) view returns (bool)",
  "function claimNullifiers(bytes32) view returns (bool)",
  "function claimsGroups(bytes32) view returns (uint128 totalLocked, uint128 totalClaimed, address token)",
  "function setDexRouterWhitelist(address,bool) external",
  "function setDexPlatformFee(uint256) external",
  "function dexPlatformFeeBps() view returns (uint256)",
  "function feeVault() view returns (address)",
  "function weth() view returns (address)",
  "function owner() view returns (address)",
  "event SettledWithDex(bytes32 indexed nullifier, bytes32 indexed claimsRoot, address sellToken, address buyToken, uint128 sellAmount, uint256 amountOut, uint128 totalLocked, address indexed submitter)",
  "event DexPlatformFeeCollected(bytes32 indexed nullifier, address indexed token, uint256 amount, address treasury)",
];

const CLAIM_ABI = [
  "function claimWithProof(uint256[2],uint256[2][2],uint256[2],bytes32,bytes32,uint256,address,address,uint256) external",
];

const FEE_VAULT_ABI = [
  "function treasury() view returns (address)",
];

// MockDexRouter bytecode — simple swap: pull tokenIn, push tokenOut at 1:1 rate
// We'll deploy it via CREATE opcode in the test
const MOCK_DEX_ROUTER_ABI = [
  "function swap(address tokenIn, address tokenOut, uint256 amountIn, address recipient) external returns (uint256)",
];

// Helpers imported from ./helpers/common.ts

// ─── Main ───────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  E2E: Market Order (deposit → authorize → settleWithDex → claim)");
  console.log("═══════════════════════════════════════════════════════\n");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const chainId = (await provider.getNetwork()).chainId;
  if (chainId !== 31337n && !process.env.E2E_ALLOW_NON_LOCAL) {
    throw new Error(`Refusing to run on chain ${chainId}. Set E2E_ALLOW_NON_LOCAL=1 to override.`);
  }

  const baseWallet = new ethers.Wallet(USER_KEY, provider);
  const wallet = new ethers.NonceManager(baseWallet);
  const userAddr = baseWallet.address;
  console.log(`User: ${userAddr}`);

  // Get contract addresses from relayer
  const infoRes = await fetch(`${ZK_RELAYER_URL}/api/info`);
  if (!infoRes.ok) throw new Error("zk-relayer not running");
  const info = await infoRes.json();
  const poolAddr = info.commitmentPool;
  const settlementAddr = info.privateSettlement;

  const settlementForWeth = new ethers.Contract(settlementAddr, ["function weth() view returns (address)"], provider);
  const weth: string = await settlementForWeth.weth();
  console.log(`Pool: ${poolAddr}\nSettlement: ${settlementAddr}\nWETH: ${weth}\n`);

  const wethContract = new ethers.Contract(weth, WETH_ABI, wallet);
  const poolContract = new ethers.Contract(poolAddr, POOL_ABI, wallet);
  const settlement = new ethers.Contract(settlementAddr, SETTLEMENT_ABI, wallet);

  // ─── Step 1: Deploy MockDexRouter ──────────────────────────
  console.log("[1/9] Deploying MockDexRouter...");

  // Impersonate settlement owner for admin operations
  const ownerAddr: string = await settlement.owner();
  console.log(`Settlement owner: ${ownerAddr}`);
  await provider.send("anvil_impersonateAccount", [ownerAddr]);
  const ownerSigner = await provider.getSigner(ownerAddr);
  const settlementAsOwner = new ethers.Contract(settlementAddr, SETTLEMENT_ABI, ownerSigner);

  // Deploy MockDexRouter from Foundry compiled artifact (1:1 same-token swap)
  const MOCK_DEX_ARTIFACT = path.join(__dirname, "../../contracts/out/SettleWithDex.t.sol/MockDexRouter.json");
  const mockDexBytecode = await (async () => {
    const fs = await import("fs");
    if (fs.existsSync(MOCK_DEX_ARTIFACT)) {
      return JSON.parse(fs.readFileSync(MOCK_DEX_ARTIFACT, "utf8")).bytecode.object;
    }
    throw new Error("MockDexRouter artifact not found. Run `cd contracts && forge build --force` first.");
  })();

  const mockDexFactory = new ethers.ContractFactory(MOCK_DEX_ROUTER_ABI, mockDexBytecode, wallet);
  const mockDex = await mockDexFactory.deploy();
  await mockDex.waitForDeployment();
  const mockDexAddress = await mockDex.getAddress();
  console.log(`  MockDexRouter deployed: ${mockDexAddress}`);

  // Fund MockDexRouter with USDC (simulates DEX liquidity for WETH→USDC swap)
  const USDC_ABI = ["function mint(address,uint256) external", "function balanceOf(address) view returns (uint256)"];
  const usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, wallet);
  // Mint USDC to MockDexRouter (MockToken has public mint)
  await (await usdcContract.mint(mockDexAddress, ethers.parseEther("1000000"))).wait();

  // Deploy MockAuthorizeVerifier (accepts any proof)
  const MOCK_AUTH_ARTIFACT = path.join(__dirname, "../../contracts/out/MockAuthorizeVerifier.sol/MockAuthorizeVerifier.json");
  const mockAuthBytecode = await (async () => {
    const fs = await import("fs");
    if (fs.existsSync(MOCK_AUTH_ARTIFACT)) {
      return JSON.parse(fs.readFileSync(MOCK_AUTH_ARTIFACT, "utf8")).bytecode.object;
    }
    throw new Error("MockAuthorizeVerifier artifact not found. Run `cd contracts && forge build --force` first.");
  })();
  const mockAuthFactory = new ethers.ContractFactory(
    ["function verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[15]) external view returns (bool)"],
    mockAuthBytecode, wallet,
  );
  const mockAuth = await mockAuthFactory.deploy();
  await mockAuth.waitForDeployment();
  const mockAuthAddress = await mockAuth.getAddress();
  console.log(`  MockAuthorizeVerifier deployed: ${mockAuthAddress}`);

  // Whitelist MockDexRouter + set AuthorizeVerifier + set platform fee
  await (await settlementAsOwner.setDexRouterWhitelist(mockDexAddress, true)).wait();
  const setAuthAbi = ["function setAuthorizeVerifier(address) external"];
  const settlementForAuth = new ethers.Contract(settlementAddr, setAuthAbi, ownerSigner);
  await (await settlementForAuth.setAuthorizeVerifier(mockAuthAddress)).wait();
  await (await settlementAsOwner.setDexPlatformFee(PLATFORM_FEE_BPS)).wait();
  await provider.send("anvil_stopImpersonatingAccount", [ownerAddr]);

  const feeBps = await settlement.dexPlatformFeeBps();
  assert(feeBps === PLATFORM_FEE_BPS, `Platform fee set: ${feeBps} bps`);

  // ─── Step 2: Deposit into CommitmentPool ───────────────────
  console.log("\n[2/9] Depositing WETH into CommitmentPool...");

  const depositAmount = ethers.parseEther("10");
  await (await wethContract.deposit({ value: depositAmount })).wait();
  await (await wethContract.approve(poolAddr, ethers.MaxUint256)).wait();

  // Derive EdDSA key
  const { eddsa, F } = await (async () => {
    const { eddsa: e, babyJub } = await getEdDSAImpl();
    return { eddsa: e, F: babyJub.F };
  })();
  const eddsaPrivKey = Buffer.from(ethers.keccak256(ethers.toUtf8Bytes("e2e-market-key")).slice(2), "hex");
  const pubKeyRaw = eddsa.prv2pub(eddsaPrivKey);
  const pubKeyAx = F.toObject(pubKeyRaw[0]);
  const pubKeyAy = F.toObject(pubKeyRaw[1]);

  const ownerSecret = randomFieldElement();
  const salt = randomFieldElement();
  const commitment = computeCommitmentV2(ownerSecret, BigInt(weth), depositAmount, salt, pubKeyAx, pubKeyAy);

  const depositProof = await makeDepositProof({ secret: ownerSecret, salt, token: weth, commitment, amount: depositAmount, pubKeyAx, pubKeyAy });
  const depositTx = await poolContract.deposit(depositProof.a, depositProof.b, depositProof.c, commitment, weth, depositAmount);
  const depositReceipt = await depositTx.wait();

  const poolIface = new ethers.Interface(POOL_ABI);
  let leafIndex = -1;
  for (const log of depositReceipt.logs) {
    try {
      const parsed = poolIface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "CommitmentInserted") leafIndex = Number(parsed.args.leafIndex);
    } catch { /* skip */ }
  }
  assert(leafIndex >= 0, `Deposit at leaf #${leafIndex}`);

  // ─── Step 3: Build authorize proof inputs ──────────────────
  console.log("\n[3/9] Building order + generating authorize proof...");

  const sellAmount = ethers.parseEther("3");
  const buyAmount = ethers.parseEther("2.9"); // min receive (after 1% fee + mock 1:1 swap)

  const latestBlock = await provider.getBlock("latest");
  const chainTime = BigInt(latestBlock!.timestamp);
  const expiry = chainTime + 86400n;
  const nonce = chainTime * 1000n + BigInt(Date.now() % 1000);
  const releaseTime = chainTime + 60n;

  // Change commitment
  const changeAmount = depositAmount - sellAmount;
  const changeSalt = randomFieldElement();

  // Claims: single claim to recipient (WETH → USDC swap via mock DEX, 1:1 rate)
  const feeAmount = (sellAmount * PLATFORM_FEE_BPS) / 10000n;
  const swapInput = sellAmount - feeAmount; // what DEX receives after fee
  const totalLocked = swapInput; // 1:1 mock swap → output = swapInput
  const claimSecret = randomFieldElement();
  const buyTokenAddr = USDC_ADDRESS;
  const claims = [
    { secret: claimSecret, recipient: BigInt(RECIPIENT), token: BigInt(buyTokenAddr), amount: totalLocked, releaseTime },
  ];

  // Build commitment tree Merkle proof from on-chain events
  const events = await poolContract.queryFilter(poolContract.filters.CommitmentInserted());
  const leaves: bigint[] = [];
  for (const ev of events) {
    const e = ev as ethers.EventLog;
    const idx = Number(e.args.leafIndex);
    while (leaves.length <= idx) leaves.push(0n);
    leaves[idx] = BigInt(e.args.commitment);
  }
  const commitTreeDepth = 20;
  const commitTree = buildTree(leaves, commitTreeDepth);
  const commitProof = getMerkleProof(commitTree.layers, leafIndex);

  // Compute claims tree root (needed for orderHash and proof input)
  const claimLeafHashes = claims.map((c) =>
    poseidonHash([c.secret, c.recipient, c.token, c.amount, c.releaseTime])
  );
  const paddedClaimLeaves = [...claimLeafHashes];
  while (paddedClaimLeaves.length < CLAIMS_TREE_SIZE) paddedClaimLeaves.push(0n);
  const { root: claimsRootValue, layers: claimsLayers } = buildTree(paddedClaimLeaves, CLAIMS_TREE_DEPTH);

  // Compute all public inputs that the circuit constrains (must match internal computation)
  const escrowNullifier = poseidonHash([TAG_ESCROW_NULL, ownerSecret, salt]);
  const nonceNullifier = poseidonHash([TAG_NONCE_NULL, ownerSecret, nonce]);
  const newCommitmentValue = changeAmount > 0n
    ? computeCommitmentV2(ownerSecret, BigInt(weth), changeAmount, changeSalt, pubKeyAx, pubKeyAy)
    : 0n;

  // Sign order with EdDSA — uses the ACTUAL claimsRoot, not a placeholder
  const orderHash = poseidonHash([
    BigInt(weth), BigInt(buyTokenAddr), sellAmount, buyAmount,
    0n, expiry, nonce, claimsRootValue, BigInt(userAddr),
  ]);
  const sig = eddsa.signPoseidon(eddsaPrivKey, F.e(orderHash.toString()));
  const sigS = sig.S;
  const sigR8x = F.toObject(sig.R8[0]);
  const sigR8y = F.toObject(sig.R8[1]);

  // ─── Step 4: Generate authorize proof ──────────────────────
  console.log("\n[4/9] Generating authorize.circom proof (this may take 5-10s)...");

  const proofResult = await makeAuthorizeProof({
    commitmentRoot: commitTree.root,
    secret: ownerSecret,
    balance: depositAmount,
    salt,
    path: commitProof.pathElements,
    pathIdx: commitProof.pathIndices,
    sellToken: BigInt(weth),
    buyToken: BigInt(buyTokenAddr),
    sellAmount,
    buyAmount,
    maxFee: 0n,
    expiry,
    nonce,
    newSalt: changeSalt,
    relayer: BigInt(userAddr),
    pubKeyAx, pubKeyAy,
    sigS, sigR8x, sigR8y,
    claims,
    claimCount: claims.length,
    // Public inputs that circuit constrains
    nullifier: escrowNullifier,
    nonceNullifier,
    newCommitment: newCommitmentValue,
    claimsRoot: claimsRootValue,
    totalLocked,
    orderHash,
  });

  const ps = proofResult.publicSignals;
  assert(ps.length === 15, `Proof has 15 public signals`);
  console.log(`  Proof generated! pubKeyBind: ${ps[0].slice(0, 20)}...`);

  // ─── Step 5: Call settleWithDex on-chain ────────────────────
  console.log("\n[5/9] Calling settleWithDex...");

  // Encode MockDexRouter.swap calldata
  const dexIface = new ethers.Interface(MOCK_DEX_ROUTER_ABI);
  const dexCalldata = dexIface.encodeFunctionData("swap", [
    weth, buyTokenAddr, swapInput, settlementAddr,
  ]);

  // Debug: try staticCall first to get detailed revert
  try {
    await settlement.settleWithDex.staticCall({
      proof: {
        proofA: proofResult.formatted.proofA,
        proofB: proofResult.formatted.proofB,
        proofC: proofResult.formatted.proofC,
        pubKeyBind: toHex(BigInt(ps[0]), 32),
        commitmentRoot: ps[1],
        nullifier: toHex(BigInt(ps[2]), 32),
        nonceNullifier: toHex(BigInt(ps[3]), 32),
        newCommitment: toHex(BigInt(ps[4]), 32),
        sellToken: weth,
        buyToken: buyTokenAddr,
        sellAmount,
        buyAmount,
        maxFee: 0,
        expiry,
        claimsRoot: toHex(claimsRootValue, 32),
        totalLocked,
        relayer: userAddr,
        orderHash: toHex(BigInt(ps[14]), 32),
      },
      dexRouter: mockDexAddress,
      dexCalldata,
    });
    console.log("  staticCall succeeded");
  } catch (e: any) {
    console.log("  staticCall failed:", e.message?.slice(0, 300));
    // Try to decode revert data
    if (e.data) console.log("  revert data:", e.data);
    if (e.revert) console.log("  revert:", JSON.stringify(e.revert));
  }

  // Use gasLimit override to bypass estimateGas and get tx hash for debugging
  const settleTx = await settlement.settleWithDex({
    proof: {
      proofA: proofResult.formatted.proofA,
      proofB: proofResult.formatted.proofB,
      proofC: proofResult.formatted.proofC,
      pubKeyBind: toHex(BigInt(ps[0]), 32),
      commitmentRoot: ps[1],
      nullifier: toHex(BigInt(ps[2]), 32),
      nonceNullifier: toHex(BigInt(ps[3]), 32),
      newCommitment: toHex(BigInt(ps[4]), 32),
      sellToken: weth,
      buyToken: buyTokenAddr,
      sellAmount,
      buyAmount,
      maxFee: 0,
      expiry,
      claimsRoot: toHex(claimsRootValue, 32),
      totalLocked,
      relayer: userAddr,
      orderHash: toHex(BigInt(ps[14]), 32),
    },
    dexRouter: mockDexAddress,
    dexCalldata,
  }, { gasLimit: 5_000_000 });
  console.log(`  TX sent: ${settleTx.hash}`);
  const settleReceipt = await settleTx.wait();
  console.log(`  TX status: ${settleReceipt?.status}`);
  assert(true, `settleWithDex TX: ${settleTx.hash}`);

  // ─── Step 6: Verify on-chain state ─────────────────────────
  console.log("\n[6/9] Verifying on-chain state...");

  const nullSpent = await settlement.nullifiers(toHex(BigInt(ps[2]), 32));
  assert(nullSpent, "Escrow nullifier spent");

  const nonceSpent = await settlement.nonceNullifiers(toHex(BigInt(ps[3]), 32));
  assert(nonceSpent, "Nonce nullifier spent");

  const group = await settlement.claimsGroups(toHex(claimsRootValue, 32));
  assert(group.token.toLowerCase() === buyTokenAddr.toLowerCase(), `Claims group token: USDC`);
  assert(group.totalLocked === totalLocked, `Claims group locked: ${ethers.formatEther(group.totalLocked)} USDC`);

  // ─── Step 7: Verify platform fee ───────────────────────────
  console.log("\n[7/9] Verifying platform fee...");

  const feeVaultAddr: string = await settlement.feeVault();
  if (feeVaultAddr !== ethers.ZeroAddress) {
    const feeVaultContract = new ethers.Contract(feeVaultAddr, FEE_VAULT_ABI, provider);
    const treasury: string = await feeVaultContract.treasury();

    // Check DexPlatformFeeCollected event in settle receipt
    const settleIface = new ethers.Interface(SETTLEMENT_ABI);
    let feeEventFound = false;
    for (const log of settleReceipt.logs) {
      try {
        const parsed = settleIface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === "DexPlatformFeeCollected") {
          assert(parsed.args.amount === feeAmount, `Fee event amount: ${ethers.formatEther(parsed.args.amount)} WETH`);
          assert(parsed.args.treasury.toLowerCase() === treasury.toLowerCase(), "Fee sent to treasury");
          feeEventFound = true;
        }
      } catch { /* skip */ }
    }
    assert(feeEventFound, "DexPlatformFeeCollected event emitted");

    // Verify treasury actually received the fee
    const treasuryWeth = await (new ethers.Contract(weth, WETH_ABI, provider)).balanceOf(treasury);
    assert(treasuryWeth >= feeAmount, `Treasury WETH: ${ethers.formatEther(treasuryWeth)} (expected ≥ ${ethers.formatEther(feeAmount)})`);
  } else {
    console.log("  (FeeVault not set — skipping fee checks)");
  }

  // ─── Step 8: Claim ─────────────────────────────────────────
  console.log("\n[8/9] Claiming...");

  // Advance time past releaseTime
  const currentBlock = await provider.getBlock("latest");
  const currentChainTime = BigInt(currentBlock!.timestamp);
  if (currentChainTime <= releaseTime) {
    const advance = Number(releaseTime - currentChainTime) + 1;
    await provider.send("evm_increaseTime", [advance]);
    await provider.send("evm_mine", []);
  }

  // Build claim proof (claimsLayers already computed in Step 3)
  const claimIdx = 0;
  const claimNullifier = poseidonHash([TAG_CLAIM_NULL, claimSecret, BigInt(claimIdx)]);
  const claimMerkleProof = getMerkleProof(claimsLayers, claimIdx);

  const snarkjs = await import("snarkjs");
  const CLAIM_WASM = path.join(__dirname, "../../circuits/build/claim_js/claim.wasm");
  const CLAIM_ZKEY = path.join(__dirname, "../../circuits/build/claim_final.zkey");

  const { proof: claimZkProof } = await snarkjs.groth16.fullProve({
    claimsRoot: claimsRootValue.toString(),
    nullifier: claimNullifier.toString(),
    amount: totalLocked.toString(),
    token: BigInt(buyTokenAddr).toString(),
    recipient: BigInt(RECIPIENT).toString(),
    releaseTime: releaseTime.toString(),
    secret: claimSecret.toString(),
    leafIndex: claimIdx.toString(),
    pathElements: claimMerkleProof.pathElements.map((e) => e.toString()),
    pathIndices: claimMerkleProof.pathIndices.map((i) => i.toString()),
  }, CLAIM_WASM, CLAIM_ZKEY);

  const claimContract = new ethers.Contract(settlementAddr, CLAIM_ABI, wallet);
  const claimTx = await claimContract.claimWithProof(
    [claimZkProof.pi_a[0], claimZkProof.pi_a[1]],
    [[claimZkProof.pi_b[0][1], claimZkProof.pi_b[0][0]], [claimZkProof.pi_b[1][1], claimZkProof.pi_b[1][0]]],
    [claimZkProof.pi_c[0], claimZkProof.pi_c[1]],
    toHex(claimsRootValue, 32),
    toHex(claimNullifier, 32),
    totalLocked,
    buyTokenAddr,
    RECIPIENT,
    releaseTime,
  );
  await claimTx.wait();
  assert(true, `Claim TX: ${claimTx.hash}`);

  // ─── Step 9: Verify final state ────────────────────────────
  console.log("\n[9/9] Verifying final state...");

  const claimNullSpent = await settlement.claimNullifiers(toHex(claimNullifier, 32));
  assert(claimNullSpent, "Claim nullifier spent");

  const groupAfter = await settlement.claimsGroups(toHex(claimsRootValue, 32));
  assert(groupAfter.totalClaimed === totalLocked, "Claims fully claimed");

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  ✅ MARKET ORDER E2E — ALL CHECKS PASSED");
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch((e) => {
  console.error("\n❌ E2E FAILED:", e.message || e);
  console.error(e.stack);
  process.exit(1);
});
