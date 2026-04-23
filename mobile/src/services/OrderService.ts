/**
 * OrderService — 프라이빗 주문 생성 + 릴레이어 제출
 *
 * 플로우:
 * 1. 사용 가능한 노트 선택
 * 2. EdDSA 키 유도 (또는 캐시)
 * 3. Claims 구성 (수령 분배)
 * 4. Order hash 계산 + EdDSA 서명 (ZKBridgeService)
 * 5. 릴레이어에 주문 제출
 * 6. Change 노트 저장 (잔여 잔액)
 *
 * Authorize proof는 릴레이어가 생성 — 프론트엔드는 주문 데이터만 제출
 */
import { ethers } from 'ethers';
import { ZKBridgeService } from './ZKBridgeService';
import { EdDSAKeyService, EdDSAKeyPair } from './EdDSAKeyService';
import { NoteStorageService, StoredNote } from './NoteStorageService';
import { RelayerApiService } from './RelayerApiService';
import { PendingClaimsStorage } from './PendingClaimsStorage';
import { PendingOrdersService } from './PendingOrdersService';
import { TradeHistoryStorage } from './TradeHistoryStorage';
import { ProviderService } from './ProviderService';
import { KeySecurityService } from './KeySecurityService';
import { TokenService } from './TokenService';
import { ConfigService } from './ConfigService';
import { TAG_COMMITMENT_V2 } from '../lib/zk/tags';
import { generateRandomField } from '../lib/crypto';
import { buildPoseidonMerkleTree, getMerkleProofFromTree } from '../lib/merkleTree';
import { getCommitmentLeaves } from '../lib/commitmentScan';
import { loadCircuitFileB64 } from '../lib/circuitLoader';
import { formatProofForSolidity } from '../lib/proofFormat';

// authorize.circom tree depths (must match circuits/authorize.circom).
const COMMIT_TREE_DEPTH = 20;
const MAX_CLAIMS_PER_SIDE = 16;
const CLAIMS_TREE_DEPTH = 4;

/** Resolve a buy-token symbol for display. Cross-token trades look up the
 *  TokenService whitelist; scatter (same-token) falls back to the sell
 *  symbol when the lookup misses. The '?' fallback is intentional — it
 *  surfaces a token-list gap instead of silently mislabelling. */
function resolveBuySymbol(
  buyToken: string,
  sellToken: string,
  sellTokenSymbol: string,
): string {
  // Cache the lowercase form once: each .find() iteration would otherwise
  // re-lower buyToken; the same string is reused for the same-token check.
  const buyLower = buyToken.toLowerCase();
  const hit = TokenService.getTokenList().find(
    (t) => t.address === buyToken || t.address.toLowerCase() === buyLower,
  );
  if (hit) return hit.symbol;
  if (buyToken === sellToken || buyLower === sellToken.toLowerCase()) return sellTokenSymbol;
  return '?';
}

export type OrderStep =
  | 'idle'
  | 'deriving_key'
  | 'building_tree'
  | 'signing_order'
  | 'generating_proof'
  | 'submitting'
  | 'saving_change'
  | 'success'
  | 'error';

export interface OrderProgress {
  step: OrderStep;
  orderId?: string;
  error?: string;
}

export interface ClaimInput {
  recipient: string;   // Ethereum address (the stealth address itself when ephemeralPubKey is set)
  amount: string;      // human-readable
  releaseDelaySec: number; // seconds from now
  /** Set on stealth claims so the recipient can derive the stealth
   *  private key. Persisted with the pending claim alongside `secret`. */
  ephemeralPubKey?: string;
}

export interface OrderInput {
  note: StoredNote;          // 사용할 노트
  sellAmount: string;        // human-readable sell amount
  buyToken: string;          // buy token address
  buyAmount: string;         // human-readable buy amount
  maxFeeBps: number;         // max fee in basis points
  expiryHours: number;       // expiry in hours from now
  claims: ClaimInput[];      // claims 분배
  relayerUrl: string;        // 릴레이어 URL (필수 — 서명 정합성)
  relayerAddress: string;    // 릴레이어 주소 (필수 — circuit에서 해싱됨)
}

export const OrderService = {
  async execute(
    signer: ethers.Signer,
    account: string,
    input: OrderInput,
    onProgressIn: (progress: OrderProgress) => void,
  ): Promise<string | null> {
    // Diagnostic — mirrors `[DepositService]` style so a Metro tail can
    // trace which step a stuck submit died on. Remove once the
    // pending-orders integration is stable.
    const onProgress = (p: OrderProgress) => {
      console.log('[OrderService]', p.step, p.error ?? p.orderId ?? '');
      onProgressIn(p);
    };
    try {
      console.log('[OrderService] execute START', {
        account: account.slice(0, 10) + '…',
        sellAmount: input.sellAmount,
        buyToken: input.buyToken.slice(0, 10) + '…',
        relayerUrl: input.relayerUrl,
      });
      const { note, buyToken, maxFeeBps, expiryHours, claims } = input;
      // Per-transaction biometric gate. No-ops when the biometric
      // toggle is off; throws on user cancel so we never reach the
      // relayer submit step with a partially signed order.
      const authorized = await KeySecurityService.authorizeTransaction(
        `Limit order: sell ${input.sellAmount} ${note.tokenSymbol}`,
      );
      if (!authorized) throw new Error('Biometric authentication failed or was cancelled.');

      // Resolve sell/buy decimals dynamically — hardcoding 18 silently
      // misbuilds amounts for tokens like USDC (6).
      const readProvider = ProviderService.getReadProvider();
      const [sellDecimals, buyDecimals] = await Promise.all([
        TokenService.getDecimals(readProvider, note.token),
        TokenService.getDecimals(readProvider, buyToken),
      ]);
      const sellAmount = ethers.parseUnits(input.sellAmount, sellDecimals);
      const buyAmount = ethers.parseUnits(input.buyAmount, buyDecimals);

      // Use cryptographically random nonce to prevent collisions
      const nonceBytes = new Uint8Array(8);
      crypto.getRandomValues(nonceBytes);
      let nonce = 0n;
      for (const b of nonceBytes) nonce = (nonce << 8n) | BigInt(b);

      const expiry = BigInt(Math.floor(Date.now() / 1000) + expiryHours * 3600);

      // ─── Step 1: EdDSA 키 ─────────────────────────────
      onProgress({ step: 'deriving_key' });
      const keyPair = await EdDSAKeyService.getOrDeriveKey(signer, account);

      // ─── Step 2: Claims 구성 ──────────────────────────
      if (claims.length > 16) {
        throw new Error(`Too many claims: ${claims.length} (max 16)`);
      }
      const claimsData = claims.map((c) => ({
        secret: generateRandomField(),
        recipient: BigInt(c.recipient).toString(),
        token: BigInt(buyToken).toString(),
        amount: ethers.parseUnits(c.amount, buyDecimals).toString(),
        releaseTime: BigInt(Math.floor(Date.now() / 1000) + c.releaseDelaySec).toString(),
      }));

      // Claims root 계산 (Poseidon Merkle tree)
      const claimLeafHashes: string[] = [];
      for (const c of claimsData) {
        const hash = await ZKBridgeService.poseidonHash([
          c.secret, c.recipient, c.token, c.amount, c.releaseTime,
        ]);
        claimLeafHashes.push(hash);
      }
      // Pad to 16 leaves
      while (claimLeafHashes.length < 16) claimLeafHashes.push('0');

      // Build claims tree (depth 4)
      const { root: claimsRoot } = await buildPoseidonMerkleTree(claimLeafHashes, 4);

      // ─── Step 3: Order hash + EdDSA 서명 ──────────────
      onProgress({ step: 'signing_order' });

      // Relayer address is baked into the authorize circuit hash. A mismatch
      // between what we sign here and what the settling relayer uses will
      // make the EdDSA check fail on-chain, so require it up front.
      if (!input.relayerAddress || !ethers.isAddress(input.relayerAddress)) {
        throw new Error('relayerAddress is required and must be a valid address');
      }
      // Checksum-normalize so two callers that differ only in casing produce
      // the same orderHash (and the same `scatterdex_pending_claims` entry).
      const relayerChecksummed = ethers.getAddress(input.relayerAddress);
      const relayerAddress = BigInt(relayerChecksummed).toString();

      const orderHashInputs = [
        BigInt(note.token).toString(),     // sellToken
        BigInt(buyToken).toString(),        // buyToken
        sellAmount.toString(),              // sellAmount
        buyAmount.toString(),               // buyAmount
        maxFeeBps.toString(),               // maxFee
        expiry.toString(),                  // expiry
        nonce.toString(),                   // nonce
        claimsRoot,                         // claimsRoot
        relayerAddress,                     // relayerAddress
      ];

      const orderHash = await ZKBridgeService.hashOrder(orderHashInputs);

      // EdDSA sign
      const sig = await ZKBridgeService.signEdDSA(keyPair.privateKeyHex, orderHash);

      // ─── Step 4: Change commitment 계산 ────────────────
      const changeAmount = BigInt(note.amount) - sellAmount;
      if (changeAmount < 0n) throw new Error('Sell amount exceeds note balance');
      let newSalt = '0';
      let expectedChangeCommitment = '0';

      if (changeAmount > 0n) {
        newSalt = generateRandomField();
        expectedChangeCommitment = await ZKBridgeService.computeCommitment({
          tag: TAG_COMMITMENT_V2.toString(),
          secret: note.secret,
          token: BigInt(note.token).toString(),
          balance: changeAmount.toString(),
          salt: newSalt,
          pubKeyAx: keyPair.pubKeyAx,
          pubKeyAy: keyPair.pubKeyAy,
        });
      }

      // ─── Step 5: Merkle proof — fetch from relayer, fall back to local ─
      // Fast path: the relayer keeps the commitment tree in memory and
      // serves GET /api/info/merkle-proof?leafIndex=N with {root, pathElements,
      // pathIndices} directly usable as circuit inputs.
      //
      // Slow fallback: if the relayer is unreachable, rebuild the tree from
      // the shared checkpointed scanner (chunked queryFilter + persistent
      // AsyncStorage checkpoint) so we only fetch the delta since the last
      // session, never the full range from deploy on every order.
      onProgress({ step: 'building_tree' });
      const poolAddr = ConfigService.getCommitmentPoolAddress();
      if (!poolAddr) throw new Error('CommitmentPool address not configured');
      if (!ConfigService.getPrivateSettlementAddress()) {
        throw new Error('PrivateSettlement address not configured');
      }
      if (note.leafIndex < 0) {
        throw new Error('Note has no on-chain leaf index (pending commitment).');
      }

      let commitmentRoot: string;
      let pathElements: string[];
      let pathIndices: string[];

      console.log('[OrderService] building_tree → fetching relayer merkle proof', { leafIndex: note.leafIndex });
      const remote = await RelayerApiService.getMerkleProof(note.leafIndex, input.relayerUrl);
      console.log('[OrderService] relayer merkle proof', remote ? 'HIT' : 'MISS — falling back to local scan');
      if (remote) {
        commitmentRoot = remote.root;
        pathElements = remote.pathElements;
        pathIndices = remote.pathIndices.map(String);
      } else {
        console.log('[OrderService] scanning on-chain CommitmentInserted events…');
        const allLeaves = await getCommitmentLeaves(
          poolAddr,
          readProvider,
          ConfigService.getChainId(),
        );
        console.log('[OrderService] scan done, leaves =', allLeaves.length);

        // Only worth running the freshness check on this path since we
        // already paid for the full leaf set. Catches a stale note early
        // so the user doesn't wait for proof generation only to fail.
        const noteCommitment = await ZKBridgeService.computeCommitment({
          tag: TAG_COMMITMENT_V2.toString(),
          secret: note.secret,
          token: BigInt(note.token).toString(),
          balance: note.amount,
          salt: note.salt,
          pubKeyAx: keyPair.pubKeyAx,
          pubKeyAy: keyPair.pubKeyAy,
        });
        if (allLeaves[note.leafIndex] !== noteCommitment) {
          throw new Error(
            'Note commitment is no longer in the on-chain tree (spent or rotated).',
          );
        }

        const commitTree = await buildPoseidonMerkleTree(allLeaves, COMMIT_TREE_DEPTH);
        commitmentRoot = commitTree.root;
        const proof = getMerkleProofFromTree(commitTree, note.leafIndex);
        pathElements = proof.pathElements;
        pathIndices = proof.pathIndices;
        console.log('[OrderService] local tree built, root =', commitmentRoot.slice(0, 16) + '…');
      }

      // Nullifiers — tags 0 (escrow) / 1 (nonce) match cancel-prover and
      // MarketOrderService.
      const nullifier = await ZKBridgeService.computeNullifier(
        '0',
        note.secret,
        note.salt,
      );
      const nonceNullifier = await ZKBridgeService.computeNullifier(
        '1',
        note.secret,
        nonce.toString(),
      );

      // ─── Step 6: Assemble circuit witness ──────────────
      onProgress({ step: 'generating_proof' });
      const totalLocked = claimsData.reduce((a, c) => a + BigInt(c.amount), 0n);
      // Pad claim arrays to MAX_CLAIMS_PER_SIDE — circuit expects fixed
      // width; unused entries are zero and ignored via claimCount.
      const pad = (arr: string[]): string[] => [
        ...arr,
        ...Array(MAX_CLAIMS_PER_SIDE - arr.length).fill('0'),
      ];
      const claimSecrets = pad(claimsData.map((c) => c.secret));
      const claimRecipients = pad(claimsData.map((c) => c.recipient));
      const claimTokens = pad(claimsData.map((c) => c.token));
      const claimAmounts = pad(claimsData.map((c) => c.amount));
      const claimReleaseTimes = pad(claimsData.map((c) => c.releaseTime));

      const circuitInputs: Record<string, string | string[]> = {
        commitmentRoot,
        nullifier,
        nonceNullifier,
        newCommitment: expectedChangeCommitment,
        sellToken: BigInt(note.token).toString(),
        buyToken: BigInt(buyToken).toString(),
        sellAmount: sellAmount.toString(),
        buyAmount: buyAmount.toString(),
        maxFee: maxFeeBps.toString(),
        expiry: expiry.toString(),
        claimsRoot,
        totalLocked: totalLocked.toString(),
        relayer: relayerAddress,
        orderHash,
        secret: note.secret,
        balance: note.amount,
        salt: note.salt,
        path: pathElements,
        pathIdx: pathIndices,
        nonce: nonce.toString(),
        newSalt,
        pubKeyAx: keyPair.pubKeyAx,
        pubKeyAy: keyPair.pubKeyAy,
        sigS: sig.S,
        sigR8x: sig.R8x,
        sigR8y: sig.R8y,
        claimSecrets,
        claimRecipients,
        claimTokens,
        claimAmounts,
        claimReleaseTimes,
        claimCount: claimsData.length.toString(),
      };

      let wasmB64: string;
      let zkeyB64: string;
      try {
        wasmB64 = await loadCircuitFileB64(require('../../assets/zk/authorize.wasm'));
        zkeyB64 = await loadCircuitFileB64(require('../../assets/zk/authorize_final.zkey'));
      } catch {
        throw new Error('Authorize circuit files not found. Run npm run copy:circuits.');
      }

      const proofResult = await ZKBridgeService.generateProof(
        circuitInputs,
        wasmB64,
        zkeyB64,
      );
      const solidityProof = formatProofForSolidity(proofResult.proof);

      // ─── Step 7: Submit to /api/authorize-orders ──────
      onProgress({ step: 'submitting' });
      // publicSignals layout (authorize.circom outputs):
      //   [0]  pubKeyBind (circuit output)
      //   [1]  commitmentRoot
      //   [2]  nullifier
      //   [3]  nonceNullifier
      //   [4]  newCommitment
      //   [5]  sellToken
      //   [6]  buyToken
      //   [7]  sellAmount
      //   [8]  buyAmount
      //   [9]  maxFee
      //   [10] expiry
      //   [11] claimsRoot
      //   [12] totalLocked
      //   [13] relayer
      //   [14] orderHash
      const ps = proofResult.publicSignals;
      const namedSignals: Record<string, string> = {
        pubKeyBind: ps[0],
        commitmentRoot: ps[1],
        nullifier: ps[2],
        nonceNullifier: ps[3],
        newCommitment: ps[4],
        sellToken: ps[5],
        buyToken: ps[6],
        sellAmount: ps[7],
        buyAmount: ps[8],
        maxFee: ps[9],
        expiry: ps[10],
        claimsRoot: ps[11],
        totalLocked: ps[12],
        relayer: ps[13],
        orderHash: ps[14],
      };
      // Intentionally don't serialise the body just to log its length —
      // ZK proofs and publicSignals are large and RelayerApiService does
      // the real `JSON.stringify` for us on the very next line. Doubling
      // the work right before a network request added noticeable CPU /
      // memory pressure for no new signal.
      console.log('[OrderService] POST /api/authorize-orders', {
        relayerUrl: input.relayerUrl,
        nullifier: namedSignals.nullifier?.slice(0, 16) + '…',
      });
      const t0 = Date.now();
      const response = await RelayerApiService.submitAuthorizeOrder(
        {
          proof: solidityProof,
          publicSignals: namedSignals,
          publicSignalsArray: ps,
          pubKeyAx: keyPair.pubKeyAx,
          pubKeyAy: keyPair.pubKeyAy,
        },
        input.relayerUrl,
      );
      console.log('[OrderService] relayer response', response, `(${Date.now() - t0}ms)`);

      // ─── Step 6: Persist claim secrets + change note + mark spent ─
      onProgress({ step: 'saving_change' });

      // Without the claim secrets, the user cannot later produce the claim
      // proof and the settled funds become unrecoverable. Persist BEFORE we
      // mark the escrow note as spent so a write failure bubbles up instead
      // of leaving an orphaned spent-state with no way to claim.
      //
      // `claimsData.recipient` / `claimsData.token` are decimal field-element
      // strings (for the Poseidon hash), but ClaimService.execute passes the
      // persisted values straight into `claimWithProof(..., token, recipient,
      // ...)` which expect Solidity `address` — so persist the original
      // 0x-prefixed hex forms instead of the decimal strings.
      await PendingClaimsStorage.append(
        account,
        claims.map((c, idx) => ({
          secret: claimsData[idx].secret,
          recipient: c.recipient,
          token: buyToken,
          amount: claimsData[idx].amount,
          releaseTime: claimsData[idx].releaseTime,
          leafIndex: idx,
          allLeaves: claimLeafHashes,
          // Settle tx hash isn't known here — the relayer settles async.
          // Keep the orderId in its own field so display/dedup can tell
          // the two apart. When the relayer doesn't return an orderId we
          // omit the field entirely (rather than writing `''`): with
          // BackupService's `orderId || txHash` dedup key, `''` and
          // `undefined` actually behave identically — both fall back to
          // `txHash`. Collisions only become possible if BOTH identifiers
          // are missing, which shouldn't happen in practice.
          txHash: '',
          // Always persist an order identifier: relayer-returned orderId
          // when present, otherwise the local orderHash — so the Claim
          // detail view and BackupService dedup always have something
          // to key on.
          orderId: response.orderId || orderHash,
          // Carry the ephemeral pubkey through to storage on stealth
          // claims — the recipient needs it to derive their private key.
          ...(c.ephemeralPubKey ? { ephemeralPubKey: c.ephemeralPubKey } : {}),
        })),
      );

      // Mark original note as spent (in trading)
      await NoteStorageService.updateNoteStatus(account, note.id, 'spent');

      // Compute once and reuse for both the trade-history record and the
      // pending-order summary below. `resolveBuySymbol` walks the token
      // list, so calling it twice with identical inputs was wasteful.
      const buyTokenSymbol = resolveBuySymbol(buyToken, note.token, note.tokenSymbol);

      // Persist a per-order trade record so the History screen can
      // expand a spent note and show sell/change/claims details.
      await TradeHistoryStorage.append(account, {
        id: orderHash,
        sourceNoteId: note.id,
        changeNoteId: changeAmount > 0n ? expectedChangeCommitment : undefined,
        sellToken: note.token,
        sellTokenSymbol: note.tokenSymbol,
        buyToken,
        buyTokenSymbol,
        sellAmount: sellAmount.toString(),
        buyAmount: buyAmount.toString(),
        changeAmount: changeAmount.toString(),
        maxFeeBps,
        relayerAddress: input.relayerAddress,
        relayerUrl: input.relayerUrl,
        orderId: response.orderId,
        // Claim `secret` is stored only in PendingClaimsStorage (SecureStore)
        // — TradeHistoryStorage keeps display metadata in AsyncStorage which
        // is not encrypted, so leaking claim authority there would undermine
        // the privacy model.
        claims: claims.map((c, idx) => ({
          recipient: c.recipient,
          amount: claimsData[idx].amount,
          releaseTime: claimsData[idx].releaseTime,
          ...(c.ephemeralPubKey ? { ephemeralPubKey: c.ephemeralPubKey } : {}),
        })),
        createdAt: Date.now(),
      });

      // Save change note if applicable
      if (changeAmount > 0n) {
        const changeNote: StoredNote = {
          id: expectedChangeCommitment,
          commitment: expectedChangeCommitment,
          secret: note.secret,
          salt: newSalt,
          pubKeyAx: keyPair.pubKeyAx,
          pubKeyAy: keyPair.pubKeyAy,
          token: note.token,
          tokenSymbol: note.tokenSymbol,
          amount: changeAmount.toString(),
          leafIndex: -1, // updated after settlement
          txHash: '',
          status: 'pending',
          createdAt: Date.now(),
        };
        await NoteStorageService.saveNote(account, changeNote);
      }

      // Track in the async-settlement local queue so History can show the
      // settlement progression and a central poller drives the status
      // updates. The relayer now returns 202 with status='accepted' (or a
      // replayed-idempotent status); anything terminal will surface via
      // the poll loop within a few seconds.
      try {
        await PendingOrdersService.track({
          nullifier: namedSignals.nullifier,
          walletAddress: account,
          relayerUrl: input.relayerUrl,
          relayerResponseStatus: (response as any).status ?? 'accepted',
          attempt: (response as any).attempt ?? 0,
          summary: {
            sellToken: note.token,
            sellTokenSymbol: note.tokenSymbol,
            buyToken,
            buyTokenSymbol,
            sellAmount: sellAmount.toString(),
            buyAmount: buyAmount.toString(),
            maxFeeBps,
            orderHash,
          },
        });
      } catch (err) {
        // Failing to track locally shouldn't fail the submission — the
        // relayer already accepted the order, so History will catch up
        // on the next refetch even without the pending-orders entry.
        console.warn('[OrderService] PendingOrdersService.track failed:', err);
      }

      onProgress({ step: 'success', orderId: response.orderId });
      return response.orderId ?? null;
    } catch (err: any) {
      console.error('[OrderService] FAILED', {
        message: err?.message,
        name: err?.name,
        stack: err?.stack?.split('\n').slice(0, 5).join('\n'),
      });
      onProgress({ step: 'error', error: err?.message || 'Order failed' });
      return null;
    }
  },
};



