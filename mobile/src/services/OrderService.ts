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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ZKBridgeService } from './ZKBridgeService';
import { EdDSAKeyService, EdDSAKeyPair } from './EdDSAKeyService';
import { NoteStorageService, StoredNote } from './NoteStorageService';
import { RelayerApiService, PrivateOrderRequest } from './RelayerApiService';
import { ConfigService } from './ConfigService';
import { TAG_COMMITMENT_V2 } from '../lib/zk/tags';
import { generateRandomField } from '../lib/crypto';
import { buildPoseidonMerkleTree } from '../lib/merkleTree';

const PENDING_CLAIMS_KEY = 'scatterdex_pending_claims';

export type OrderStep =
  | 'idle'
  | 'deriving_key'
  | 'signing_order'
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
  recipient: string;   // Ethereum address
  amount: string;      // human-readable
  releaseDelaySec: number; // seconds from now
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
    onProgress: (progress: OrderProgress) => void,
  ): Promise<string | null> {
    try {
      const { note, buyToken, maxFeeBps, expiryHours, claims } = input;
      const sellAmount = ethers.parseUnits(input.sellAmount, 18);
      const buyAmount = ethers.parseUnits(input.buyAmount, 18);

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
        amount: ethers.parseUnits(c.amount, 18).toString(),
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
      const relayerAddress = BigInt(input.relayerAddress).toString();

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

      // ─── Step 5: 릴레이어 제출 ─────────────────────────
      onProgress({ step: 'submitting' });

      const orderReq: PrivateOrderRequest = {
        sellToken: note.token,
        buyToken,
        sellAmount: sellAmount.toString(),
        buyAmount: buyAmount.toString(),
        maxFee: maxFeeBps.toString(),
        expiry: expiry.toString(),
        nonce: nonce.toString(),
        pubKeyAx: keyPair.pubKeyAx,
        pubKeyAy: keyPair.pubKeyAy,
        sigS: sig.S,
        sigR8x: sig.R8x,
        sigR8y: sig.R8y,
        ownerSecret: note.secret,
        balance: note.amount,
        salt: note.salt,
        leafIndex: note.leafIndex,
        newSalt,
        expectedChangeCommitment,
        claims: claimsData,
      };

      const response = await RelayerApiService.submitPrivateOrder(
        orderReq,
        input.relayerUrl,
      );

      if (response.status === 'rejected') {
        throw new Error(response.reason || 'Order rejected by relayer');
      }

      // ─── Step 6: Persist claim secrets + change note + mark spent ─
      onProgress({ step: 'saving_change' });

      // Without the claim secrets, the user cannot later produce the claim
      // proof and the settled funds become unrecoverable. Persist them
      // alongside everything the ClaimScreen needs to build the Merkle proof.
      await persistPendingClaims(claimsData, claimLeafHashes, response.orderId);

      // Mark original note as spent (in trading)
      await NoteStorageService.updateNoteStatus(note.id, 'spent');

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
        await NoteStorageService.saveNote(changeNote);
      }

      onProgress({ step: 'success', orderId: response.orderId });
      return response.orderId;
    } catch (err: any) {
      onProgress({ step: 'error', error: err?.message || 'Order failed' });
      return null;
    }
  },
};

type ClaimLeafData = {
  secret: string;
  recipient: string;
  token: string;
  amount: string;
  releaseTime: string;
};

async function persistPendingClaims(
  claims: ClaimLeafData[],
  paddedLeafHashes: string[],
  orderId: string | undefined,
): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_CLAIMS_KEY);
    const existing: unknown[] = raw ? JSON.parse(raw) : [];
    const next = [
      ...existing,
      ...claims.map((c, idx) => ({
        secret: c.secret,
        recipient: c.recipient,
        token: c.token,
        amount: c.amount,
        releaseTime: c.releaseTime,
        leafIndex: idx,
        allLeaves: paddedLeafHashes,
        txHash: orderId || '',
      })),
    ];
    await AsyncStorage.setItem(PENDING_CLAIMS_KEY, JSON.stringify(next));
  } catch (err) {
    // Persistence is best-effort; surface via console so debugging is possible
    // but don't throw — the order already succeeded on the relayer side.
    console.error('Failed to persist pending claims:', err);
  }
}


