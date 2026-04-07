/**
 * Private settlement submitter.
 * Generates ZK proof and calls settlePrivate() on PrivateSettlement contract.
 */

import crypto from "crypto";
import { ethers } from "ethers";
import { config } from "../config.js";
import {
  poseidonHash,
  computeCommitment,
  computeNullifier,
  computeClaimLeaf,
  buildMerkleTree,
  getMerkleProof,
  type ClaimLeafData,
} from "./zk-prover.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PRIVATE_SETTLEMENT_ABI = [
  "function settlePrivate(tuple(uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC, uint256 currentRoot, uint256 currentTimestamp, bytes32 makerNullifier, bytes32 takerNullifier, bytes32 makerNonceNullifier, bytes32 takerNonceNullifier, bytes32 makerNewCommitment, bytes32 takerNewCommitment, bytes32 claimsRootMaker, bytes32 claimsRootTaker, uint96 totalLockedMaker, uint96 totalLockedTaker, address tokenMaker, address tokenTaker, uint96 feeTokenMaker, uint96 feeTokenTaker) p) external",
];

const COMMITMENT_POOL_ABI = [
  "function getLastRoot() view returns (uint256)",
  "function nextIndex() view returns (uint32)",
  "event CommitmentInserted(uint256 indexed commitment, uint32 leafIndex, uint256 timestamp)",
];

const CLAIMS_TREE_DEPTH = 4;
const COMMIT_TREE_DEPTH = 20;
const BPS_DENOMINATOR = 10000n;

export interface PrivateOrder {
  sellToken: bigint;
  buyToken: bigint;
  sellAmount: bigint;
  buyAmount: bigint;
  maxFee: bigint;
  expiry: bigint;
  nonce: bigint;
  // EdDSA signature
  pubKeyAx: bigint;
  pubKeyAy: bigint;
  sigS: bigint;
  sigR8x: bigint;
  sigR8y: bigint;
  // Commitment info
  ownerSecret: bigint;
  balance: bigint;
  salt: bigint;
  leafIndex: number;
  // Claims
  claims: ClaimLeafData[];
}

export interface PrivateMatch {
  maker: PrivateOrder;
  taker: PrivateOrder;
}

export class PrivateSubmitter {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private settlement: ethers.Contract;
  private pool: ethers.Contract;
  private commitmentLeaves: bigint[] = [];

  constructor(
    privateSettlementAddr: string,
    commitmentPoolAddr: string,
    provider?: ethers.JsonRpcProvider,
  ) {
    this.provider = provider ?? new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new ethers.Wallet(config.relayerPrivateKey, this.provider);
    this.settlement = new ethers.Contract(privateSettlementAddr, PRIVATE_SETTLEMENT_ABI, this.wallet);
    this.pool = new ethers.Contract(commitmentPoolAddr, COMMITMENT_POOL_ABI, this.provider);
  }

  /** Index all commitment deposits from on-chain events. */
  async indexCommitments(): Promise<void> {
    const filter = this.pool.filters.CommitmentInserted();
    const events = await this.pool.queryFilter(filter, 0, "latest");
    this.commitmentLeaves = [];

    for (const event of events) {
      const parsed = this.pool.interface.parseLog({
        topics: event.topics as string[],
        data: event.data,
      });
      if (parsed) {
        const leafIndex = Number(parsed.args.leafIndex);
        while (this.commitmentLeaves.length <= leafIndex) {
          this.commitmentLeaves.push(0n);
        }
        this.commitmentLeaves[leafIndex] = BigInt(parsed.args.commitment);
      }
    }
    console.log(`Indexed ${this.commitmentLeaves.length} commitments`);
  }

  /** Submit a private settlement with ZK proof. */
  async submitPrivateSettle(match: PrivateMatch): Promise<string> {
    const { maker, taker } = match;

    // Re-index commitments to get fresh state
    await this.indexCommitments();

    // Build commitment Merkle tree
    // TODO: O(2^20) full tree rebuild is acceptable for MVP but will not scale.
    // In production, use incremental tree building (maintain partial tree state
    // and only recompute affected branches when new leaves are inserted).
    let { root: commitRoot, layers: commitLayers } = await buildMerkleTree(
      this.commitmentLeaves,
      COMMIT_TREE_DEPTH,
    );

    // Verify on-chain root matches
    const onChainRoot = await this.pool.getLastRoot();
    if (commitRoot !== BigInt(onChainRoot)) {
      console.warn("Local tree root differs from on-chain root, re-indexing...");
      await this.indexCommitments();
      const freshResult = await buildMerkleTree(this.commitmentLeaves, COMMIT_TREE_DEPTH);
      commitRoot = freshResult.root;
      commitLayers = freshResult.layers;
    }

    // Get Merkle proofs for maker/taker commitments
    const makerProof = getMerkleProof(commitLayers, maker.leafIndex);
    const takerProof = getMerkleProof(commitLayers, taker.leafIndex);

    // Compute claim leaves and roots
    const makerClaimLeaves = await Promise.all(
      maker.claims.map((c) => computeClaimLeaf(c)),
    );
    const takerClaimLeaves = await Promise.all(
      taker.claims.map((c) => computeClaimLeaf(c)),
    );

    // Pad to 16 for Merkle tree
    const pad16 = (arr: bigint[]) => {
      const p = [...arr];
      while (p.length < 16) p.push(0n);
      return p;
    };

    const { root: claimsRootMaker } = await buildMerkleTree(pad16(makerClaimLeaves), CLAIMS_TREE_DEPTH);
    const { root: claimsRootTaker } = await buildMerkleTree(pad16(takerClaimLeaves), CLAIMS_TREE_DEPTH);

    // Compute totals
    const totalLockedMaker = maker.claims.reduce((sum, c) => sum + c.amount, 0n);
    const totalLockedTaker = taker.claims.reduce((sum, c) => sum + c.amount, 0n);

    // Compute nullifiers
    const makerNullifier = await computeNullifier(maker.ownerSecret, maker.salt);
    const takerNullifier = await computeNullifier(taker.ownerSecret, taker.salt);
    const makerNonceNullifier = await computeNullifier(maker.ownerSecret, maker.nonce);
    const takerNonceNullifier = await computeNullifier(taker.ownerSecret, taker.nonce);

    // Compute new commitments (after sell amount deduction)
    const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const genSalt = (): bigint => {
      let val: bigint;
      do {
        const bytes = crypto.randomBytes(32);
        bytes[0] &= 0x1f;
        val = BigInt("0x" + bytes.toString("hex"));
      } while (val >= FIELD_MODULUS);
      return val;
    };
    const makerNewSalt = genSalt();
    const takerNewSalt = genSalt();

    const makerNewBal = maker.balance - maker.sellAmount;
    const takerNewBal = taker.balance - taker.sellAmount;

    const makerNewCommitment = makerNewBal > 0n
      ? await computeCommitment(maker.ownerSecret, maker.sellToken, makerNewBal, makerNewSalt)
      : 0n;
    const takerNewCommitment = takerNewBal > 0n
      ? await computeCommitment(taker.ownerSecret, taker.sellToken, takerNewBal, takerNewSalt)
      : 0n;

    // Token addresses (maker receives taker's sell token and vice versa)
    const tokenMaker = taker.sellToken; // what maker receives
    const tokenTaker = maker.sellToken; // what taker receives

    // Fee is cross-side: makerFee deducted from maker's sell → taker's receive token,
    // takerFee deducted from taker's sell → maker's receive token.
    // Use maxFee as-is: frontend already computed claim amounts based on this rate.
    const makerFeeBps = maker.maxFee;
    const takerFeeBps = taker.maxFee;
    if (makerFeeBps < 0n || makerFeeBps > BPS_DENOMINATOR ||
        takerFeeBps < 0n || takerFeeBps > BPS_DENOMINATOR) {
      throw new Error(`Invalid fee BPS: maker=${makerFeeBps}, taker=${takerFeeBps}`);
    }
    // Floor division — matches circuit's floor-division check:
    // fee * 10000 <= sellAmount * feeBps < fee * 10000 + 10000
    const feeTokenMaker = (taker.sellAmount * takerFeeBps) / BPS_DENOMINATOR;
    const feeTokenTaker = (maker.sellAmount * makerFeeBps) / BPS_DENOMINATOR;
    const UINT96_MAX = (1n << 96n) - 1n;
    if (feeTokenMaker > UINT96_MAX || feeTokenTaker > UINT96_MAX) {
      throw new Error("fee exceeds uint96 range");
    }

    // Reject if fee BPS is below relayer's minimum (covers gas + profit)
    const minFeeBps = BigInt(config.relayerFee);
    if (makerFeeBps < minFeeBps || takerFeeBps < minFeeBps) {
      throw new Error(
        `Fee too low: maker=${makerFeeBps} bps, taker=${takerFeeBps} bps, ` +
        `minimum=${minFeeBps} bps. Rejecting settlement.`
      );
    }

    // Compute timestamp once — reused for both circuit input and contract call
    const currentTimestamp = BigInt(Math.floor(Date.now() / 1000));

    // Generate ZK proof
    console.log("Generating settle ZK proof...");
    const snarkjs = await import("snarkjs");

    const circuitInput: Record<string, string | string[]> = {
      commitmentRoot: commitRoot.toString(),
      makerNullifier: makerNullifier.toString(),
      takerNullifier: takerNullifier.toString(),
      makerNonceNullifier: makerNonceNullifier.toString(),
      takerNonceNullifier: takerNonceNullifier.toString(),
      makerNewCommitment: makerNewCommitment.toString(),
      takerNewCommitment: takerNewCommitment.toString(),
      claimsRootMaker: claimsRootMaker.toString(),
      claimsRootTaker: claimsRootTaker.toString(),
      totalLockedMaker: totalLockedMaker.toString(),
      totalLockedTaker: totalLockedTaker.toString(),
      tokenMaker: tokenMaker.toString(),
      tokenTaker: tokenTaker.toString(),
      feeTokenMaker: feeTokenMaker.toString(),
      feeTokenTaker: feeTokenTaker.toString(),
      currentTimestamp: currentTimestamp.toString(),

      makerSecret: maker.ownerSecret.toString(),
      makerSellToken: maker.sellToken.toString(),
      makerBalance: maker.balance.toString(),
      makerSalt: maker.salt.toString(),
      makerPath: makerProof.pathElements.map((e) => e.toString()),
      makerPathIdx: makerProof.pathIndices.map((i) => i.toString()),

      takerSecret: taker.ownerSecret.toString(),
      takerSellToken: taker.sellToken.toString(),
      takerBalance: taker.balance.toString(),
      takerSalt: taker.salt.toString(),
      takerPath: takerProof.pathElements.map((e) => e.toString()),
      takerPathIdx: takerProof.pathIndices.map((i) => i.toString()),

      makerSellAmount: maker.sellAmount.toString(),
      makerBuyAmount: maker.buyAmount.toString(),
      makerMaxFee: maker.maxFee.toString(),
      makerExpiry: maker.expiry.toString(),
      makerNonce: maker.nonce.toString(),
      takerSellAmount: taker.sellAmount.toString(),
      takerBuyAmount: taker.buyAmount.toString(),
      takerMaxFee: taker.maxFee.toString(),
      takerExpiry: taker.expiry.toString(),
      takerNonce: taker.nonce.toString(),

      makerFee: makerFeeBps.toString(),
      takerFee: takerFeeBps.toString(),
      makerNewSalt: makerNewSalt.toString(),
      takerNewSalt: takerNewSalt.toString(),

      makerPubKeyAx: maker.pubKeyAx.toString(),
      makerPubKeyAy: maker.pubKeyAy.toString(),
      makerSigS: maker.sigS.toString(),
      makerSigR8x: maker.sigR8x.toString(),
      makerSigR8y: maker.sigR8y.toString(),

      takerPubKeyAx: taker.pubKeyAx.toString(),
      takerPubKeyAy: taker.pubKeyAy.toString(),
      takerSigS: taker.sigS.toString(),
      takerSigR8x: taker.sigR8x.toString(),
      takerSigR8y: taker.sigR8y.toString(),

      makerClaimLeaves: pad16(makerClaimLeaves).map((l) => l.toString()),
      makerClaimCount: makerClaimLeaves.length.toString(),
      takerClaimLeaves: pad16(takerClaimLeaves).map((l) => l.toString()),
      takerClaimCount: takerClaimLeaves.length.toString(),
    };

    const wasmPath = path.join(__dirname, "../../../circuits/build/settle_js/settle.wasm");
    const zkeyPath = path.join(__dirname, "../../../circuits/build/settle_final.zkey");

    const { proof } = await snarkjs.groth16.fullProve(circuitInput, wasmPath, zkeyPath);
    console.log("Settle ZK proof generated!");

    // Format proof for Solidity
    const proofA: [bigint, bigint] = [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])];
    const proofB: [[bigint, bigint], [bigint, bigint]] = [
      [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
      [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
    ];
    const proofC: [bigint, bigint] = [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])];

    // Submit on-chain
    const hexNonce = await this.provider.send("eth_getTransactionCount", [this.wallet.address, "pending"]);
    const nonce = parseInt(hexNonce, 16);

    const tx = await this.settlement.settlePrivate({
      proofA,
      proofB,
      proofC,
      currentRoot: commitRoot,
      currentTimestamp,
      makerNullifier: "0x" + makerNullifier.toString(16).padStart(64, "0"),
      takerNullifier: "0x" + takerNullifier.toString(16).padStart(64, "0"),
      makerNonceNullifier: "0x" + makerNonceNullifier.toString(16).padStart(64, "0"),
      takerNonceNullifier: "0x" + takerNonceNullifier.toString(16).padStart(64, "0"),
      makerNewCommitment: "0x" + makerNewCommitment.toString(16).padStart(64, "0"),
      takerNewCommitment: "0x" + takerNewCommitment.toString(16).padStart(64, "0"),
      claimsRootMaker: "0x" + claimsRootMaker.toString(16).padStart(64, "0"),
      claimsRootTaker: "0x" + claimsRootTaker.toString(16).padStart(64, "0"),
      totalLockedMaker,
      totalLockedTaker,
      tokenMaker: "0x" + tokenMaker.toString(16).padStart(40, "0"),
      tokenTaker: "0x" + tokenTaker.toString(16).padStart(40, "0"),
      feeTokenMaker,
      feeTokenTaker,
    }, { nonce });

    const receipt = await tx.wait();
    console.log(`Private settlement tx: ${receipt.hash}`);
    return receipt.hash;
  }
}
