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
import { sendAndWait } from "./tx-retry.js";
import { recordSettlement } from "./metrics.js";
import { FEE_BPS_DENOMINATOR } from "./fees.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PRIVATE_SETTLEMENT_ABI = [
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

  // Tree cache for /merkle-proof; rebuild only when leaf count grows.
  // Concurrent requests on a busy relayer must not each re-run the
  // depth-20 build or the event loop starves.
  private cachedTree: { leafCount: number; tree: Awaited<ReturnType<typeof buildMerkleTree>> } | null = null;
  private treeBuildInflight: Promise<Awaited<ReturnType<typeof buildMerkleTree>>> | null = null;
  private indexInflight: Promise<void> | null = null;
  private lastIndexedBlock: number = -1;

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
        console.warn(`INDEX_FROM_BLOCK=${raw} is not a non-negative integer; falling back to 0`);
      }
      this.commitmentLeaves = [];
    }
    // Stay `confirmations` blocks behind tip — anything newer can be
    // reorged out and would leave us with stale leaves the chain no
    // longer knows about. Default 0 for anvil/fork; ops should set
    // INDEX_CONFIRMATIONS=12 on L1 mainnet/testnet.
    const tip = await this.provider.getBlockNumber();
    const toBlock = tip - config.indexConfirmations;
    if (toBlock < 0 || fromBlock > toBlock) return;
    const events = await this.pool.queryFilter(filter, fromBlock, toBlock);
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
      console.log(`Indexed ${this.commitmentLeaves.length} commitments (+${events.length} new, tip=${tip} indexed=${toBlock})`);
    }
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
