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
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import { Asset } from 'expo-asset';
import { ZKBridgeService } from './ZKBridgeService';
import { ConfigService } from './ConfigService';
import { PRIVATE_SETTLEMENT_ABI } from '../lib/contracts';
import { TAG_CLAIM_NULL } from '../lib/zk/tags';
import { CLAIMS_TREE_DEPTH } from '../lib/zk/constants';

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

async function loadCircuitFileB64(assetModule: number): Promise<string> {
  const asset = Asset.fromModule(assetModule);
  await asset.downloadAsync();
  if (!asset.localUri) throw new Error('Failed to download circuit asset');
  return readAsStringAsync(asset.localUri, { encoding: EncodingType.Base64 });
}

export const ClaimService = {
  /**
   * 온체인에서 이미 클레임되었는지 확인
   */
  async isAlreadyClaimed(
    claimData: ClaimData,
    provider: ethers.JsonRpcProvider,
  ): Promise<boolean> {
    const settlementAddr = ConfigService.getPrivateSettlementAddress();
    if (!settlementAddr) return false;

    // nullifier = Poseidon(TAG_CLAIM_NULL, secret, leafIndex)
    const nullifier = await ZKBridgeService.computeNullifier(
      TAG_CLAIM_NULL.toString(),
      claimData.secret,
      claimData.leafIndex.toString(),
    );

    const settlement = new ethers.Contract(
      settlementAddr,
      PRIVATE_SETTLEMENT_ABI,
      provider,
    );

    const nullifierBytes32 = '0x' + BigInt(nullifier).toString(16).padStart(64, '0');
    return settlement.claimNullifiers(nullifierBytes32);
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

      const alreadyClaimed = await this.isAlreadyClaimed(claimData, readProvider);
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
      const treeResult = await buildClaimsTree(claimData.allLeaves);
      const { pathElements, pathIndices } = getMerkleProofFromTree(
        treeResult.layers,
        claimData.leafIndex,
      );

      // Compute nullifier
      const nullifier = await ZKBridgeService.computeNullifier(
        TAG_CLAIM_NULL.toString(),
        claimData.secret,
        claimData.leafIndex.toString(),
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

      // Format proof for Solidity
      const proof = {
        a: [proofResult.proof.pi_a[0], proofResult.proof.pi_a[1]] as [string, string],
        b: [
          [proofResult.proof.pi_b[0][1], proofResult.proof.pi_b[0][0]],
          [proofResult.proof.pi_b[1][1], proofResult.proof.pi_b[1][0]],
        ] as [[string, string], [string, string]],
        c: [proofResult.proof.pi_c[0], proofResult.proof.pi_c[1]] as [string, string],
      };

      // ─── Step 3: 온체인 제출 ───────────────────────────
      onProgress({ step: 'submitting' });

      const settlementAddr = ConfigService.getPrivateSettlementAddress();
      if (!settlementAddr) throw new Error('PrivateSettlement address not configured');

      // PrivateSettlement.claimWithProof(proof, claimsRoot, nullifier, recipient, token, amount, releaseTime)
      const settlement = new ethers.Contract(settlementAddr, [
        'function claimWithProof(uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC, bytes32 claimsRoot, bytes32 nullifier, address recipient, address token, uint256 amount, uint256 releaseTime) external',
      ], signer);

      const claimsRootBytes32 = '0x' + BigInt(treeResult.root).toString(16).padStart(64, '0');
      const nullifierBytes32 = '0x' + BigInt(nullifier).toString(16).padStart(64, '0');

      const tx = await settlement.claimWithProof(
        proof.a,
        proof.b,
        proof.c,
        claimsRootBytes32,
        nullifierBytes32,
        claimData.recipient,
        claimData.token,
        claimData.amount,
        claimData.releaseTime,
      );

      const receipt = await tx.wait();

      onProgress({ step: 'success', txHash: tx.hash });
      return tx.hash;
    } catch (err: any) {
      onProgress({ step: 'error', error: err?.message || 'Claim failed' });
      return null;
    }
  },
};

// ─── Helpers ───────────────────────────────────────────

async function buildClaimsTree(leaves: string[]): Promise<{
  root: string;
  layers: string[][];
}> {
  const padded = [...leaves];
  const size = 2 ** CLAIMS_TREE_DEPTH;
  while (padded.length < size) padded.push('0');

  const layers: string[][] = [padded];
  let current = padded;

  for (let d = 0; d < CLAIMS_TREE_DEPTH; d++) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const hash = await ZKBridgeService.poseidonHash([current[i], current[i + 1]]);
      next.push(hash);
    }
    layers.push(next);
    current = next;
  }

  return { root: current[0], layers };
}

function getMerkleProofFromTree(
  layers: string[][],
  leafIndex: number,
): { pathElements: string[]; pathIndices: string[] } {
  const pathElements: string[] = [];
  const pathIndices: string[] = [];
  let idx = leafIndex;

  for (let i = 0; i < layers.length - 1; i++) {
    const isRight = idx % 2;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    pathElements.push(layers[i][siblingIdx] ?? '0');
    pathIndices.push(isRight.toString());
    idx = Math.floor(idx / 2);
  }

  return { pathElements, pathIndices };
}
