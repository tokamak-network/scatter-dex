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
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import { Asset } from 'expo-asset';
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
} from '../lib/contracts';
import { TAG_COMMITMENT_V2 } from '../lib/zk/tags';

export type DepositStep =
  | 'idle'
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

/**
 * Load a circuit file (wasm or zkey) as base64 for ZKBridgeService.
 * Files are bundled in assets/ and loaded via expo-asset.
 */
async function loadCircuitFileB64(assetModule: number): Promise<string> {
  const asset = Asset.fromModule(assetModule);
  await asset.downloadAsync();
  if (!asset.localUri) throw new Error('Failed to download circuit asset');
  const b64 = await readAsStringAsync(asset.localUri, {
    encoding: EncodingType.Base64,
  });
  return b64;
}

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

    const parsedAmount = ethers.parseUnits(amount, token.decimals);

    try {
      // ─── Step 1: EdDSA 키 유도 ─────────────────────────
      onProgress({ step: 'deriving_key' });
      const keyPair = await EdDSAKeyService.getOrDeriveKey(signer, account);

      // ─── Step 2: Commitment note 생성 ──────────────────
      // random secret + salt 생성 (ZKBridgeService를 통해 WebView에서 실행)
      const secret = generateRandomHex();
      const salt = generateRandomHex();

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

      // Format proof for Solidity (reverse G2 coords)
      const proof = {
        a: [proofResult.proof.pi_a[0], proofResult.proof.pi_a[1]] as [string, string],
        b: [
          [proofResult.proof.pi_b[0][1], proofResult.proof.pi_b[0][0]],
          [proofResult.proof.pi_b[1][1], proofResult.proof.pi_b[1][0]],
        ] as [[string, string], [string, string]],
        c: [proofResult.proof.pi_c[0], proofResult.proof.pi_c[1]] as [string, string],
      };

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

/**
 * Generate a random field element as decimal string.
 * Uses crypto.getRandomValues (polyfilled by react-native-get-random-values).
 */
function generateRandomHex(): string {
  const FIELD_MODULUS =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  let value: bigint;
  do {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    bytes[0] &= 0x1f; // cap to ~253 bits
    value = 0n;
    for (const b of bytes) {
      value = (value << 8n) | BigInt(b);
    }
  } while (value >= FIELD_MODULUS);
  return value.toString();
}
