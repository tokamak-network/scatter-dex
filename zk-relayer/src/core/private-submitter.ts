/**
 * Claim + vault-fee submitter against PrivateSettlement.
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
import type { PrivateOrderDB } from "./db.js";
import { queryFilterChunked } from "./chunked-query.js";
import { sendAndWait } from "./tx-retry.js";
import { recordSettlement } from "./metrics.js";
import { FEE_BPS_DENOMINATOR } from "./fees.js";
import { createLogger } from "./logger.js";
import path from "path";
import { fileURLToPath } from "url";

const log = createLogger("private-submitter");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PRIVATE_SETTLEMENT_ABI = [
  "function claimWithProof(uint[2] proofA, uint[2][2] proofB, uint[2] proofC, bytes32 claimsRoot, bytes32 claimNullifier, uint256 amount, address token, address recipient, uint256 releaseTime) external",
  "function claimNullifiers(bytes32) view returns (bool)",
  // public mapping(bytes32 => ClaimsGroup) — ethers returns the
  // struct as a tuple; field order matches SettleVerifyLib.ClaimsGroup
  // (totalLocked, totalClaimed, token, tier). The tier field selects
  // which per-tier claim verifier (claim_vkey / claim_64_vkey /
  // claim_128_vkey) the relayer's off-chain pre-flight should use.
  "function claimsGroups(bytes32) view returns (uint128 totalLocked, uint128 totalClaimed, address token, uint8 tier)",
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

  // Tree cache for /merkle-proof; rebuild only when leaf count grows.
  // Concurrent requests on a busy relayer must not each re-run the
  // depth-20 build or the event loop starves.
  private cachedTree: { leafCount: number; tree: Awaited<ReturnType<typeof buildMerkleTree>> } | null = null;
  private treeBuildInflight: Promise<Awaited<ReturnType<typeof buildMerkleTree>>> | null = null;
  private indexInflight: Promise<void> | null = null;
  private lastIndexedBlock: number = -1;
  private warnedIndexStall: boolean = false;

  /** Get a Merkle proof for a specific leaf in the commitment tree. */
  async getCommitmentMerkleProof(leafIndex: number): Promise<{
    root: string;
    pathElements: string[];
    pathIndices: number[];
  }> {
    await this.indexCommitments();
    if (
      !this.cachedTree ||
      this.cachedTree.leafCount !== this.commitmentLeaves.length
    ) {
      // Coalesce concurrent rebuilds onto a single Promise so a burst
      // of /merkle-proof requests doesn't spawn N parallel depth-20
      // builds when the cache is empty/stale.
      if (!this.treeBuildInflight) {
        const targetCount = this.commitmentLeaves.length;
        this.treeBuildInflight = buildMerkleTree(this.commitmentLeaves, COMMIT_TREE_DEPTH)
          .then((tree) => {
            this.cachedTree = { leafCount: targetCount, tree };
            return tree;
          })
          .finally(() => {
            this.treeBuildInflight = null;
          });
      }
      await this.treeBuildInflight;
    }
    const cached = this.cachedTree!;
    const proof = getMerkleProof(cached.tree, leafIndex);
    return {
      root: cached.tree.root.toString(),
      pathElements: proof.pathElements.map((e) => e.toString()),
      pathIndices: proof.pathIndices,
    };
  }

  /** Index commitment deposits from on-chain events. Incremental: only
   *  queries blocks past `lastIndexedBlock`, so /merkle-proof on a hot
   *  relayer doesn't re-scan history each call. Concurrent callers
   *  share a single in-flight indexing pass via `indexInflight`. */
  async indexCommitments(): Promise<void> {
    if (this.indexInflight) return this.indexInflight;
    this.indexInflight = this.runIndexCommitments().finally(() => {
      this.indexInflight = null;
    });
    return this.indexInflight;
  }

  private async runIndexCommitments(): Promise<void> {
    const filter = this.pool.filters.CommitmentInserted();
    let fromBlock: number;
    if (this.lastIndexedBlock >= 0) {
      fromBlock = this.lastIndexedBlock + 1;
    } else {
      // INDEX_FROM_BLOCK lets operators skip pre-deployment history on
      // forked chains where some upstream RPCs (drpc free) reject >10k
      // block ranges. Default 0 for fresh anvil chains.
      const raw = process.env.INDEX_FROM_BLOCK;
      const parsed = raw !== undefined ? Number(raw) : 0;
      fromBlock = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
      if (raw !== undefined && fromBlock !== parsed) {
        log.warn("INDEX_FROM_BLOCK is not a non-negative integer; falling back to 0", { raw });
      }
      this.commitmentLeaves = [];
    }
    // Stay `confirmations` blocks behind tip — newer blocks can be
    // reorged. Caveat: lag too far and CommitmentPool's root ring
    // buffer (ROOT_HISTORY_SIZE) rotates the lagged root out before
    // clients submit, causing on-chain `isKnownRoot` to revert. See
    // config.ts:indexConfirmations for the trade-off discussion.
    // Bumping INDEX_CONFIRMATIONS at restart, or running on a very
    // fresh chain, can leave nothing to index until tip advances;
    // surface that with a one-shot warn so it isn't a silent stall.
    const tip = await this.provider.getBlockNumber();
    const toBlock = tip - config.indexConfirmations;
    if (toBlock < 0 || fromBlock > toBlock) {
      if (!this.warnedIndexStall) {
        log.warn("indexer paused — waiting for tip to advance", {
          tip,
          confirmations: config.indexConfirmations,
          fromBlock,
          toBlock,
        });
        this.warnedIndexStall = true;
      }
      return;
    }
    this.warnedIndexStall = false;
    // Chunked so a restart that re-scans from INDEX_FROM_BLOCK never issues a
    // single full-history queryFilter that exceeds the RPC's getLogs cap.
    const events = await queryFilterChunked(
      this.pool,
      filter,
      fromBlock,
      toBlock,
      config.indexBlockRange,
    );
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
    this.lastIndexedBlock = toBlock;
    if (events.length > 0) {
      log.info("Indexed commitments", {
        total: this.commitmentLeaves.length,
        added: events.length,
        tip,
        indexed: toBlock,
      });
    }
  }


  // One vkey per tier. The settle contract stores `tier` on each
  // ClaimsGroup (set when registerClaimsGroup writes it from the
  // authorize proof's tier), so the relayer can pick the matching
  // verification key for any group's claims without an
  // out-of-band hint from the recipient.
  private claimVkeyByTier: Map<number, any> = new Map();

  /** Verify a claim proof off-chain before spending gas. The on-chain
   *  group's `tier` (queried by `claimsRoot`) selects the matching
   *  vkey — without this, a tier-64 / tier-128 claim is rejected
   *  here even though the contract would accept it via its own
   *  per-tier verifier. */
  private async verifyClaimProof(
    proofA: [bigint, bigint],
    proofB: [[bigint, bigint], [bigint, bigint]],
    proofC: [bigint, bigint],
    publicSignals: string[],
    claimsRoot: string,
  ): Promise<boolean> {
    const snarkjs = await import("snarkjs");
    const group = await this.settlement.claimsGroups(claimsRoot) as {
      token: string;
      tier: bigint;
    };
    if (group.token === ethers.ZeroAddress) {
      // tier reads as 0 for an unregistered group — bail before trying
      // to load `claim_0_vkey.json` (ENOENT). The caller surfaces this
      // as a 400-class error instead of a confusing internal failure.
      throw new Error(
        `Claims group not registered for root ${claimsRoot} — settle tx may not have confirmed yet`,
      );
    }
    const tier = Number(group.tier);
    if (![16, 64, 128].includes(tier)) {
      throw new Error(
        `Unsupported claim tier ${tier} for root ${claimsRoot} — relayer has no matching vkey`,
      );
    }
    let vkey = this.claimVkeyByTier.get(tier);
    if (!vkey) {
      const suffix = tier === 16 ? "" : `_${tier}`;
      const vkeyPath = path.join(
        __dirname,
        `../../../circuits/build/claim${suffix}_vkey.json`,
      );
      const { readFileSync } = await import("fs");
      vkey = JSON.parse(readFileSync(vkeyPath, "utf8"));
      this.claimVkeyByTier.set(tier, vkey);
    }

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

    const valid = await this.verifyClaimProof(params.proofA, params.proofB, params.proofC, publicSignals, params.claimsRoot);
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
      log.info("Gasless claim tx", { txHash });
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
      log.info("FeeVault claim", { txHash, token, balance: balance.toString() });
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

  /** Public escape hatch onto the same nonce-serializing lock that
   *  guards `submitClaim` / `claimVaultFee`. Other routes that need
   *  to drive the relayer wallet must funnel through here so
   *  concurrent POSTs across endpoints don't race for the same
   *  nonce. */
  sendWithTxLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.withTxLock(fn);
  }
}
