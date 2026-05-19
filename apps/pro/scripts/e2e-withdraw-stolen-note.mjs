#!/usr/bin/env node
/**
 * E2E NEGATIVE test: Alice deposits, then Bob tries to withdraw
 * using Alice's note file. Should FAIL at prove-time because
 * Bob's EdDSA key doesn't match the `pubKeyAx/Ay` baked into the
 * commitment — the new EdDSA gate on the withdraw circuit
 * rejects.
 *
 * Pre-#779 (no EdDSA gate) this would have *succeeded* because
 * the circuit only checked merkle inclusion + nullifier + recipient
 * binding — the note file alone was a bearer instrument. This
 * test pins the regression: a stolen note must NOT be spendable
 * by a different wallet.
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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RPC = "http://localhost:8545";
const POOL = "0x04C89607413713Ec9775E14b954286519d836FEf";
const WETH = "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318";

// anvil default accounts — use account#4 + account#5 to avoid
// clashing with accounts already touched in this anvil session
// (#0 = our e2e tests, #1 = relayer-a admin, #2 = relayer-b, etc.).
// Fresh-nonce accounts skip the "nonce too low" race ethers
// hits when a signer's local cache and the chain disagree.
const ALICE_PK = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";
const BOB_PK   = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WASM = (c) => readFileSync(`${ROOT}/circuits/build/${c}_js/${c}.wasm`);
const ZKEY = (c) => readFileSync(`${ROOT}/circuits/build/${c}_final.zkey`);

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function deposit() payable",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  // Wrap raw wallets in NonceManager so back-to-back txs (wrap +
  // approve + deposit) don't trip the "nonce too low" race ethers'
  // default cache hits on this anvil instance.
  const alice = new ethers.NonceManager(new ethers.Wallet(ALICE_PK, provider));
  const bob = new ethers.NonceManager(new ethers.Wallet(BOB_PK, provider));
  const aliceAddr = await alice.getAddress();
  const bobAddr = await bob.getAddress();
  console.log(`Alice: ${aliceAddr}`);
  console.log(`Bob:   ${bobAddr}\n`);

  const wethAlice = new ethers.Contract(WETH, ERC20_ABI, alice);
  const pool = new ethers.Contract(POOL, COMMITMENT_POOL_ABI, alice);
  const amount = 10n ** 18n;

  // 1. Alice wraps + deposits
  console.log("[1] Alice wraps + deposits 1 ETH");
  await (await wethAlice.deposit({ value: amount })).wait();
  await (await wethAlice.approve(POOL, amount)).wait();
  const { keyPair: aliceKey } = await deriveEdDSAKey(alice);
  const note = generateNote(WETH, amount, aliceKey.publicKey);
  const commitment = await computeCommitment(note);
  const dp = await generateDepositProof(note, { wasm: WASM("deposit"), zkey: ZKEY("deposit") });
  const filter = pool.filters.CommitmentInserted();
  const depTx = await pool.deposit(dp.proof.a, dp.proof.b, dp.proof.c, dp.commitment, WETH, amount);
  const depReceipt = await depTx.wait();
  const events = (await pool.queryFilter(filter, 0, depReceipt.blockNumber))
    .map((e) => ({ leafIndex: Number(e.args.leafIndex), commitment: BigInt(e.args.commitment) }))
    .sort((a, b) => a.leafIndex - b.leafIndex);
  const myEvent = events.find((e) => e.commitment === commitment);
  if (!myEvent) {
    // Defensive: a provider query window issue or a racing
    // CommitmentInserted that lands after our queryFilter snapshot
    // would otherwise surface as a misleading "cannot read
    // properties of undefined".
    throw new Error(
      `Alice's deposit commitment 0x${commitment.toString(16)} not found in pool's CommitmentInserted event log — RPC sync gap?`,
    );
  }
  const myLeafIndex = myEvent.leafIndex;
  console.log(`     leafIndex ${myLeafIndex}`);

  // 2. Bob obtains Alice's note file (simulate file copy)
  console.log("\n[2] Bob copies Alice's note file");

  // 3. Bob derives HIS OWN EdDSA key (different from Alice's)
  console.log("[3] Bob derives his own EdDSA key — different from Alice's");
  const { keyPair: bobKey } = await deriveEdDSAKey(bob);
  if (bobKey.publicKey[0] === aliceKey.publicKey[0] && bobKey.publicKey[1] === aliceKey.publicKey[1]) {
    throw new Error("Bob's key matches Alice's — test setup invalid");
  }
  console.log(`     Alice pubKey: (0x${aliceKey.publicKey[0].toString(16).slice(0, 16)}…, …)`);
  console.log(`     Bob   pubKey: (0x${bobKey.publicKey[0].toString(16).slice(0, 16)}…, …)`);

  // 4. Build the merkle proof for Alice's commitment
  const allLeaves = events.map((e) => e.commitment);
  const built = await buildMerkleTree(allLeaves, 20);
  const path = getMerkleProof(built.layers, myLeafIndex);
  const merkleProof = { root: built.root, pathElements: path.pathElements, pathIndices: path.pathIndices };

  // 5. Bob attempts to generate a withdraw proof signing with his
  //    own key against Alice's note. Pre-#779: succeeds (no sig
  //    check). Post-#779: should FAIL because Bob's signature
  //    won't verify against Alice's pubKeyAx/Ay baked into the
  //    commitment.
  console.log("\n[4] Bob attempts withdraw proof with HIS key against Alice's note…");
  try {
    await generateWithdrawProof(
      {
        note, // Alice's note preimage
        merkleProof,
        withdrawAmount: amount,
        recipient: bobAddr,
        eddsaPrivateKey: bobKey.privateKey, // Bob's key — wrong!
      },
      { wasm: WASM("withdraw"), zkey: ZKEY("withdraw") },
    );
    console.error("\n✗ FAIL — withdraw proof succeeded with a wrong-key signature.");
    console.error("    The EdDSA gate is NOT enforcing what we expect.");
    process.exit(1);
  } catch (err) {
    console.log("✓ Prover rejected as expected:");
    console.log(`    ${(err.message || String(err)).split("\n")[0]}`);
  }

  // 6. Sanity: Alice can still withdraw normally
  console.log("\n[5] Sanity: Alice withdraws normally");
  const aliceWp = await generateWithdrawProof(
    {
      note,
      merkleProof,
      withdrawAmount: amount,
      recipient: aliceAddr,
      eddsaPrivateKey: aliceKey.privateKey,
    },
    { wasm: WASM("withdraw"), zkey: ZKEY("withdraw") },
  );
  console.log("     prover accepted");
  await (await pool.withdraw(
    aliceWp.proof.a, aliceWp.proof.b, aliceWp.proof.c,
    aliceWp.root, aliceWp.nullifierHash, aliceWp.newCommitment,
    WETH, amount, aliceAddr, ethers.ZeroAddress,
  )).wait();
  console.log("     pool.withdraw confirmed");

  console.log("\n✓ NEGATIVE-CASE E2E PASSED");
  console.log("  Stolen note + wrong wallet → prover rejects (EdDSA gate works).");
  console.log("  Original owner → prover accepts + on-chain withdraw lands.");
}

main().catch((e) => {
  console.error("\n✗ FAILED:", e.message);
  if (e.data) console.error("  revert data:", e.data);
  process.exit(1);
});
