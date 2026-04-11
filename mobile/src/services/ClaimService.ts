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
   * 전체 claim 플로우 실행
   */
  async execute(
    signer: ethers.Signer,
    claimData: ClaimData,
    readProvider: ethers.JsonRpcProvider,
    onProgress: (progress: ClaimProgress) => void,
  ): Promise<string | null> {
    try {
      // ─── Step 1: 상태 확인 ─────────────────────────────
      onProgress({ step: 'checking_status' });

      const { claimed: alreadyClaimed, nullifier } = await this.checkClaimStatus(claimData, readProvider);
      if (alreadyClaimed) {
        throw new Error('This claim has already been processed.');
      }

      // releaseTime 확인
      const now = Math.floor(Date.now() / 1000);
      if (BigInt(claimData.releaseTime) > BigInt(now)) {
        const remaining = Number(BigInt(claimData.releaseTime) - BigInt(now));
        const minutes = Math.ceil(remaining / 60);
        throw new Error(`Claim not yet available. Wait ${minutes} more minutes.`);
      }

      // ─── Step 2: ZK proof 생성 ─────────────────────────
      onProgress({ step: 'generating_proof' });

      // Compute claim leaf hash
      const leafHash = await ZKBridgeService.poseidonHash([
        claimData.secret,
        BigInt(claimData.recipient).toString(),
        BigInt(claimData.token).toString(),
        claimData.amount,
        claimData.releaseTime,
      ]);

      // Verify leaf matches
      if (leafHash !== claimData.allLeaves[claimData.leafIndex]) {
        throw new Error('Claim data does not match leaf at given index.');
      }

      // Build claims Merkle tree and get proof
      const treeResult = await buildPoseidonMerkleTree(claimData.allLeaves, CLAIMS_TREE_DEPTH);
      const { pathElements, pathIndices } = getMerkleProofFromTree(
        treeResult.layers,
        claimData.leafIndex,
      );

      const circuitInputs: Record<string, string | string[]> = {
        // Public
        claimsRoot: treeResult.root,
        nullifier,
        amount: claimData.amount,
        token: BigInt(claimData.token).toString(),
        recipient: BigInt(claimData.recipient).toString(),
        releaseTime: claimData.releaseTime,
        // Private
        secret: claimData.secret,
        leafIndex: claimData.leafIndex.toString(),
        pathElements,
        pathIndices,
      };

      // Load circuit files
      let wasmB64: string;
      let zkeyB64: string;
      try {
        wasmB64 = await loadCircuitFileB64(require('../../assets/zk/claim.wasm'));
        zkeyB64 = await loadCircuitFileB64(require('../../assets/zk/claim_final.zkey'));
      } catch {
        throw new Error('Claim circuit files not found in assets/zk/.');
      }

      const proofResult = await ZKBridgeService.generateProof(
        circuitInputs,
        wasmB64,
        zkeyB64,
      );

      const proof = formatProofForSolidity(proofResult.proof);

      // ─── Step 3: 온체인 제출 ───────────────────────────
      onProgress({ step: 'submitting' });

      const settlementAddr = ConfigService.getPrivateSettlementAddress();
      if (!settlementAddr) throw new Error('PrivateSettlement address not configured');

      // PrivateSettlement.claimWithProof — argument order must match on-chain:
      // (proof, claimsRoot, claimNullifier, amount, token, recipient, releaseTime)
      const settlement = new ethers.Contract(settlementAddr, [
        'function claimWithProof(uint[2] proofA, uint[2][2] proofB, uint[2] proofC, bytes32 claimsRoot, bytes32 claimNullifier, uint256 amount, address token, address recipient, uint256 releaseTime) external',
      ], signer);

      const claimsRootBytes32 = toBytes32Hex(treeResult.root);
      const nullifierBytes32 = toBytes32Hex(nullifier);

      const tx = await settlement.claimWithProof(
        proof.a,
        proof.b,
        proof.c,
        claimsRootBytes32,
        nullifierBytes32,
        claimData.amount,
        claimData.token,
        claimData.recipient,
        claimData.releaseTime,
      );

      const receipt = await tx.wait();

      onProgress({ step: 'success', txHash: tx.hash });
      return tx.hash;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Claim failed';
      onProgress({ step: 'error', error: message });
      return null;
    }
  },
};

