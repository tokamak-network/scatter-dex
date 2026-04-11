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

const circuitCache = new Map<number, string>();

async function loadCircuitFileB64(assetModule: number): Promise<string> {
  const cached = circuitCache.get(assetModule);
  if (cached) return cached;

  const asset = Asset.fromModule(assetModule);
  await asset.downloadAsync();
  if (!asset.localUri) throw new Error('Failed to download circuit asset');
  const b64 = await readAsStringAsync(asset.localUri, { encoding: EncodingType.Base64 });
  circuitCache.set(assetModule, b64);
  return b64;
}

function toBytes32Hex(value: string): string {
  return '0x' + BigInt(value).toString(16).padStart(64, '0');
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
      const treeResult = await buildClaimsTree(claimData.allLeaves);
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
