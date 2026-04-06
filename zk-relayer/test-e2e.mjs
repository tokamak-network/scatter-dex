/**
 * E2E test: submit two matching private orders to zk-relayer
 * and verify they get matched.
 *
 * Prerequisites:
 * - anvil running on :8545
 * - DeployLocal deployed
 * - zk-relayer running on :3002
 * - Two deposits in CommitmentPool (leafIndex 0 and 1)
 */

import { buildPoseidon } from "circomlibjs";
import { ethers } from "ethers";

const ZK_RELAYER_URL = "http://localhost:3002";
const POOL = "0x3Aa5ebB10DC797CAC828524e59A333d0A371443c";
const WETH = "0x0165878A594ca255338adfa4d48449f69242Eb8F";
const USDC = "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853";
const ALICE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const BOB_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  // Use NonceManager to avoid stale nonce issues after DeployLocal
  const provider = new ethers.JsonRpcProvider("http://localhost:8545", undefined, { cacheTimeout: -1 });

  // Build EdDSA
  const { buildEddsa, buildBabyjub } = await import("circomlibjs");
  const eddsa = await buildEddsa();
  const babyJub = await buildBabyjub();

  // Generate two keypairs
  const alicePrivKey = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes("alice-test-key")));
  const bobPrivKey = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes("bob-test-key")));

  // ── Step 0: Deploy (assumes fresh anvil with contracts already deployed) ──
  // If you need a fresh state, restart anvil and run DeployLocal before this script.

  const alicePub = eddsa.prv2pub(alicePrivKey);
  const bobPub = eddsa.prv2pub(bobPrivKey);

  const alicePubKeyAx = babyJub.F.toObject(alicePub[0]);
  const alicePubKeyAy = babyJub.F.toObject(alicePub[1]);
  const bobPubKeyAx = babyJub.F.toObject(bobPub[0]);
  const bobPubKeyAy = babyJub.F.toObject(bobPub[1]);

  // ── Step 1: Deposit real Poseidon commitments ──
  const aliceWallet = new ethers.Wallet(ALICE_KEY, provider);
  const bobWallet = new ethers.Wallet(BOB_KEY, provider);

  const POOL_ABI = [
    "function deposit(uint256 commitment, address token, uint256 amount) external",
    "function nextIndex() view returns (uint32)",
  ];
  const ERC20_ABI = [
    "function approve(address,uint256) external returns (bool)",
    "function deposit() external payable",
  ];

  const pool = new ethers.Contract(POOL, POOL_ABI, aliceWallet);

  // Alice: commitment for 10 WETH
  const aliceSecret = 111n;
  const aliceSalt = 222n;
  const aliceBalance = ethers.parseUnits("10", 18);
  const aliceCommitment = F.toObject(poseidon([aliceSecret, BigInt(WETH), aliceBalance, aliceSalt]));

  // Capture leaf index before deposit
  const aliceLeafIndex = Number(await pool.nextIndex());

  // Wrap ETH → WETH, approve, deposit
  const weth = new ethers.Contract(WETH, ERC20_ABI, aliceWallet);
  await (await weth.deposit({ value: aliceBalance })).wait();
  await (await weth.approve(POOL, aliceBalance)).wait();
  await (await pool.deposit(aliceCommitment, WETH, aliceBalance)).wait();
  console.log(`Alice deposited 10 WETH at leafIndex ${aliceLeafIndex}`);

  // Bob: commitment for 1000 USDC
  const bobSecret = 333n;
  const bobSalt = 444n;
  const bobBalance = ethers.parseUnits("1000", 18);
  const bobCommitment = F.toObject(poseidon([bobSecret, BigInt(USDC), bobBalance, bobSalt]));

  const bobLeafIndex = Number(await pool.nextIndex());

  const usdc = new ethers.Contract(USDC, ERC20_ABI, bobWallet);
  const poolBob = new ethers.Contract(POOL, POOL_ABI, bobWallet);
  await (await usdc.approve(POOL, bobBalance)).wait();
  await (await poolBob.deposit(bobCommitment, USDC, bobBalance)).wait();
  console.log(`Bob deposited 1000 USDC at leafIndex ${bobLeafIndex}\n`);

  // Order params
  const sellAmountAlice = ethers.parseUnits("1", 18); // 1 WETH
  const buyAmountAlice = ethers.parseUnits("100", 18); // wants 100 USDC
  const sellAmountBob = ethers.parseUnits("100", 18); // 100 USDC
  const buyAmountBob = ethers.parseUnits("1", 18); // wants 1 WETH

  const now = Math.floor(Date.now() / 1000);
  const expiry = BigInt(now + 86400);
  const nonceAlice = BigInt(Date.now());
  const nonceBob = BigInt(Date.now() + 1);

  // Claims: Alice's order → 1 claim (self receives USDC)
  const aliceClaim = {
    secret: "123456789",
    recipient: BigInt("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266").toString(),
    token: BigInt(USDC).toString(),
    amount: ethers.parseUnits("100", 18).toString(),
    releaseTime: BigInt(now + 3600).toString(),
  };

  // Bob's order → 1 claim (self receives WETH)
  const bobClaim = {
    secret: "987654321",
    recipient: BigInt("0x70997970C51812dc3A010C7d01b50e0d17dc79C8").toString(),
    token: BigInt(WETH).toString(),
    amount: ethers.parseUnits("1", 18).toString(),
    releaseTime: BigInt(now + 3600).toString(),
  };

  // Compute claimsRoot for Alice
  const aliceClaimLeaf = F.toObject(poseidon([
    BigInt(aliceClaim.secret), BigInt(aliceClaim.recipient),
    BigInt(aliceClaim.token), BigInt(aliceClaim.amount), BigInt(aliceClaim.releaseTime),
  ]));
  const aliceClaimLeaves = [aliceClaimLeaf];
  while (aliceClaimLeaves.length < 16) aliceClaimLeaves.push(0n);

  // Build Merkle tree for claims
  function buildTree(leaves, depth) {
    let layer = [...leaves];
    for (let i = 0; i < depth; i++) {
      const next = [];
      for (let j = 0; j < layer.length; j += 2) {
        next.push(F.toObject(poseidon([layer[j], layer[j + 1]])));
      }
      layer = next;
    }
    return layer[0];
  }

  const aliceClaimsRoot = buildTree(aliceClaimLeaves, 4);

  // Compute claimsRoot for Bob
  const bobClaimLeaf = F.toObject(poseidon([
    BigInt(bobClaim.secret), BigInt(bobClaim.recipient),
    BigInt(bobClaim.token), BigInt(bobClaim.amount), BigInt(bobClaim.releaseTime),
  ]));
  const bobClaimLeaves = [bobClaimLeaf];
  while (bobClaimLeaves.length < 16) bobClaimLeaves.push(0n);
  const bobClaimsRoot = buildTree(bobClaimLeaves, 4);

  // Hash orders (Poseidon(8) including claimsRoot)
  const aliceOrderHash = F.toObject(poseidon([
    BigInt(WETH), BigInt(USDC), sellAmountAlice, buyAmountAlice,
    60n, expiry, nonceAlice, aliceClaimsRoot,
  ]));

  const bobOrderHash = F.toObject(poseidon([
    BigInt(USDC), BigInt(WETH), sellAmountBob, buyAmountBob,
    60n, expiry, nonceBob, bobClaimsRoot,
  ]));

  // Sign with EdDSA
  const aliceSig = eddsa.signPoseidon(alicePrivKey, F.e(aliceOrderHash));
  const bobSig = eddsa.signPoseidon(bobPrivKey, F.e(bobOrderHash));

  // Submit Alice's order
  console.log("Submitting Alice's order (sell 1 WETH, buy 100 USDC)...");
  const aliceRes = await fetch(`${ZK_RELAYER_URL}/api/private-orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sellToken: WETH,
      buyToken: USDC,
      sellAmount: sellAmountAlice.toString(),
      buyAmount: buyAmountAlice.toString(),
      maxFee: "60",
      expiry: expiry.toString(),
      nonce: nonceAlice.toString(),
      pubKeyAx: alicePubKeyAx.toString(),
      pubKeyAy: alicePubKeyAy.toString(),
      sigS: aliceSig.S.toString(),
      sigR8x: babyJub.F.toObject(aliceSig.R8[0]).toString(),
      sigR8y: babyJub.F.toObject(aliceSig.R8[1]).toString(),
      // Commitment info (real Poseidon commitment at leafIndex 0)
      ownerSecret: aliceSecret.toString(),
      balance: aliceBalance.toString(),
      salt: aliceSalt.toString(),
      leafIndex: aliceLeafIndex,
      claims: [aliceClaim],
    }),
  });

  const aliceResult = await aliceRes.json();
  console.log("Alice result:", JSON.stringify(aliceResult));

  if (aliceResult.status !== "pending") {
    console.log("Expected 'pending' (no match yet). Got:", aliceResult.status);
  }

  // Submit Bob's order (should match with Alice)
  console.log("\nSubmitting Bob's order (sell 100 USDC, buy 1 WETH)...");
  const bobRes = await fetch(`${ZK_RELAYER_URL}/api/private-orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sellToken: USDC,
      buyToken: WETH,
      sellAmount: sellAmountBob.toString(),
      buyAmount: buyAmountBob.toString(),
      maxFee: "60",
      expiry: expiry.toString(),
      nonce: nonceBob.toString(),
      pubKeyAx: bobPubKeyAx.toString(),
      pubKeyAy: bobPubKeyAy.toString(),
      sigS: bobSig.S.toString(),
      sigR8x: babyJub.F.toObject(bobSig.R8[0]).toString(),
      sigR8y: babyJub.F.toObject(bobSig.R8[1]).toString(),
      ownerSecret: bobSecret.toString(),
      balance: bobBalance.toString(),
      salt: bobSalt.toString(),
      leafIndex: bobLeafIndex,
      claims: [bobClaim],
    }),
  });

  const bobResult = await bobRes.json();
  console.log("Bob result:", JSON.stringify(bobResult));

  if (bobResult.status === "settled") {
    console.log("\n✅ E2E SUCCESS: Orders matched and settled!");
    console.log("   txHash:", bobResult.txHash);
  } else if (bobResult.status === "settle_failed") {
    console.log("\n❌ Match found but settlement failed:", bobResult.error);
  } else {
    console.log("\nResult:", bobResult.status);
  }
}

main().catch((err) => {
  console.error("E2E test failed:", err);
  process.exit(1);
});
