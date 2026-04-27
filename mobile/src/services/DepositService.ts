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
import { KeySecurityService } from './KeySecurityService';
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
import { generateNativeProof, SnarkjsLikeProofResult } from './NativeProverService';
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
  'function balanceOf(address owner) external view returns (uint256)',
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
    const chainId = ConfigService.getChainId();
    if (!poolAddress) throw new Error('CommitmentPool address not configured');
    if (token.isNative && !wethAddress) throw new Error('WETH address not configured for native token deposit');

    const parsedAmount = ethers.parseUnits(amount, token.decimals);
    console.log('[DepositService] starting', {
      chainId,
      poolAddress,
      wethAddress,
      tokenSymbol: token.symbol,
      tokenIsNative: token.isNative,
      tokenAddress: token.address,
      amount,
      parsedAmount: parsedAmount.toString(),
      account,
    });

    try {
      // Per-transaction biometric gate. Prompts with the operation
      // description so the OS dialog is meaningful; returns true when
      // the biometric toggle is off. Throws on user cancel so the flow
      // aborts before any on-chain side effects (approve/wrap).
      const authorized = await KeySecurityService.authorizeTransaction(
        `Deposit ${amount} ${token.symbol}`,
      );
      if (!authorized) throw new Error('Biometric authentication failed or was cancelled.');

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
        const weth = new ethers.Contract(wethAddress, WETH_ABI, signer);

        // Only wrap the shortfall — a previous deposit attempt that
        // reverted at the pool step leaves WETH in the user's wallet.
        // Wrapping another full `parsedAmount` would double-spend ETH
        // on every retry until the pool accepts the proof.
        const wethBalRaw = await weth.balanceOf(account);
        const wethBal: bigint = wethBalRaw; // ethers v6 returns bigint
        if (wethBal < parsedAmount) {
          const shortfall = parsedAmount - wethBal;
          const wrapTx = await weth.deposit({ value: shortfall });
          await wrapTx.wait();
        }

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

      // Native proof first (mopro-ffi / arkworks). Falls through to
      // WebView (snarkjs in HiddenWebView) only when the FFI throws —
      // Expo Go runs and missing arm64 jniLib both end up there.
      let proofResult: SnarkjsLikeProofResult;
      const proofStart = Date.now();
      try {
        console.log('[DepositService] generateProof native dispatch');
        proofResult = await generateNativeProof('deposit', circuitInputs);
        console.log('[DepositService] generateProof native returned', { ms: Date.now() - proofStart });
      } catch (e) {
        // ethers / mopro errors set `shortMessage` / `reason` before
        // `message` — pull those first so the warn is a one-liner
        // even when the underlying error has a giant stack.
        const errAny = e as { shortMessage?: string; reason?: string; message?: string };
        const msg = errAny?.shortMessage ?? errAny?.reason ?? errAny?.message ?? String(e);
        console.warn(`[DepositService] native proof unavailable (${msg}), falling back to WebView:`, e);
        let wasmB64: string;
        let zkeyB64: string;
        try {
          const wasmStart = Date.now();
          wasmB64 = await loadCircuitFileB64(require('../../assets/zk/deposit.wasm'));
          console.log('[DepositService] wasm loaded', { ms: Date.now() - wasmStart, kb: Math.round(wasmB64.length / 1024) });
          const zkeyStart = Date.now();
          zkeyB64 = await loadCircuitFileB64(require('../../assets/zk/deposit_final.zkey'));
          console.log('[DepositService] zkey loaded', { ms: Date.now() - zkeyStart, kb: Math.round(zkeyB64.length / 1024) });
        } catch (loadError) {
          const loadErrAny = loadError as { shortMessage?: string; reason?: string; message?: string };
          const loadMsg = loadErrAny?.shortMessage ?? loadErrAny?.reason ?? loadErrAny?.message ?? String(loadError);
          console.error('[DepositService] failed to load deposit circuit assets for WebView fallback:', loadError);
          throw new Error(
            `Deposit circuit files could not be loaded from assets/zk/ (underlying error: ${loadMsg}). ` +
              'Ensure the deposit circuit assets are present and try running `npm run copy:circuits`.',
          );
        }
        const fallbackStart = Date.now();
        console.log('[DepositService] generateProof WebView dispatch');
        proofResult = await ZKBridgeService.generateProof(circuitInputs, wasmB64, zkeyB64);
        console.log('[DepositService] generateProof WebView returned', { ms: Date.now() - fallbackStart });
      }

      const proof = formatProofForSolidity(proofResult.proof);
      console.log('[DepositService] proof generated', {
        commitment: commitment.toString(),
        commitTokenAddr,
        parsedAmount: parsedAmount.toString(),
      });

      // ─── Step 5: CommitmentPool.deposit() ──────────────
      onProgress({ step: 'depositing' });

      const pool = new ethers.Contract(poolAddress, COMMITMENT_POOL_ABI, signer);

      // Match the frontend — skip the pre-flight staticCall. On anvil fork
      // setups (archive-limited RPCs like publicnode), eth_call touching
      // the BN254 precompiles fails with "historical state is not
      // available" even when the actual send executes cleanly, so the
      // simulation is net-harmful. If the real send reverts, the catch
      // below extracts whatever reason the node returns.
      let tx: ethers.TransactionResponse;
      try {
        tx = await pool.deposit(
          proof.a,
          proof.b,
          proof.c,
          commitment,
          commitTokenAddr,
          parsedAmount,
        );
      } catch (sendErr: any) {
        const reason = sendErr?.reason
          || sendErr?.shortMessage
          || sendErr?.info?.error?.message
          || sendErr?.data
          || sendErr?.message
          || 'deposit rejected (no reason returned)';
        console.log('[DepositService] deposit send error:', reason, sendErr);
        throw new Error(`CommitmentPool.deposit failed: ${reason}`);
      }
      const receipt = await tx.wait();
      if (!receipt || receipt.status === 0) {
        throw new Error('CommitmentPool.deposit reverted on-chain (receipt.status=0)');
      }

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

      // If we couldn't parse a CommitmentInserted event out of the
      // receipt, `leafIndex` stays at the -1 sentinel. Saving such a
      // note as `active` would make it unprovable (trade/cancel flows
      // index `allLeaves[note.leafIndex]` against the live tree), so
      // persist it as `pending` instead. A later index-backfill path
      // can promote it to `active` once the leaf position is known.
      const status: StoredNote['status'] = leafIndex >= 0 ? 'active' : 'pending';

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
        status,
        createdAt: Date.now(),
      };

      await NoteStorageService.saveNote(account, storedNote);

      onProgress({ step: 'success', txHash: tx.hash });
      return storedNote;
    } catch (err: any) {
      onProgress({ step: 'error', error: err?.message || 'Deposit failed' });
      return null;
    }
  },
};

