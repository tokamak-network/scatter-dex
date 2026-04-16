/**
 * DepositService — 프라이빗 입금 전체 플로우
 *
 * 1. EdDSA 키 유도 (또는 캐시 로드)
 * 2. Commitment note 생성 (random secret + salt, pubkey binding)
 * 3. 토큰 approve (ETH → wrap WETH + approve, ERC20 → approve)
 * 4. ZK deposit proof 생성 (ZKBridgeService → WebView)
 * 5. CommitmentPool.deposit() 온체인 호출
 * 6. CommitmentInserted 이벤트에서 leafIndex 파싱
 * 7. 노트 저장 (NoteStorageService)
 */
import { ethers } from 'ethers';
import { ZKBridgeService } from './ZKBridgeService';
import { EdDSAKeyService, EdDSAKeyPair } from './EdDSAKeyService';
import { NoteStorageService, StoredNote } from './NoteStorageService';
import { ConfigService } from './ConfigService';
import { ProviderService } from './ProviderService';
import { TokenInfo } from './TokenService';
import {
  COMMITMENT_POOL_ABI,
  COMMITMENT_POOL_IFACE,
  ERC20_ABI,
  SANCTIONS_LIST_ABI,
} from '../lib/contracts';
import { TAG_COMMITMENT_V2 } from '../lib/zk/tags';
import { generateRandomField } from '../lib/crypto';
import { loadCircuitFileB64 } from '../lib/circuitLoader';
import { formatProofForSolidity } from '../lib/proofFormat';

export type DepositStep =
  | 'idle'
  | 'checking'
  | 'deriving_key'
  | 'approving'
  | 'generating_proof'
  | 'depositing'
  | 'saving_note'
  | 'success'
  | 'error';

export interface DepositProgress {
  step: DepositStep;
  txHash?: string;
  error?: string;
}

// WETH ABI for wrapping ETH
const WETH_ABI = [
  'function deposit() external payable',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
];


export const DepositService = {
  /**
   * 전체 deposit 플로우 실행
   */
  async execute(
    signer: ethers.Signer,
    account: string,
    token: TokenInfo,
    amount: string, // human-readable (e.g., "1.5")
    onProgress: (progress: DepositProgress) => void,
  ): Promise<StoredNote | null> {
    const poolAddress = ConfigService.getCommitmentPoolAddress();
    const wethAddress = ConfigService.getWethAddress();
    if (!poolAddress) throw new Error('CommitmentPool address not configured');
    if (token.isNative && !wethAddress) throw new Error('WETH address not configured for native token deposit');

    const parsedAmount = ethers.parseUnits(amount, token.decimals);

    try {
      onProgress({ step: 'checking' });
      const sanctionsAddr = await ProviderService.getSanctionsListAddress();
      if (sanctionsAddr && sanctionsAddr !== ethers.ZeroAddress) {
        const readProvider = ProviderService.getReadProvider();
        const sanctions = new ethers.Contract(sanctionsAddr, SANCTIONS_LIST_ABI, readProvider);
        if (await sanctions.isSanctioned(account)) {
          throw new Error('Your address is on the sanctions list and cannot deposit.');
        }
      }

      // ─── Step 1: EdDSA 키 유도 ─────────────────────────
      onProgress({ step: 'deriving_key' });
      const keyPair = await EdDSAKeyService.getOrDeriveKey(signer, account);

      // ─── Step 2: Commitment note 생성 ──────────────────
      // random secret + salt 생성 (ZKBridgeService를 통해 WebView에서 실행)
      const secret = generateRandomField();
      const salt = generateRandomField();

      // commitment = Poseidon(TAG_V2, secret, token, amount, salt, pubKeyAx, pubKeyAy)
      const commitment = await ZKBridgeService.computeCommitment({
        tag: TAG_COMMITMENT_V2.toString(),
        secret,
        token: BigInt(token.address).toString(),
        balance: parsedAmount.toString(),
        salt,
        pubKeyAx: keyPair.pubKeyAx,
        pubKeyAy: keyPair.pubKeyAy,
      });

      // ─── Step 3: 토큰 approve ─────────────────────────
      onProgress({ step: 'approving' });
      const commitTokenAddr = token.isNative ? wethAddress : token.address;

      if (token.isNative && wethAddress) {
        // ETH → WETH wrap
        const weth = new ethers.Contract(wethAddress, WETH_ABI, signer);
        const wrapTx = await weth.deposit({ value: parsedAmount });
        await wrapTx.wait();

        // approve
        const allowance = await weth.allowance(account, poolAddress);
        if (allowance < parsedAmount) {
          const approveTx = await weth.approve(poolAddress, ethers.MaxUint256);
          await approveTx.wait();
        }
      } else {
        // ERC20 approve
        const erc20 = new ethers.Contract(token.address, ERC20_ABI, signer);
        const allowance = await erc20.allowance(account, poolAddress);
        if (allowance < parsedAmount) {
          const approveTx = await erc20.approve(poolAddress, ethers.MaxUint256);
          await approveTx.wait();
        }
      }

      // ─── Step 4: ZK deposit proof 생성 ─────────────────
      onProgress({ step: 'generating_proof' });

      const circuitInputs = {
        commitment,
        token: BigInt(commitTokenAddr!).toString(),
        amount: parsedAmount.toString(),
        secret,
        salt,
        pubKeyAx: keyPair.pubKeyAx,
        pubKeyAy: keyPair.pubKeyAy,
      };

      // Load circuit files as base64
      // Note: these require() calls must match actual asset files
      // TODO: deposit.wasm and deposit_final.zkey must be placed in assets/zk/
      let wasmB64: string;
      let zkeyB64: string;
      try {
        wasmB64 = await loadCircuitFileB64(
          require('../../assets/zk/deposit.wasm'),
        );
        zkeyB64 = await loadCircuitFileB64(
          require('../../assets/zk/deposit_final.zkey'),
        );
      } catch {
        throw new Error(
          'Deposit circuit files not found. Run the build script to place deposit.wasm and deposit_final.zkey in assets/zk/',
        );
      }

      const proofResult = await ZKBridgeService.generateProof(
        circuitInputs,
        wasmB64,
        zkeyB64,
      );

      const proof = formatProofForSolidity(proofResult.proof);

      // ─── Step 5: CommitmentPool.deposit() ──────────────
      onProgress({ step: 'depositing' });

      const pool = new ethers.Contract(poolAddress, COMMITMENT_POOL_ABI, signer);
      const tx = await pool.deposit(
        proof.a,
        proof.b,
        proof.c,
        commitment,
        commitTokenAddr,
        parsedAmount,
      );
      const receipt = await tx.wait();

      onProgress({ step: 'depositing', txHash: tx.hash });

      // ─── Step 6: leafIndex 파싱 ────────────────────────
      let leafIndex = -1;
      for (const log of receipt.logs) {
        try {
          const parsed = COMMITMENT_POOL_IFACE.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          if (parsed?.name === 'CommitmentInserted') {
            leafIndex = Number(parsed.args.leafIndex);
            break;
          }
        } catch { /* not our event */ }
      }

      // Cache earliest block
      if (receipt.blockNumber) {
        await ProviderService.cacheEarliestBlock(receipt.blockNumber);
      }

      // ─── Step 7: 노트 저장 ────────────────────────────
      onProgress({ step: 'saving_note' });

      const storedNote: StoredNote = {
        id: commitment,
        commitment,
        secret,
        salt,
        pubKeyAx: keyPair.pubKeyAx,
        pubKeyAy: keyPair.pubKeyAy,
        token: commitTokenAddr!,
        tokenSymbol: token.isNative ? 'WETH' : token.symbol,
        amount: parsedAmount.toString(),
        leafIndex,
        txHash: tx.hash,
        status: 'active',
        createdAt: Date.now(),
      };

      await NoteStorageService.saveNote(storedNote);

      onProgress({ step: 'success', txHash: tx.hash });
      return storedNote;
    } catch (err: any) {
      onProgress({ step: 'error', error: err?.message || 'Deposit failed' });
      return null;
    }
  },
};

