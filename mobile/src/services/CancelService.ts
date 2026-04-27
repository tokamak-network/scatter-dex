/**
 * CancelService — escrow rotation cancel for a pending private order.
 *
 * Mirrors frontend/app/lib/zk/cancel-prover.ts and the HistoryScreen cancel
 * flow at frontend/app/trade/private-history/page.tsx:207-322. After the
 * on-chain `cancelPrivate` mines:
 *   - the old commitment is dead (escrow nullifier burnt)
 *   - the authorize order can no longer settle (nonce nullifier burnt)
 *   - the user holds a fresh escrow with the same balance and a new salt
 *   - relayers see `PrivateCancel` and prune the order from their book
 */
import { ethers } from 'ethers';
import { ZKBridgeService } from './ZKBridgeService';
import { EdDSAKeyService } from './EdDSAKeyService';
import { NoteStorageService, StoredNote } from './NoteStorageService';
import { ConfigService } from './ConfigService';
import { ProviderService } from './ProviderService';
import { KeySecurityService } from './KeySecurityService';
import { PRIVATE_SETTLEMENT_ABI, COMMITMENT_POOL_ABI } from '../lib/contracts';
import { getCommitmentLeaves } from '../lib/commitmentScan';
import { TAG_COMMITMENT_V2, TAG_ESCROW_NULL, TAG_NONCE_NULL } from '../lib/zk/tags';
import { generateRandomField } from '../lib/crypto';
import { loadCircuitFileB64 } from '../lib/circuitLoader';
import { formatProofForSolidity } from '../lib/proofFormat';
import { buildPoseidonMerkleTree, getMerkleProofFromTree } from '../lib/merkleTree';
import { toBytes32Hex } from '../lib/format';

export type CancelStep =
  | 'idle'
  | 'preparing'
  | 'building_tree'
  | 'generating_proof'
  | 'submitting'
  | 'rotating_note'
  | 'success'
  | 'error';

export interface CancelProgress {
  step: CancelStep;
  txHash?: string;
  error?: string;
}

export interface CancelInput {
  /** The escrow note backing the order (must be in `pending` status). */
  note: StoredNote;
  /** The nonce the order was submitted with. Needed to burn the right
   *  nonce-nullifier; obtained from the relayer's order record. */
  nonce: string;
}

const COMMIT_TREE_DEPTH = 20;

export const CancelService = {
  async execute(
    signer: ethers.Signer,
    account: string,
    input: CancelInput,
    onProgress: (p: CancelProgress) => void,
  ): Promise<string | null> {
    try {
      const settlementAddr = ConfigService.getPrivateSettlementAddress();
      if (!settlementAddr) throw new Error('PrivateSettlement address not configured');
      const poolAddr = ConfigService.getCommitmentPoolAddress();
      if (!poolAddr) throw new Error('CommitmentPool address not configured');

      // Per-transaction biometric gate. No-ops when the biometric
      // toggle is off; throws on user cancel.
      const authorized = await KeySecurityService.authorizeTransaction(
        `Cancel order for ${input.note.tokenSymbol}`,
      );
      if (!authorized) throw new Error('Biometric authentication failed or was cancelled.');

      onProgress({ step: 'preparing' });

      const { note } = input;
      const keyPair = await EdDSAKeyService.getOrDeriveKey(signer, account);

      onProgress({ step: 'building_tree' });
      const readProvider = ProviderService.getReadProvider();
      // Pool contract instance kept locally for tx-receipt log parsing
      // further down. Leaves themselves come from the shared checkpointed
      // scanner — chunked queryFilter + persistent (chainId, pool) state
      // so we only pull the delta since the previous session instead of
      // rescanning from deploy on every cancel.
      const pool = new ethers.Contract(poolAddr, COMMITMENT_POOL_ABI, readProvider);
      const allLeaves = await getCommitmentLeaves(
        poolAddr,
        readProvider,
        ConfigService.getChainId(),
      );

      // Verify the stored note's leaf is what the pool actually has.
      const noteCommitment = await ZKBridgeService.computeCommitment({
        tag: TAG_COMMITMENT_V2.toString(),
        secret: note.secret,
        token: BigInt(note.token).toString(),
        balance: note.amount,
        salt: note.salt,
        pubKeyAx: keyPair.pubKeyAx,
        pubKeyAy: keyPair.pubKeyAy,
      });
      if (note.leafIndex < 0 || allLeaves[note.leafIndex] !== noteCommitment) {
        throw new Error('Note commitment is no longer in the on-chain tree. It may already be spent or rotated.');
      }

      const tree = await buildPoseidonMerkleTree(allLeaves, COMMIT_TREE_DEPTH);
      const commitmentRoot = tree.root;
      // Pass the tree (not just layers) so the proof extractor can substitute
      // zeroHashes for siblings in the zero region — sparse trees no longer
      // carry full-width layers.
      const { pathElements, pathIndices } = getMerkleProofFromTree(tree, note.leafIndex);

      const oldNullifier = await ZKBridgeService.computeNullifier(
        TAG_ESCROW_NULL.toString(),
        note.secret,
        note.salt,
      );
      const oldNonceNullifier = await ZKBridgeService.computeNullifier(
        TAG_NONCE_NULL.toString(),
        note.secret,
        input.nonce,
      );

      // Roll until newCommitment != 0 and freshSalt != old salt, matching
      // cancel-prover.ts:132-146. Poseidon-0 is astronomically unlikely but
      // would brick the balance on-chain. Bounded so a broken ZK bridge
      // (always returning '0') cannot hang the UI forever.
      const MAX_SALT_ATTEMPTS = 8;
      let freshSalt = '0';
      let newCommitment = '0';
      for (let attempt = 0; attempt < MAX_SALT_ATTEMPTS && newCommitment === '0'; attempt++) {
        const cand = generateRandomField();
        if (cand === note.salt) continue;
        freshSalt = cand;
        newCommitment = await ZKBridgeService.computeCommitment({
          tag: TAG_COMMITMENT_V2.toString(),
          secret: note.secret,
          token: BigInt(note.token).toString(),
          balance: note.amount,
          salt: freshSalt,
          pubKeyAx: keyPair.pubKeyAx,
          pubKeyAy: keyPair.pubKeyAy,
        });
      }
      if (newCommitment === '0') {
        throw new Error('Failed to compute a non-zero rotated commitment — ZK bridge may be unhealthy.');
      }

      // Cancel message = Poseidon(oldNonceNullifier, submitter).
      // On-chain cancelPrivate binds submitter == msg.sender, so we sign with
      // the user's address — the tx comes from the user, not a relayer. Note
      // the circuit declares the public signal as `submitter`, not `relayer`
      // (see circuits/cancel.circom:88,217).
      const submitter = BigInt(account).toString();
      const cancelMsg = await ZKBridgeService.poseidonHash([oldNonceNullifier, submitter]);
      const sig = await ZKBridgeService.signEdDSA(keyPair.privateKeyHex, cancelMsg);

      onProgress({ step: 'generating_proof' });
      console.log('[CancelService] generating_proof start', {
        leafIndex: note.leafIndex,
        oldNullifier: oldNullifier.slice(0, 16) + '…',
        oldNonceNullifier: oldNonceNullifier.slice(0, 16) + '…',
        newCommitment: newCommitment.slice(0, 16) + '…',
      });
      const circuitInputs: Record<string, string | string[]> = {
        commitmentRoot,
        oldNullifier,
        oldNonceNullifier,
        newCommitment,
        submitter,
        secret: note.secret,
        salt: note.salt,
        nonce: input.nonce,
        token: BigInt(note.token).toString(),
        balance: note.amount,
        freshSalt,
        path: pathElements,
        pathIdx: pathIndices,
        pubKeyAx: keyPair.pubKeyAx,
        pubKeyAy: keyPair.pubKeyAy,
        sigS: sig.S,
        sigR8x: sig.R8x,
        sigR8y: sig.R8y,
      };

      let wasmB64: string;
      let zkeyB64: string;
      try {
        const wasmStart = Date.now();
        wasmB64 = await loadCircuitFileB64(require('../../assets/zk/cancel.wasm'));
        console.log('[CancelService] wasm loaded', { ms: Date.now() - wasmStart, kb: Math.round(wasmB64.length / 1024) });
        const zkeyStart = Date.now();
        zkeyB64 = await loadCircuitFileB64(require('../../assets/zk/cancel_final.zkey'));
        console.log('[CancelService] zkey loaded', { ms: Date.now() - zkeyStart, kb: Math.round(zkeyB64.length / 1024) });
      } catch (e) {
        console.error('[CancelService] circuit asset load failed', e);
        throw new Error('Cancel circuit files not found. Run `npm run copy:circuits` after building the circuits.');
      }

      const proofStart = Date.now();
      console.log('[CancelService] generateProof call dispatching to WebView');
      const proofResult = await ZKBridgeService.generateProof(circuitInputs, wasmB64, zkeyB64);
      console.log('[CancelService] generateProof returned', { ms: Date.now() - proofStart });
      const proof = formatProofForSolidity(proofResult.proof);

      onProgress({ step: 'submitting' });
      // publicSignals layout (circuits/cancel.circom:212-218):
      //   [0] commitmentRoot [1] oldNullifier [2] oldNonceNullifier
      //   [3] newCommitment  [4] submitter
      const ps = proofResult.publicSignals;
      const settlement = new ethers.Contract(settlementAddr, PRIVATE_SETTLEMENT_ABI, signer);
      console.log('[CancelService] submitting cancelPrivate', { settlementAddr, signals: ps.map((v) => String(v).slice(0, 12)) });
      const tx = await settlement.cancelPrivate({
        proofA: proof.a,
        proofB: proof.b,
        proofC: proof.c,
        commitmentRoot: ps[0],
        oldNullifier: toBytes32Hex(ps[1]),
        oldNonceNullifier: toBytes32Hex(ps[2]),
        newCommitment: toBytes32Hex(ps[3]),
      });
      console.log('[CancelService] cancelPrivate tx sent', { hash: tx.hash });
      const receipt = await tx.wait();
      console.log('[CancelService] cancelPrivate tx mined', { blockNumber: receipt?.blockNumber });

      onProgress({ step: 'rotating_note' });
      // If the event isn't present (RPC lag, wrong filter), -1 lets a later
      // sync repair the leafIndex rather than block the rotation.
      let newLeafIndex = -1;
      for (const log of receipt?.logs || []) {
        try {
          const parsed = pool.interface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === 'CommitmentInserted' && parsed.args.commitment.toString() === newCommitment) {
            newLeafIndex = Number(parsed.args.leafIndex);
            break;
          }
        } catch { /* not this event */ }
      }

      // Mark old note as spent (rotated) and persist the rotated one as active.
      await NoteStorageService.updateNoteStatus(account, note.id, 'spent');
      const rotated: StoredNote = {
        id: newCommitment,
        commitment: newCommitment,
        secret: note.secret,
        salt: freshSalt,
        pubKeyAx: keyPair.pubKeyAx,
        pubKeyAy: keyPair.pubKeyAy,
        token: note.token,
        tokenSymbol: note.tokenSymbol,
        amount: note.amount,
        leafIndex: newLeafIndex,
        txHash: tx.hash,
        status: 'active',
        createdAt: Date.now(),
      };
      await NoteStorageService.saveNote(account, rotated);

      onProgress({ step: 'success', txHash: tx.hash });
      return tx.hash;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Cancel failed';
      console.error('[CancelService] failed', { message, raw: err });
      onProgress({ step: 'error', error: message });
      return null;
    }
  },
};
