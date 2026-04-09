#!/usr/bin/env tsx
/**
 * E2E test: Full ZK private flow on local anvil.
 *
 * Prerequisites:
 *   ./scripts/dev.sh --mock   (anvil + contracts + relayers + frontend running)
 *
 * Usage:
 *   cd zk-relayer && npx tsx test/e2e-private-flow.ts
 *
 * Flow tested:
 *   1. Wrap ETH → WETH
 *   2. Approve + deposit into CommitmentPool
 *   3. Submit private order (same-token scatter) via zk-relayer API
 *   4. Wait for settlement (scatterDirect)
 *   5. Submit claim via zk-relayer API
 *   6. Verify recipient received ETH (auto-unwrapped from WETH)
 *   7. Verify change note is on-chain
 *   8. Verify FeeVault received relayer fee
 *   9. Relayer claims from vault (platform fee deduction verified)
 */

import { ethers } from "ethers";
import path from "path";
import { fileURLToPath } from "url";

// Pure-JS Poseidon (avoids ffjavascript WASM BigInt issue on Node v22).
// Verified to produce identical outputs to circomlibjs Poseidon for all arities used here.
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon8, poseidon9 } from "poseidon-lite";

// EdDSA needs circomlibjs (WASM-based) — only used for babyJub.F field conversions
// on EdDSA key/signature values, NOT for hashing. All hash computations use poseidon-lite.
import { getEdDSA as getEdDSAImpl } from "../src/core/zk-prover.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ─────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL ?? "http://localhost:8545";
const ZK_RELAYER_URL = process.env.ZK_RELAYER_URL ?? "http://localhost:3002";
const FEE_BPS = 30n; // 0.3% — must match relayer config
const CLAIMS_TREE_DEPTH = 4; // must match contract CLAIMS_TREE_DEPTH
const CLAIMS_TREE_SIZE = 2 ** CLAIMS_TREE_DEPTH;
const SETTLE_POLL_TIMEOUT_SEC = 60;

// Anvil well-known Account #9 — NEVER use on real networks.
// Override via env var for custom test setups.
const USER_KEY = process.env.E2E_PRIVATE_KEY
  ?? "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";
const RECIPIENT = process.env.E2E_RECIPIENT
  ?? "0x627306090abaB3A6e1400e9345bC60c78a8BEf57";

const WETH_ABI = [
  "function deposit() external payable",
  "function approve(address,uint256) external returns (bool)",
  "function balanceOf(address) view returns (uint256)",
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
  "event PrivateClaim(bytes32 indexed claimsRoot, bytes32 indexed nullifier, address indexed recipient, address token, uint256 amount)",
];

const FEE_VAULT_ABI = [
  "function balances(address relayer, address token) view returns (uint256)",
  "function claim(address token) external",
  "function platformFeeBps() view returns (uint256)",
  "function treasury() view returns (address)",
];

// ─── Helpers ────────────────────────────────────────────────

function poseidonHash(inputs: bigint[]): bigint {
  switch (inputs.length) {
    case 2: return poseidon2(inputs);
    case 3: return poseidon3(inputs);
    case 4: return poseidon4(inputs);
    case 5: return poseidon5(inputs);
    case 8: return poseidon8(inputs);
    case 9: return poseidon9(inputs);
    default: throw new Error(
      `poseidonHash: unsupported arity ${inputs.length} (supported: 2, 3, 4, 5, 8, 9)`
    );
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
    globalThis.crypto.getRandomValues(bytes);
    bytes[0] &= 0x3f; // BN254 order is 254 bits — mask top 2 bits
    value = 0n;
    for (const b of bytes) value = (value << 8n) | BigInt(b);
  } while (value >= BN254_ORDER);
  return value;
}

function toHex(n: bigint, bytes: number): string {
  return "0x" + n.toString(16).padStart(bytes * 2, "0");
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
  console.log(`  ✓ ${msg}`);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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

function getMerkleProof(layers: bigint[][], idx: number) {
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];
  let index = idx;
  for (let i = 0; i < layers.length - 1; i++) {
    const isRight = index % 2;
    const siblingIndex = isRight ? index - 1 : index + 1;
    pathElements.push(layers[i][siblingIndex] ?? 0n);
    pathIndices.push(isRight);
    index = Math.floor(index / 2);
  }
  return { pathElements, pathIndices };
}

function formatProof(proof: any) {
  return {
    proofA: [proof.pi_a[0], proof.pi_a[1]],
    proofB: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ],
    proofC: [proof.pi_c[0], proof.pi_c[1]],
  };
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  E2E: ZK Private Flow (deposit → order → claim)");
  console.log("═══════════════════════════════════════════════════\n");

  // 0. Setup
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // Safety: refuse to run against non-local chains
  const chainId = (await provider.getNetwork()).chainId;
  if (chainId !== 31337n && !process.env.E2E_ALLOW_NON_LOCAL) {
    throw new Error(
      `Refusing to run on chain ${chainId} — this script uses well-known Anvil keys. ` +
      `Set E2E_ALLOW_NON_LOCAL=1 to override.`
    );
  }

  const baseWallet = new ethers.Wallet(USER_KEY, provider);
  const wallet = new ethers.NonceManager(baseWallet);
  const userAddr = baseWallet.address;
  console.log(`User: ${userAddr}`);

  // Get contract addresses from relayer info
  const infoRes = await fetch(`${ZK_RELAYER_URL}/api/info`);
  if (!infoRes.ok) throw new Error("zk-relayer not running");
  const info = await infoRes.json();
  const poolAddr = info.commitmentPool;
  const settlementAddr = info.privateSettlement;
  console.log(`CommitmentPool: ${poolAddr}`);
  console.log(`PrivateSettlement: ${settlementAddr}`);

  const settlementForWeth = new ethers.Contract(
    settlementAddr, ["function weth() view returns (address)"], provider,
  );
  const weth: string = await settlementForWeth.weth();
  console.log(`WETH: ${weth}\n`);

  const wethContract = new ethers.Contract(weth, WETH_ABI, wallet);
  const poolContract = new ethers.Contract(poolAddr, POOL_ABI, wallet);
  const settlementContract = new ethers.Contract(settlementAddr, SETTLEMENT_ABI, provider);

  const depositAmount = ethers.parseEther("10");
  const sellAmount = ethers.parseEther("3");
  const fee = (sellAmount * FEE_BPS) / 10000n;
  const totalLocked = sellAmount - fee; // what recipients actually receive
  const claimAmount1 = ethers.parseEther("1");
  const claimAmount2 = totalLocked - claimAmount1;

  // ─── Step 1: Wrap ETH → WETH ──────────────────────────────
  console.log("[1/9] Wrapping ETH → WETH...");
  const wrapTx = await wethContract.deposit({ value: depositAmount });
  await wrapTx.wait();
  const wethBal = await wethContract.balanceOf(userAddr);
  assert(wethBal >= depositAmount, `WETH balance: ${ethers.formatEther(wethBal)} ETH`);

  // ─── Step 2: Approve + Deposit into CommitmentPool ─────────
  console.log("\n[2/9] Depositing into CommitmentPool...");
  const approveTx = await wethContract.approve(poolAddr, ethers.MaxUint256);
  await approveTx.wait();

  const ownerSecret = randomFieldElement();
  const salt = randomFieldElement();
  const commitment = poseidonHash([ownerSecret, BigInt(weth), depositAmount, salt]);

  const depositTx = await poolContract.deposit(commitment, weth, depositAmount);
  const depositReceipt = await depositTx.wait();

  // Parse leafIndex from event
  const poolIface = new ethers.Interface(POOL_ABI);
  let leafIndex = -1;
  for (const log of depositReceipt.logs) {
    try {
      const parsed = poolIface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "CommitmentInserted") leafIndex = Number(parsed.args.leafIndex);
    } catch { /* skip */ }
  }
  assert(leafIndex >= 0, `Deposit committed at leaf #${leafIndex}`);

  // ─── Step 3: Generate EdDSA key + sign order ───────────────
  console.log("\n[3/9] Generating EdDSA key & signing order...");
  const { eddsa, F } = await getEdDSAWithField();

  // Deterministic seed for reproducibility — NOT used in production
  const eddsaPrivKey = Buffer.from(ethers.keccak256(ethers.toUtf8Bytes("e2e-test-key")).slice(2), "hex");
  const pubKey = eddsa.prv2pub(eddsaPrivKey);
  const pubKeyAx = F.toObject(pubKey[0]);
  const pubKeyAy = F.toObject(pubKey[1]);

  // Build claims
  const claimSecret1 = randomFieldElement();
  const claimSecret2 = randomFieldElement();
  const recipientBig = BigInt(RECIPIENT);
  const tokenBig = BigInt(weth);

  // Use chain timestamp (not wall clock) — contracts enforce block.timestamp checks
  const latestBlock = await provider.getBlock("latest");
  if (!latestBlock) throw new Error("Failed to fetch latest block");
  const chainTime = BigInt(latestBlock.timestamp);
  const releaseTime = chainTime + 60n;

  const claims = [
    { secret: claimSecret1, recipient: recipientBig, token: tokenBig, amount: claimAmount1, releaseTime },
    { secret: claimSecret2, recipient: recipientBig, token: tokenBig, amount: claimAmount2, releaseTime },
  ];

  // Compute claim leaves and claims root
  const claimLeaves = claims.map((c) =>
    poseidonHash([c.secret, c.recipient, c.token, c.amount, c.releaseTime])
  );
  const paddedLeaves = [...claimLeaves];
  while (paddedLeaves.length < CLAIMS_TREE_SIZE) paddedLeaves.push(0n);

  const { root: claimsRoot, layers: claimsLayers } = buildTree(paddedLeaves, CLAIMS_TREE_DEPTH);

  // Compute change salt + expected change commitment
  const changeSalt = randomFieldElement();
  const changeAmount = depositAmount - sellAmount;
  const expectedChangeCommitment = poseidonHash([ownerSecret, tokenBig, changeAmount, changeSalt]);

  // Build order nonce (use chain time to avoid wall-clock drift)
  const nonce = chainTime * 1000n + BigInt(Date.now() % 1000); // unique per run
  const expiry = chainTime + 86400n;

  // Hash order
  const relayerAddr = BigInt(info.address); // relayer address bound in order hash
  const orderHash = poseidonHash([
    tokenBig, tokenBig, // same-token (scatterDirect)
    sellAmount, sellAmount, // buy = sell for same token
    FEE_BPS, expiry, nonce, claimsRoot, relayerAddr,
  ]);

  // Sign with EdDSA
  const sig = eddsa.signPoseidon(eddsaPrivKey, F.e(orderHash.toString()));
  const sigR8x = F.toObject(sig.R8[0]);
  const sigR8y = F.toObject(sig.R8[1]);

  assert(true, `Order signed (hash: ${orderHash.toString().slice(0, 20)}...)`);

  // ─── Step 4: Submit order to zk-relayer ─────────────────────
  console.log("\n[4/9] Submitting order to zk-relayer...");
  const orderBody = {
    sellToken: weth,
    buyToken: weth,
    sellAmount: sellAmount.toString(),
    buyAmount: sellAmount.toString(),
    maxFee: FEE_BPS.toString(),
    expiry: expiry.toString(),
    nonce: nonce.toString(),
    pubKeyAx: pubKeyAx.toString(),
    pubKeyAy: pubKeyAy.toString(),
    sigS: sig.S.toString(),
    sigR8x: sigR8x.toString(),
    sigR8y: sigR8y.toString(),
    ownerSecret: ownerSecret.toString(),
    balance: depositAmount.toString(),
    salt: salt.toString(),
    leafIndex,
    newSalt: changeSalt.toString(),
    expectedChangeCommitment: expectedChangeCommitment.toString(),
    claims: claims.map((c) => ({
      secret: c.secret.toString(),
      recipient: c.recipient.toString(),
      token: c.token.toString(),
      amount: c.amount.toString(),
      releaseTime: c.releaseTime.toString(),
    })),
  };

  const orderRes = await fetch(`${ZK_RELAYER_URL}/api/private-orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(orderBody),
  });
  const orderData = await orderRes.json();
  if (!orderRes.ok) {
    throw new Error(`Order submission failed: ${JSON.stringify(orderData)}`);
  }

  // ─── Step 5: Wait for settlement ───────────────────────────
  // same-token orders settle synchronously in the POST response,
  // but poll as fallback for cross-token orders or async settlement
  let settleTxHash = orderData.txHash;
  if (orderData.status !== "settled") {
    console.log("\n[5/9] Waiting for settlement...");
    for (let i = 0; i < SETTLE_POLL_TIMEOUT_SEC; i++) {
      await sleep(1000);
      const statusRes = await fetch(`${ZK_RELAYER_URL}/api/private-orders/${pubKeyAx}/${nonce}`);
      if (statusRes.ok) {
        const s = await statusRes.json();
        if (s.status === "settled") { settleTxHash = s.settleTxHash; break; }
        if (s.status === "scatter_failed" || s.status === "settle_failed") {
          throw new Error(`Settlement failed: ${s.status}`);
        }
      }
      if (i % 5 === 0) process.stdout.write(".");
    }
    if (!settleTxHash) throw new Error("Settlement timed out");
  }
  assert(true, `Settled! TX: ${settleTxHash}`);

  // ─── Step 6: Wait for releaseTime, then claim ──────────────
  console.log("\n[6/9] Claiming via zk-relayer...");
  const currentBlock = await provider.getBlock("latest");
  const currentChainTime = BigInt(currentBlock!.timestamp);
  if (currentChainTime <= releaseTime) {
    const advance = Number(releaseTime - currentChainTime) + 1;
    console.log(`  Advancing anvil time by ${advance}s...`);
    await provider.send("evm_increaseTime", [advance]);
    await provider.send("evm_mine", []);
  }

  const snarkjs = await import("snarkjs");
  const WASM_PATH = path.join(__dirname, "../../circuits/build/claim_js/claim.wasm");
  const ZKEY_PATH = path.join(__dirname, "../../circuits/build/claim_final.zkey");

  async function submitClaim(
    claimIdx: number,
    secret: bigint,
    amount: bigint,
  ): Promise<string> {
    // [M4] Domain-separated claim nullifier (tag = 2)
    const nullifier = poseidonHash([2n, secret, BigInt(claimIdx)]);
    const proof = getMerkleProof(claimsLayers, claimIdx);

    const { proof: zkProof } = await snarkjs.groth16.fullProve({
      claimsRoot: claimsRoot.toString(),
      nullifier: nullifier.toString(),
      amount: amount.toString(),
      token: tokenBig.toString(),
      recipient: recipientBig.toString(),
      releaseTime: releaseTime.toString(),
      secret: secret.toString(),
      leafIndex: claimIdx.toString(),
      pathElements: proof.pathElements.map((e) => e.toString()),
      pathIndices: proof.pathIndices.map((i) => i.toString()),
    }, WASM_PATH, ZKEY_PATH);

    const res = await fetch(`${ZK_RELAYER_URL}/api/private-claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...formatProof(zkProof),
        claimsRoot: toHex(claimsRoot, 32),
        claimNullifier: toHex(nullifier, 32),
        amount: amount.toString(),
        token: weth,
        recipient: RECIPIENT,
        releaseTime: releaseTime.toString(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Claim #${claimIdx + 1} failed: ${JSON.stringify(data)}`);
    return data.txHash;
  }

  // Capture balance before claims for delta verification
  const recipientEthBefore = await provider.getBalance(RECIPIENT);

  const tx1 = await submitClaim(0, claimSecret1, claimAmount1);
  assert(true, `Claim #1 TX: ${tx1}`);

  // Wait for claim #1 TX to be mined + brief delay for Anvil nonce state propagation.
  // The relayer uses a plain Wallet (not NonceManager), so getTransactionCount
  // can return stale values immediately after mining.
  await provider.waitForTransaction(tx1);
  await sleep(500);

  const tx2 = await submitClaim(1, claimSecret2, claimAmount2);
  assert(true, `Claim #2 TX: ${tx2}`);

  // Wait for claim #2 TX to be mined before verifying on-chain state
  await provider.waitForTransaction(tx2);

  // ─── Step 7: Verify balances ───────────────────────────────
  console.log("\n[7/9] Verifying balances...");

  const recipientEthAfter = await provider.getBalance(RECIPIENT);
  const ethDelta = recipientEthAfter - recipientEthBefore;
  const expectedTotal = claimAmount1 + claimAmount2;
  assert(ethDelta >= expectedTotal, `Recipient ETH delta: +${ethers.formatEther(ethDelta)} (expected ≥ ${ethers.formatEther(expectedTotal)})`);

  const recipientWeth = await wethContract.balanceOf(RECIPIENT);
  assert(recipientWeth === 0n, `Recipient WETH: 0 (auto-unwrapped)`);

  const settlementWeth = await wethContract.balanceOf(settlementAddr);
  console.log(`  Settlement WETH remaining: ${ethers.formatEther(settlementWeth)}`);

  // Change note should be on-chain (CommitmentInserted event)
  const changeLogs = await poolContract.queryFilter(
    poolContract.filters.CommitmentInserted(expectedChangeCommitment)
  );
  assert(changeLogs.length > 0, `Change commitment on-chain at leaf #${(changeLogs[0] as ethers.EventLog).args.leafIndex}`);

  // Verify claim nullifiers are spent
  // [M4] Domain-separated claim nullifier (tag = 2). The submitClaim helper
  // above already uses the tagged form when generating the proof, so the
  // verification block must match — otherwise these checks would fail even
  // when the on-chain claim succeeded.
  const claimNull1 = poseidonHash([2n, claimSecret1, 0n]);
  const claimNull2 = poseidonHash([2n, claimSecret2, 1n]);
  const [null1Spent, null2Spent] = await Promise.all([
    settlementContract.claimNullifiers(toHex(claimNull1, 32)),
    settlementContract.claimNullifiers(toHex(claimNull2, 32)),
  ]);
  assert(null1Spent, "Claim #1 nullifier spent");
  assert(null2Spent, "Claim #2 nullifier spent");

  // Verify original note nullifier is spent
  // [M4] Domain-separated escrow nullifier (tag = 0)
  const noteNullifier = poseidonHash([0n, ownerSecret, salt]);
  const noteSpent = await settlementContract.nullifiers(toHex(noteNullifier, 32));
  assert(noteSpent, "Original note nullifier spent");

  // ─── Step 8: Verify FeeVault ──────────────────────────────
  console.log("\n[8/9] Verifying FeeVault...");

  const feeVaultAddr: string = await settlementContract.feeVault();
  if (feeVaultAddr !== ethers.ZeroAddress) {
    const vaultContract = new ethers.Contract(feeVaultAddr, FEE_VAULT_ABI, provider);
    const relayerAddr = info.address; // relayer address from /api/info

    // Fee should be in vault, credited to relayer (use >= since prior runs may have accumulated)
    const vaultBal = await vaultContract.balances(relayerAddr, weth);
    assert(vaultBal >= fee, `Vault balance: ${ethers.formatEther(vaultBal)} WETH (expected ≥ ${ethers.formatEther(fee)})`);

    // Check platform fee rate (expected: 500 bps = 5%, max 10000)
    const platformBps = await vaultContract.platformFeeBps();
    assert(Number(platformBps) === 500, `Platform fee: ${Number(platformBps)} bps (expected 500)`);

    const treasury: string = await vaultContract.treasury();
    assert(treasury !== ethers.ZeroAddress, `Treasury: ${treasury}`);

    // ─── Step 9: Relayer claims from vault ────────────────────
    console.log("\n[9/9] Relayer claiming from FeeVault...");

    // Use relayer wallet (Anvil Account #1) to claim
    const RELAYER_KEY = process.env.E2E_RELAYER_KEY
      ?? "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const relayerWallet = new ethers.Wallet(RELAYER_KEY, provider);
    assert(
      relayerWallet.address.toLowerCase() === relayerAddr.toLowerCase(),
      `Relayer address match: ${relayerWallet.address}`,
    );
    const vaultWithSigner = new ethers.Contract(feeVaultAddr, FEE_VAULT_ABI, relayerWallet);

    // Re-query vault balance right before claim for accuracy
    const totalVaultBal = await vaultContract.balances(relayerAddr, weth);
    const relayerWethBefore = await wethContract.balanceOf(relayerAddr);
    const treasuryWethBefore = await wethContract.balanceOf(treasury);

    const claimVaultTx = await vaultWithSigner.claim(weth);
    await claimVaultTx.wait();

    const relayerWethAfter = await wethContract.balanceOf(relayerAddr);
    const treasuryWethAfter = await wethContract.balanceOf(treasury);

    const platformFeeAmount = (totalVaultBal * platformBps) / 10000n;
    const relayerNetAmount = totalVaultBal - platformFeeAmount;

    const relayerDelta = relayerWethAfter - relayerWethBefore;
    const treasuryDelta = treasuryWethAfter - treasuryWethBefore;

    assert(relayerDelta === relayerNetAmount, `Relayer received: ${ethers.formatEther(relayerDelta)} WETH (expected ${ethers.formatEther(relayerNetAmount)})`);
    assert(treasuryDelta === platformFeeAmount, `Treasury received: ${ethers.formatEther(treasuryDelta)} WETH (expected ${ethers.formatEther(platformFeeAmount)})`);

    // Vault balance should be 0 after claim
    const vaultBalAfter = await vaultContract.balances(relayerAddr, weth);
    assert(vaultBalAfter === 0n, "Vault balance: 0 after claim");
  } else {
    console.log("  (FeeVault not set — skipping vault checks)");
  }

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  ✅ ALL E2E CHECKS PASSED");
  console.log("═══════════════════════════════════════════════════\n");
}

main().catch((e) => {
  console.error("\n❌ E2E FAILED:", e.message || e);
  console.error(e.stack);
  process.exit(1);
});
