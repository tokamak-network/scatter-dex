/**
 * ClaimService — 정산된 토큰 클레임
 *
 * 플로우:
 * 1. Claim 데이터 입력 (주문 파일에서 가져옴)
 * 2. 온체인 클레임 상태 확인 (claimNullifier 사용 여부)
 * 3. ZK claim proof 생성 (ZKBridgeService → WebView)
 * 4. 릴레이어 또는 직접 온체인 제출
 */
import { ethers } from 'ethers';
import { ZKBridgeService } from './ZKBridgeService';
import { ConfigService } from './ConfigService';
import { RelayerApiService } from './RelayerApiService';
import { PRIVATE_SETTLEMENT_ABI } from '../lib/contracts';
import { TAG_CLAIM_NULL } from '../lib/zk/tags';
import { CLAIMS_TREE_DEPTH } from '../lib/zk/constants';
import { toBytes32Hex } from '../lib/format';
import { loadCircuitFileB64 } from '../lib/circuitLoader';
import { formatProofForSolidity } from '../lib/proofFormat';
import { buildPoseidonMerkleTree, getMerkleProofFromTree } from '../lib/merkleTree';

export type ClaimStep =
  | 'idle'
  | 'checking_status'
  | 'generating_proof'
  | 'submitting'
  | 'success'
  | 'error';

export interface ClaimProgress {
  step: ClaimStep;
  txHash?: string;
  error?: string;
  // Populated during batch execution so the UI can render per-chunk progress.
  chunk?: number;
  totalChunks?: number;
  proofDone?: number;
  claimsInChunk?: number;
  // On a mid-batch error, carries the tx hashes of chunks that already
  // committed on-chain so the UI can (a) tell the user partial success
  // happened, (b) surface the tx hashes for on-chain verification, and
  // (c) remove the corresponding entries from the local pending list.
  partialTxHashes?: string[];
  partialCommittedCount?: number;
}

export interface ClaimData {
  secret: string;          // decimal string
  recipient: string;       // Ethereum address
  token: string;           // token address
  amount: string;          // wei string
  releaseTime: string;     // unix timestamp string
  leafIndex: number;       // index in claims tree
  allLeaves: string[];     // all 16 claim leaf hashes (decimal strings)
}

// Must stay in sync with PrivateSettlement.MAX_CLAIM_BATCH_SIZE.
export const MAX_CLAIM_BATCH_SIZE = 20;

interface BuiltClaim {
  proof: { a: any; b: any; c: any };
  claimsRootHex: string;
  nullifierHex: string;
  amount: string;
  token: string;
  recipient: string;
  releaseTime: string;
}


export const ClaimService = {
  /** Returns { claimed, nullifier } so execute() can reuse the nullifier. */
  async checkClaimStatus(
    claimData: ClaimData,
    provider: ethers.JsonRpcProvider,
  ): Promise<{ claimed: boolean; nullifier: string }> {
    const settlementAddr = ConfigService.getPrivateSettlementAddress();
    const nullifier = await ZKBridgeService.computeNullifier(
      TAG_CLAIM_NULL.toString(),
      claimData.secret,
      claimData.leafIndex.toString(),
    );
    if (!settlementAddr) return { claimed: false, nullifier };

    const settlement = new ethers.Contract(settlementAddr, PRIVATE_SETTLEMENT_ABI, provider);
    const claimed = await settlement.claimNullifiers(toBytes32Hex(nullifier));
    return { claimed, nullifier };
  },

  /**
   * Build a Groth16 claim proof without touching the chain. Extracted so batch
   * and relayer paths can reuse it — proof gen is the expensive step.
   */
  async buildProof(claimData: ClaimData): Promise<BuiltClaim> {
    const now = Math.floor(Date.now() / 1000);
    if (BigInt(claimData.releaseTime) > BigInt(now)) {
      const remaining = Number(BigInt(claimData.releaseTime) - BigInt(now));
      const minutes = Math.ceil(remaining / 60);
      throw new Error(`Claim not yet available. Wait ${minutes} more minute(s).`);
    }

    const nullifier = await ZKBridgeService.computeNullifier(
      TAG_CLAIM_NULL.toString(),
      claimData.secret,
      claimData.leafIndex.toString(),
    );

    const leafHash = await ZKBridgeService.poseidonHash([
      claimData.secret,
      BigInt(claimData.recipient).toString(),
      BigInt(claimData.token).toString(),
      claimData.amount,
      claimData.releaseTime,
    ]);
    if (leafHash !== claimData.allLeaves[claimData.leafIndex]) {
      throw new Error('Claim data does not match leaf at given index.');
    }

    const treeResult = await buildPoseidonMerkleTree(claimData.allLeaves, CLAIMS_TREE_DEPTH);
    const { pathElements, pathIndices } = getMerkleProofFromTree(
      treeResult.layers,
      claimData.leafIndex,
    );

    const circuitInputs: Record<string, string | string[]> = {
      claimsRoot: treeResult.root,
      nullifier,
      amount: claimData.amount,
      token: BigInt(claimData.token).toString(),
      recipient: BigInt(claimData.recipient).toString(),
      releaseTime: claimData.releaseTime,
      secret: claimData.secret,
      leafIndex: claimData.leafIndex.toString(),
      pathElements,
      pathIndices,
    };

    let wasmB64: string;
    let zkeyB64: string;
    try {
      wasmB64 = await loadCircuitFileB64(require('../../assets/zk/claim.wasm'));
      zkeyB64 = await loadCircuitFileB64(require('../../assets/zk/claim_final.zkey'));
    } catch {
      throw new Error('Claim circuit files not found in assets/zk/.');
    }

    const proofResult = await ZKBridgeService.generateProof(circuitInputs, wasmB64, zkeyB64);
    const proof = formatProofForSolidity(proofResult.proof);

    return {
      proof,
      claimsRootHex: toBytes32Hex(treeResult.root),
      nullifierHex: toBytes32Hex(nullifier),
      amount: claimData.amount,
      token: claimData.token,
      recipient: claimData.recipient,
      releaseTime: claimData.releaseTime,
    };
  },

  /**
   * Single-claim wallet path — user pays gas.
   */
  async execute(
    signer: ethers.Signer,
    claimData: ClaimData,
    readProvider: ethers.JsonRpcProvider,
    onProgress: (progress: ClaimProgress) => void,
  ): Promise<string | null> {
    try {
      onProgress({ step: 'checking_status' });
      const { claimed } = await this.checkClaimStatus(claimData, readProvider);
      if (claimed) throw new Error('This claim has already been processed.');

      onProgress({ step: 'generating_proof' });
      const built = await this.buildProof(claimData);

      onProgress({ step: 'submitting' });
      const settlementAddr = ConfigService.getPrivateSettlementAddress();
      if (!settlementAddr) throw new Error('PrivateSettlement address not configured');
      const settlement = new ethers.Contract(settlementAddr, PRIVATE_SETTLEMENT_ABI, signer);

      const tx = await settlement.claimWithProof(
        built.proof.a, built.proof.b, built.proof.c,
        built.claimsRootHex, built.nullifierHex,
        built.amount, built.token, built.recipient, built.releaseTime,
      );
      await tx.wait();

      onProgress({ step: 'success', txHash: tx.hash });
      return tx.hash;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Claim failed';
      onProgress({ step: 'error', error: message });
      return null;
    }
  },

  /**
   * Batch wallet path — chunks into MAX_CLAIM_BATCH_SIZE groups, builds proofs
   * sequentially within each chunk (proof gen is single-threaded via WebView),
   * and submits one settleWithBatch per chunk. Atomic per-chunk: a single bad
   * claim reverts its whole chunk; earlier chunks already committed remain.
   */
  async executeBatch(
    signer: ethers.Signer,
    claims: ClaimData[],
    readProvider: ethers.JsonRpcProvider,
    onProgress: (progress: ClaimProgress) => void,
  ): Promise<string[] | null> {
    // Hoisted so the catch below can report partial success if a later chunk
    // fails after earlier chunks have already committed on-chain.
    const txHashes: string[] = [];
    let committedCount = 0;
    try {
      if (claims.length === 0) throw new Error('No claims to submit.');

      onProgress({ step: 'checking_status' });
      const statuses = await Promise.all(claims.map((c) => this.checkClaimStatus(c, readProvider)));
      const eligible = claims.filter((_, i) => !statuses[i].claimed);
      if (eligible.length === 0) throw new Error('All selected claims have already been processed.');

      const settlementAddr = ConfigService.getPrivateSettlementAddress();
      if (!settlementAddr) throw new Error('PrivateSettlement address not configured');
      const settlement = new ethers.Contract(settlementAddr, PRIVATE_SETTLEMENT_ABI, signer);

      const totalChunks = Math.ceil(eligible.length / MAX_CLAIM_BATCH_SIZE);

      for (let ci = 0; ci < totalChunks; ci++) {
        const chunk = eligible.slice(ci * MAX_CLAIM_BATCH_SIZE, (ci + 1) * MAX_CLAIM_BATCH_SIZE);
        const built: BuiltClaim[] = [];

        for (let pi = 0; pi < chunk.length; pi++) {
          onProgress({
            step: 'generating_proof',
            chunk: ci + 1,
            totalChunks,
            claimsInChunk: chunk.length,
            proofDone: pi,
          });
          built.push(await this.buildProof(chunk[pi]));
        }

        onProgress({
          step: 'submitting',
          chunk: ci + 1,
          totalChunks,
          claimsInChunk: chunk.length,
          proofDone: chunk.length,
        });

        const params = built.map((b) => ({
          proofA: b.proof.a,
          proofB: b.proof.b,
          proofC: b.proof.c,
          claimsRoot: b.claimsRootHex,
          claimNullifier: b.nullifierHex,
          amount: b.amount,
          token: b.token,
          recipient: b.recipient,
          releaseTime: b.releaseTime,
        }));
        const tx = await settlement.claimWithProofBatch(params);
        await tx.wait();
        txHashes.push(tx.hash);
        committedCount += chunk.length;
      }

      onProgress({ step: 'success', txHash: txHashes[txHashes.length - 1] });
      return txHashes;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Batch claim failed';
      onProgress({
        step: 'error',
        error: message,
        partialTxHashes: txHashes.length > 0 ? txHashes : undefined,
        partialCommittedCount: committedCount > 0 ? committedCount : undefined,
      });
      // Preserve partial success — the tx hashes that did land are the user's
      // only record that those chunks committed. Return them so the caller
      // can still clean up the already-claimed entries from local storage.
      return txHashes.length > 0 ? txHashes : null;
    }
  },

  /**
   * Gasless path — relayer pays gas and (typically) deducts a fee from the
   * claim amount. Delegates transport to RelayerApiService so the allowlist /
   * auth concerns live in one place.
   */
  async executeViaRelayer(
    claimData: ClaimData,
    relayerUrl: string,
    readProvider: ethers.JsonRpcProvider,
    onProgress: (progress: ClaimProgress) => void,
  ): Promise<string | null> {
    try {
      onProgress({ step: 'checking_status' });
      const { claimed } = await this.checkClaimStatus(claimData, readProvider);
      if (claimed) throw new Error('This claim has already been processed.');

      onProgress({ step: 'generating_proof' });
      const built = await this.buildProof(claimData);

      onProgress({ step: 'submitting' });
      const res = await RelayerApiService.submitPrivateClaim({
        proofA: built.proof.a,
        proofB: built.proof.b,
        proofC: built.proof.c,
        claimsRoot: built.claimsRootHex,
        claimNullifier: built.nullifierHex,
        amount: built.amount,
        token: built.token,
        recipient: built.recipient,
        releaseTime: built.releaseTime,
      }, relayerUrl);

      onProgress({ step: 'success', txHash: res.txHash });
      return res.txHash;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Gasless claim failed';
      onProgress({ step: 'error', error: message });
      return null;
    }
  },
};

