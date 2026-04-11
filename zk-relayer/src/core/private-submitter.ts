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
  computeNonceNullifier,
  computeClaimLeaf,
  buildMerkleTree,
  getMerkleProof,
  type ClaimLeafData,
} from "./zk-prover.js";
import type { PrivateOrder, PrivateMatch } from "../types/order.js";
import type { PrivateOrderDB } from "./db.js";
import { sendAndWait } from "./tx-retry.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PRIVATE_SETTLEMENT_ABI = [
  "function settlePrivate(tuple(uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC, uint256 currentRoot, uint256 currentTimestamp, bytes32 makerNullifier, bytes32 takerNullifier, bytes32 makerNonceNullifier, bytes32 takerNonceNullifier, bytes32 makerNewCommitment, bytes32 takerNewCommitment, bytes32 claimsRootMaker, bytes32 claimsRootTaker, uint96 totalLockedMaker, uint96 totalLockedTaker, address tokenMaker, address tokenTaker, uint96 feeTokenMaker, uint96 feeTokenTaker, address makerRelayer, address takerRelayer) p) external",
  "function scatterDirect(tuple(uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC, uint256 currentRoot, bytes32 nullifier, bytes32 newCommitment, address token, uint256 withdrawAmount, bytes32 claimsRoot, uint96 totalLocked, uint96 fee) p) external",
  "function claimWithProof(uint[2] proofA, uint[2][2] proofB, uint[2] proofC, bytes32 claimsRoot, bytes32 claimNullifier, uint256 amount, address token, address recipient, uint256 releaseTime) external",
  "function claimNullifiers(bytes32) view returns (bool)",
];

const COMMITMENT_POOL_ABI = [
  "function getLastRoot() view returns (uint256)",
  "function nextIndex() view returns (uint32)",
  "event CommitmentInserted(uint256 indexed commitment, uint32 leafIndex, uint256 timestamp)",
];

const CLAIMS_TREE_DEPTH = 4;
const COMMIT_TREE_DEPTH = 20;

export class PrivateSubmitter {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private settlement: ethers.Contract;
  private pool: ethers.Contract;
  private commitmentLeaves: bigint[] = [];
  private txMutex: Promise<void> = Promise.resolve();
  private db: PrivateOrderDB | null = null;

  /** Attach DB for claims root tracking. */
  setDB(db: PrivateOrderDB): void {
    this.db = db;
  }

  constructor(provider?: ethers.JsonRpcProvider) {
    this.provider = provider ?? new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new ethers.Wallet(config.relayerPrivateKey, this.provider);
    this.settlement = new ethers.Contract(
      config.privateSettlementAddress,
      PRIVATE_SETTLEMENT_ABI,
      this.wallet,
    );
    this.pool = new ethers.Contract(
      config.commitmentPoolAddress,
      COMMITMENT_POOL_ABI,
      this.provider,
    );
  }

  getAddress(): string {
    return this.wallet.address;
  }

  getWallet(): ethers.Wallet {
    return this.wallet;
  }

  getProvider(): ethers.JsonRpcProvider {
    return this.provider;
  }

  /** Get a Merkle proof for a specific leaf in the commitment tree. */
  async getCommitmentMerkleProof(leafIndex: number): Promise<{
    root: string;
    pathElements: string[];
    pathIndices: number[];
  }> {
    await this.indexCommitments();
    const { root, layers } = await buildMerkleTree(this.commitmentLeaves, COMMIT_TREE_DEPTH);
    const proof = getMerkleProof(layers, leafIndex);
    return {
      root: root.toString(),
      pathElements: proof.pathElements.map((e) => e.toString()),
      pathIndices: proof.pathIndices,
    };
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
  async submitPrivateSettle(
    match: PrivateMatch,
    makerRelayerAddr: string,
    takerRelayerAddr: string,
  ): Promise<string> {
    const maker = match.maker.order;
    const taker = match.taker.order;

    // Re-index commitments to get fresh state
    await this.indexCommitments();

    // Build commitment Merkle tree
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

    // Pad claims to maxClaimsPerSide (16) with zero fields
    const padClaims = (claims: ClaimLeafData[], max: number): ClaimLeafData[] => {
      const padded = [...claims];
      while (padded.length < max) {
        padded.push({ secret: 0n, recipient: 0n, token: 0n, amount: 0n, releaseTime: 0n });
      }
      return padded;
    };

    const makerClaimsPadded = padClaims(maker.claims, 16);
    const takerClaimsPadded = padClaims(taker.claims, 16);

    // Compute claim leaf hashes for Merkle root.
    // Only hash real claims; unused slots are 0n (matches circuit: leaf * isUsed).
    const makerRealLeaves = await Promise.all(maker.claims.map((c) => computeClaimLeaf(c)));
    const takerRealLeaves = await Promise.all(taker.claims.map((c) => computeClaimLeaf(c)));

    const padLeaves = (leaves: bigint[], max: number): bigint[] => {
      const padded = [...leaves];
      while (padded.length < max) padded.push(0n);
      return padded;
    };

    const { root: claimsRootMaker } = await buildMerkleTree(padLeaves(makerRealLeaves, 16), CLAIMS_TREE_DEPTH);
    const { root: claimsRootTaker } = await buildMerkleTree(padLeaves(takerRealLeaves, 16), CLAIMS_TREE_DEPTH);

    // Compute totals
    const totalLockedMaker = maker.claims.reduce((sum, c) => sum + c.amount, 0n);
    const totalLockedTaker = taker.claims.reduce((sum, c) => sum + c.amount, 0n);

    // Compute nullifiers (M4: domain-separated escrow vs nonce nullifiers)
    const makerNullifier = await computeNullifier(maker.ownerSecret, maker.salt);
    const takerNullifier = await computeNullifier(taker.ownerSecret, taker.salt);
    const makerNonceNullifier = await computeNonceNullifier(maker.ownerSecret, maker.nonce);
    const takerNonceNullifier = await computeNonceNullifier(taker.ownerSecret, taker.nonce);

    // Use user-provided newSalt for change commitments (user controls their salt)
    const makerNewSalt = maker.newSalt;
    const takerNewSalt = taker.newSalt;

    const makerNewBal = maker.balance - maker.sellAmount;
    const takerNewBal = taker.balance - taker.sellAmount;

    // [issue #128] Change commitments preserve the v2 pubkey binding —
    // same BabyJub key the escrow was originally deposited with.
    const makerNewCommitment = makerNewBal > 0n
      ? await computeCommitment(
          maker.ownerSecret,
          maker.sellToken,
          makerNewBal,
          makerNewSalt,
          maker.pubKeyAx,
          maker.pubKeyAy,
        )
      : 0n;
    const takerNewCommitment = takerNewBal > 0n
      ? await computeCommitment(
          taker.ownerSecret,
          taker.sellToken,
          takerNewBal,
          takerNewSalt,
          taker.pubKeyAx,
          taker.pubKeyAy,
        )
      : 0n;

    // Token addresses (maker receives taker's sell token and vice versa)
    const tokenMaker = taker.sellToken; // what maker receives
    const tokenTaker = maker.sellToken; // what taker receives

    // Per-token fees (absolute amounts from bps)
    const makerFeeBps = BigInt(config.relayerFee);
    const takerFeeBps = BigInt(config.relayerFee);
    // feeTokenMaker = fee in tokenMaker (from taker's sell)
    const feeTokenMaker = (taker.sellAmount * takerFeeBps) / 10000n;
    // feeTokenTaker = fee in tokenTaker (from maker's sell)
    const feeTokenTaker = (maker.sellAmount * makerFeeBps) / 10000n;

    // Use latest block timestamp to stay within on-chain tolerance window
    const latestBlock = await this.provider.getBlock("latest");
    const currentTimestamp = BigInt(latestBlock!.timestamp);

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
      makerRelayer: BigInt(makerRelayerAddr).toString(),
      takerRelayer: BigInt(takerRelayerAddr).toString(),

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

      makerClaimSecrets: makerClaimsPadded.map((c) => c.secret.toString()),
      makerClaimRecipients: makerClaimsPadded.map((c) => c.recipient.toString()),
      makerClaimTokens: makerClaimsPadded.map((c) => c.token.toString()),
      makerClaimAmounts: makerClaimsPadded.map((c) => c.amount.toString()),
      makerClaimReleaseTimes: makerClaimsPadded.map((c) => c.releaseTime.toString()),
      makerClaimCount: maker.claims.length.toString(),
      takerClaimSecrets: takerClaimsPadded.map((c) => c.secret.toString()),
      takerClaimRecipients: takerClaimsPadded.map((c) => c.recipient.toString()),
      takerClaimTokens: takerClaimsPadded.map((c) => c.token.toString()),
      takerClaimAmounts: takerClaimsPadded.map((c) => c.amount.toString()),
      takerClaimReleaseTimes: takerClaimsPadded.map((c) => c.releaseTime.toString()),
      takerClaimCount: taker.claims.length.toString(),
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

    const crMakerHex = "0x" + claimsRootMaker.toString(16).padStart(64, "0");
    const crTakerHex = "0x" + claimsRootTaker.toString(16).padStart(64, "0");

    // Submit on-chain (mutex prevents nonce race with concurrent claims/settles)
    return this.withTxLock(async () => {
      // [R-1] Gas estimation + profitability check
      const { estimateAndGuard } = await import("./gas-guard.js");
      const settleParams = {
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
        claimsRootMaker: crMakerHex,
        claimsRootTaker: crTakerHex,
        totalLockedMaker,
        totalLockedTaker,
        tokenMaker: "0x" + tokenMaker.toString(16).padStart(40, "0"),
        tokenTaker: "0x" + tokenTaker.toString(16).padStart(40, "0"),
        feeTokenMaker,
        feeTokenTaker,
        makerRelayer: makerRelayerAddr,
        takerRelayer: takerRelayerAddr,
      };

      // [R-1] Gas estimation + gas price cap only.
      // feeTokenMaker/feeTokenTaker are token-denominated amounts (not native-gas wei),
      // so profitability comparison against ETH gas cost is skipped until a token→native
      // price oracle is available. Pass 0n to bypass profitability check.
      const gasCheck = await estimateAndGuard(this.settlement, "settlePrivate", [settleParams], 0n);
      if (!gasCheck.profitable) {
        console.warn(`[gas-guard] settlePrivate rejected: ${gasCheck.reason}`);
        throw new Error(`Settlement rejected: ${gasCheck.reason}`);
      }
      console.log(`[gas-guard] settlePrivate: gas=${gasCheck.gasCostEth} ETH (profitability check skipped — fees are token-denominated)`);

      // [R-2] Safe TX send with retry + timeout + receipt recovery
      const { txHash } = await sendAndWait(
        () => this.settlement.settlePrivate(settleParams, { gasLimit: gasCheck.estimatedGas }),
        this.provider,
        {
          label: "settlePrivate",
          onTxHash: (hash) => { this.db?.savePendingTx(hash, "settlePrivate"); },
        },
      );
      this.db?.removePendingTx(txHash);
      console.log(`Private settlement tx: ${txHash}`);

      // Record claims roots so this relayer only pays gas for its own claims.
      // Best-effort: chain tx already succeeded, DB failure must not break the flow.
      try {
        this.db?.saveSettledClaimsRoot(crMakerHex);
        this.db?.saveSettledClaimsRoot(crTakerHex);
      } catch (err) {
        console.warn("Failed to persist settled claims roots:", err);
      }

      return txHash;
    });
  }

  /** Submit a scatter-direct (same-token, no counterparty) using withdraw proof. */
  async submitScatterDirect(order: PrivateOrder): Promise<string> {
    await this.indexCommitments();

    // Build commitment Merkle tree
    let { root: commitRoot, layers: commitLayers } = await buildMerkleTree(
      this.commitmentLeaves,
      COMMIT_TREE_DEPTH,
    );

    const onChainRoot = await this.pool.getLastRoot();
    if (commitRoot !== BigInt(onChainRoot)) {
      await this.indexCommitments();
      const freshResult = await buildMerkleTree(this.commitmentLeaves, COMMIT_TREE_DEPTH);
      commitRoot = freshResult.root;
      commitLayers = freshResult.layers;
    }

    const merkleProof = getMerkleProof(commitLayers, order.leafIndex);

    // Nullifier
    const nullifier = await computeNullifier(order.ownerSecret, order.salt);

    // Change commitment (validate against user's expected value).
    // [issue #128] v2 binding — relayer must use the same pubkey the
    // user signed the order with, otherwise the computed commitment
    // won't match `order.expectedChangeCommitment`.
    const newSalt = order.newSalt;
    const changeAmount = order.balance - order.sellAmount;
    const newCommitment = changeAmount > 0n
      ? await computeCommitment(
          order.ownerSecret,
          order.sellToken,
          changeAmount,
          newSalt,
          order.pubKeyAx,
          order.pubKeyAy,
        )
      : 0n;
    if (order.expectedChangeCommitment !== 0n && newCommitment !== order.expectedChangeCommitment) {
      throw new Error("Change commitment mismatch: relayer-computed does not match user-expected");
    }

    // Claims
    const claimLeafHashes = await Promise.all(order.claims.map((c) => computeClaimLeaf(c)));
    const paddedLeaves = [...claimLeafHashes];
    while (paddedLeaves.length < 16) paddedLeaves.push(0n);
    const { root: claimsRoot } = await buildMerkleTree(paddedLeaves, CLAIMS_TREE_DEPTH);

    const totalLocked = order.claims.reduce((sum, c) => sum + c.amount, 0n);
    const feeBps = BigInt(config.relayerFee);
    const fee = (order.sellAmount * feeBps) / 10000n;
    const withdrawAmount = totalLocked + fee;

    // Token address
    const tokenAddr = "0x" + order.sellToken.toString(16).padStart(40, "0");
    const tokenHash = await poseidonHash([order.sellToken]);

    // recipient = PrivateSettlement, relayer = this wallet
    const recipient = config.privateSettlementAddress;
    const relayer = this.wallet.address;

    // Generate withdraw ZK proof
    console.log("Generating withdraw ZK proof for scatterDirect...");
    const snarkjs = await import("snarkjs");

    const circuitInput: Record<string, string | string[]> = {
      root: commitRoot.toString(),
      nullifierHash: nullifier.toString(),
      newCommitment: newCommitment.toString(),
      tokenHash: tokenHash.toString(),
      withdrawAmount: withdrawAmount.toString(),
      recipient: BigInt(recipient).toString(),
      relayer: BigInt(relayer).toString(),
      ownerSecret: order.ownerSecret.toString(),
      token: order.sellToken.toString(),
      amount: order.balance.toString(),
      salt: order.salt.toString(),
      newSalt: newSalt.toString(),
      pathElements: merkleProof.pathElements.map((e) => e.toString()),
      pathIndices: merkleProof.pathIndices.map((i) => i.toString()),
      // [issue #128] Pubkey the escrow was deposited with — withdraw
      // recomputes the v2 commitment internally and checks it against
      // the merkle root.
      pubKeyAx: order.pubKeyAx.toString(),
      pubKeyAy: order.pubKeyAy.toString(),
    };

    const wasmPath = path.join(__dirname, "../../../circuits/build/withdraw_js/withdraw.wasm");
    const zkeyPath = path.join(__dirname, "../../../circuits/build/withdraw_final.zkey");

    const { proof } = await snarkjs.groth16.fullProve(circuitInput, wasmPath, zkeyPath);
    console.log("Withdraw ZK proof generated for scatterDirect!");

    const proofA: [bigint, bigint] = [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])];
    const proofB: [[bigint, bigint], [bigint, bigint]] = [
      [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
      [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
    ];
    const proofC: [bigint, bigint] = [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])];
    const crHex = "0x" + claimsRoot.toString(16).padStart(64, "0");

    return this.withTxLock(async () => {
      const scatterParams = {
        proofA,
        proofB,
        proofC,
        currentRoot: commitRoot,
        nullifier: "0x" + nullifier.toString(16).padStart(64, "0"),
        newCommitment: "0x" + newCommitment.toString(16).padStart(64, "0"),
        token: tokenAddr,
        withdrawAmount,
        claimsRoot: crHex,
        totalLocked,
        fee,
      };

      // [R-1] Gas estimation + gas price cap only.
      // `fee` is denominated in the withdrawn ERC20 token, not native gas wei.
      // Skip profitability comparison until token→native conversion is available.
      const { estimateAndGuard } = await import("./gas-guard.js");
      const gasCheck = await estimateAndGuard(this.settlement, "scatterDirect", [scatterParams], 0n);
      if (!gasCheck.profitable) {
        console.warn(`[gas-guard] scatterDirect rejected: ${gasCheck.reason}`);
        throw new Error(`ScatterDirect rejected: ${gasCheck.reason}`);
      }

      // [R-2] Safe TX send with retry + timeout + receipt recovery
      const { txHash } = await sendAndWait(
        () => this.settlement.scatterDirect(scatterParams, { gasLimit: gasCheck.estimatedGas }),
        this.provider,
        {
          label: "scatterDirect",
          onTxHash: (hash) => { this.db?.savePendingTx(hash, "scatterDirect"); },
        },
      );
      this.db?.removePendingTx(txHash);
      console.log(`ScatterDirect tx: ${txHash}`);

      // Record claims root so this relayer only pays gas for its own claims.
      // Best-effort: chain tx already succeeded, DB failure must not break the flow.
      try {
        this.db?.saveSettledClaimsRoot(crHex);
      } catch (err) {
        console.warn(`Failed to persist claims root ${crHex}:`, err);
      }

      return txHash;
    });
  }

  private claimVkeyCache: any = null;

  /** Verify a claim proof off-chain before spending gas. */
  private async verifyClaimProof(
    proofA: [bigint, bigint],
    proofB: [[bigint, bigint], [bigint, bigint]],
    proofC: [bigint, bigint],
    publicSignals: string[],
  ): Promise<boolean> {
    const snarkjs = await import("snarkjs");
    if (!this.claimVkeyCache) {
      const vkeyPath = path.join(__dirname, "../../../circuits/build/claim_vkey.json");
      const { readFileSync } = await import("fs");
      this.claimVkeyCache = JSON.parse(readFileSync(vkeyPath, "utf8"));
    }
    const vkey = this.claimVkeyCache;

    const proof = {
      pi_a: [proofA[0].toString(), proofA[1].toString(), "1"],
      pi_b: [
        [proofB[0][1].toString(), proofB[0][0].toString()],
        [proofB[1][1].toString(), proofB[1][0].toString()],
        ["1", "0"],
      ],
      pi_c: [proofC[0].toString(), proofC[1].toString(), "1"],
      protocol: "groth16",
      curve: "bn128",
    };

    return snarkjs.groth16.verify(vkey, publicSignals, proof);
  }

  /** Submit a gasless claim on behalf of the recipient. */
  async submitClaim(params: {
    proofA: [bigint, bigint];
    proofB: [[bigint, bigint], [bigint, bigint]];
    proofC: [bigint, bigint];
    claimsRoot: string;
    claimNullifier: string;
    amount: bigint;
    token: string;
    recipient: string;
    releaseTime: bigint;
  }): Promise<string> {
    // Verify proof off-chain first to avoid wasting gas on invalid proofs
    const publicSignals = [
      BigInt(params.claimsRoot).toString(),
      BigInt(params.claimNullifier).toString(),
      params.amount.toString(),
      BigInt(params.token).toString(),
      BigInt(params.recipient).toString(),
      params.releaseTime.toString(),
    ];

    // Check nullifier not already spent (saves gas on replay attempts)
    const alreadySpent = await this.settlement.claimNullifiers(params.claimNullifier);
    if (alreadySpent) throw new Error("Claim nullifier already spent");

    const valid = await this.verifyClaimProof(params.proofA, params.proofB, params.proofC, publicSignals);
    if (!valid) throw new Error("Invalid claim proof — rejected before on-chain submission");

    return this.withTxLock(async () => {
      const { txHash } = await sendAndWait(
        () => this.settlement.claimWithProof(
          params.proofA,
          params.proofB,
          params.proofC,
          params.claimsRoot,
          params.claimNullifier,
          params.amount,
          params.token,
          params.recipient,
          params.releaseTime,
        ),
        this.provider,
        {
          label: "claimWithProof",
          onTxHash: (hash) => { this.db?.savePendingTx(hash, "claimWithProof"); },
        },
      );
      this.db?.removePendingTx(txHash);
      console.log(`Gasless claim tx: ${txHash}`);
      return txHash;
    });
  }

  /** Claim accumulated fees from FeeVault for a specific token. Uses tx mutex. */
  async claimVaultFee(vaultAddress: string, token: string): Promise<string> {
    const vaultAbi = [
      "function balances(address,address) view returns (uint256)",
      "function claim(address) external",
    ];
    const vault = new ethers.Contract(vaultAddress, vaultAbi, this.wallet);

    const balance = await vault.balances(this.wallet.address, token);
    if (balance === 0n) throw new Error("No fees to claim for this token");

    return this.withTxLock(async () => {
      const { txHash } = await sendAndWait(
        () => vault.claim(token),
        this.provider,
        {
          label: "claimVaultFee",
          onTxHash: (hash) => { this.db?.savePendingTx(hash, "claimVaultFee"); },
        },
      );
      this.db?.removePendingTx(txHash);
      console.log(`FeeVault claim: ${txHash} (token: ${token}, balance: ${balance})`);
      return txHash;
    });
  }

  /** Serialize tx submissions to prevent nonce collisions. */
  private withTxLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.txMutex;
    let resolve: () => void;
    this.txMutex = new Promise<void>((r) => { resolve = r; });
    return prev.then(fn).finally(() => resolve!());
  }
}
