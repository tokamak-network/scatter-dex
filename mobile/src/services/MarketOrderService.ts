/**
 * MarketOrderService — 시장가 주문 (settleWithDex)
 *
 * 사용자가 직접 DEX를 통해 swap하는 시장가 거래.
 * 릴레이어 없이 사용자가 직접 온체인 제출.
 *
 * 1. EdDSA 키 유도
 * 2. Authorize proof 생성 (maxFee=0, relayer=self)
 * 3. DEX calldata 인코딩 (Uniswap V3 exactInputSingle)
 * 4. settleWithDex() 온체인 호출
 * 5. Change 노트 저장 + claim 파일 생성
 */
import { ethers } from 'ethers';
import { ZKBridgeService } from './ZKBridgeService';
import { EdDSAKeyService } from './EdDSAKeyService';
import { NoteStorageService, StoredNote } from './NoteStorageService';
import { ConfigService } from './ConfigService';
import { ProviderService } from './ProviderService';
import { TokenService } from './TokenService';
import { PRIVATE_SETTLEMENT_ABI, COMMITMENT_POOL_ABI } from '../lib/contracts';
import { TAG_COMMITMENT_V2 } from '../lib/zk/tags';
import { generateRandomField } from '../lib/crypto';
import { loadCircuitFileB64 } from '../lib/circuitLoader';
import { formatProofForSolidity } from '../lib/proofFormat';
import { buildPoseidonMerkleTree } from '../lib/merkleTree';

export type MarketOrderStep =
  | 'idle'
  | 'checking'
  | 'generating_proof'
  | 'submitting'
  | 'saving'
  | 'success'
  | 'error';

export interface MarketOrderProgress {
  step: MarketOrderStep;
  txHash?: string;
  error?: string;
}

export interface MarketOrderInput {
  note: StoredNote;
  sellAmount: string;      // human-readable
  buyToken: string;        // address
  buyAmount: string;       // min receive (slippage-adjusted)
  slippageBps: number;     // applied by UI to compute buyAmount (min receive)
  expiryHours: number;
  claimRecipient: string;  // typically self
  dexRouter: string;       // Uniswap V3 router address
  uniswapFeeTier: number;  // 500, 3000, 10000
}

const UNISWAP_ROUTER_ABI = [
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)',
];

export const MarketOrderService = {
  async execute(
    signer: ethers.Signer,
    account: string,
    input: MarketOrderInput,
    onProgress: (p: MarketOrderProgress) => void,
  ): Promise<string | null> {
    const settlementAddr = ConfigService.getPrivateSettlementAddress();
    if (!settlementAddr) throw new Error('PrivateSettlement address not configured');

    const poolAddr = ConfigService.getCommitmentPoolAddress();
    if (!poolAddr) throw new Error('CommitmentPool address not configured');

    const { note, buyToken, dexRouter, uniswapFeeTier, expiryHours, claimRecipient } = input;
    // Resolve decimals per token — using a hardcoded 18 silently miscomputes
    // amounts for tokens like USDC (6 decimals) by a factor of 10^12.
    const readProvider = ProviderService.getReadProvider();
    const [sellDecimals, buyDecimals] = await Promise.all([
      TokenService.getDecimals(readProvider, note.token),
      TokenService.getDecimals(readProvider, buyToken),
    ]);
    const sellAmount = ethers.parseUnits(input.sellAmount, sellDecimals);
    const buyAmount = ethers.parseUnits(input.buyAmount, buyDecimals);

    // Validate sell amount doesn't exceed note balance
    if (sellAmount > BigInt(note.amount)) {
      throw new Error(`Sell amount exceeds note balance (${ethers.formatUnits(note.amount, sellDecimals)} ${note.tokenSymbol}).`);
    }
    const nonceBytes = new Uint8Array(8);
    crypto.getRandomValues(nonceBytes);
    let nonce = 0n;
    for (const b of nonceBytes) nonce = (nonce << 8n) | BigInt(b);
    const expiry = BigInt(Math.floor(Date.now() / 1000) + expiryHours * 3600);

    try {
      // ─── Step 1: Sanctions + EdDSA key ────────────────
      onProgress({ step: 'checking' });

      const sanctionsAddr = await ProviderService.getSanctionsListAddress();
      if (sanctionsAddr && sanctionsAddr !== ethers.ZeroAddress) {
        const { SANCTIONS_LIST_ABI } = await import('../lib/contracts');
        const sanctions = new ethers.Contract(sanctionsAddr, SANCTIONS_LIST_ABI, ProviderService.getReadProvider());
        if (await sanctions.isSanctioned(account)) {
          throw new Error('Your address is on the sanctions list.');
        }
      }

      const keyPair = await EdDSAKeyService.getOrDeriveKey(signer, account);

      // ─── Step 2: Build claims + authorize proof ───────
      onProgress({ step: 'generating_proof' });

      // Single claim: send all buyAmount to recipient
      const claimSecret = generateRandomField();
      const claimLeafHash = await ZKBridgeService.poseidonHash([
        claimSecret,
        BigInt(claimRecipient).toString(),
        BigInt(buyToken).toString(),
        buyAmount.toString(),
        '0', // releaseTime = immediate
      ]);

      const claimLeaves: string[] = [claimLeafHash];
      while (claimLeaves.length < 16) claimLeaves.push('0');
      const { root: claimsRoot } = await buildPoseidonMerkleTree(claimLeaves, 4);

      // Order hash + EdDSA sign (relayer = self, maxFee = 0)
      const orderHashInputs = [
        BigInt(note.token).toString(),
        BigInt(buyToken).toString(),
        sellAmount.toString(),
        buyAmount.toString(),
        '0', // maxFee = 0 for market orders
        expiry.toString(),
        nonce.toString(),
        claimsRoot,
        BigInt(account).toString(), // relayer = self
      ];
      const orderHash = await ZKBridgeService.hashOrder(orderHashInputs);
      const sig = await ZKBridgeService.signEdDSA(keyPair.privateKeyHex, orderHash);

      // Change commitment
      const changeAmount = BigInt(note.amount) - sellAmount;
      let newSalt = '0';
      let newCommitment = '0';
      if (changeAmount > 0n) {
        newSalt = generateRandomField();
        newCommitment = await ZKBridgeService.computeCommitment({
          tag: TAG_COMMITMENT_V2.toString(),
          secret: note.secret,
          token: BigInt(note.token).toString(),
          balance: changeAmount.toString(),
          salt: newSalt,
          pubKeyAx: keyPair.pubKeyAx,
          pubKeyAy: keyPair.pubKeyAy,
        });
      }

      // Nullifiers
      const nullifier = await ZKBridgeService.computeNullifier('0', note.secret, note.salt);
      const nonceNullifier = await ZKBridgeService.computeNullifier('1', note.secret, nonce.toString());

      // Commitment Merkle proof — fetch all commitments and build tree
      const pool = new ethers.Contract(poolAddr, COMMITMENT_POOL_ABI, readProvider);
      const fromBlock = await ProviderService.getEarliestBlock();

      const insertEvents = await pool.queryFilter(
        pool.filters.CommitmentInserted(),
        fromBlock,
      );
      const allLeaves = insertEvents.map((e) => {
        const parsed = pool.interface.parseLog({ topics: e.topics as string[], data: e.data });
        return parsed!.args.commitment.toString();
      });

      // Compute commitment for this note and verify it's in the tree
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
        throw new Error('Note commitment not found in on-chain tree. Leaf index may be stale.');
      }

      const COMMIT_TREE_DEPTH = 20;
      const tree = await buildPoseidonMerkleTree(allLeaves, COMMIT_TREE_DEPTH);
      const commitmentRoot = tree.root;
      const { getMerkleProofFromTree } = await import('../lib/merkleTree');
      // Pass the full tree (not just layers) so the proof extractor can
      // substitute zeroHashes[d] when a sibling falls in the zero region
      // — sparse trees no longer carry full-width layers.
      const { pathElements, pathIndices } = getMerkleProofFromTree(tree, note.leafIndex);

      const circuitInputs: Record<string, string | string[]> = {
        commitmentRoot,
        nullifier,
        nonceNullifier,
        newCommitment,
        sellToken: BigInt(note.token).toString(),
        buyToken: BigInt(buyToken).toString(),
        sellAmount: sellAmount.toString(),
        buyAmount: buyAmount.toString(),
        maxFee: '0',
        expiry: expiry.toString(),
        claimsRoot,
        totalLocked: buyAmount.toString(),
        relayer: BigInt(account).toString(),
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
        claimSecrets: [claimSecret, ...Array(15).fill('0')],
        claimRecipients: [BigInt(claimRecipient).toString(), ...Array(15).fill('0')],
        claimTokens: [BigInt(buyToken).toString(), ...Array(15).fill('0')],
        claimAmounts: [buyAmount.toString(), ...Array(15).fill('0')],
        claimReleaseTimes: Array(16).fill('0'),
        claimCount: '1',
      };

      let wasmB64: string;
      let zkeyB64: string;
      try {
        wasmB64 = await loadCircuitFileB64(require('../../assets/zk/authorize.wasm'));
        zkeyB64 = await loadCircuitFileB64(require('../../assets/zk/authorize_final.zkey'));
      } catch {
        throw new Error('Authorize circuit files not found. Run npm run copy:circuits.');
      }

      const proofResult = await ZKBridgeService.generateProof(circuitInputs, wasmB64, zkeyB64);
      const proof = formatProofForSolidity(proofResult.proof);

      // ─── Step 3: Encode DEX calldata + submit ─────────
      onProgress({ step: 'submitting' });

      const routerIface = new ethers.Interface(UNISWAP_ROUTER_ABI);
      const dexCalldata = routerIface.encodeFunctionData('exactInputSingle', [{
        tokenIn: note.token,
        tokenOut: buyToken,
        fee: uniswapFeeTier,
        recipient: settlementAddr,
        deadline: Math.floor(Date.now() / 1000) + 1800,
        amountIn: sellAmount,
        amountOutMinimum: buyAmount,
        sqrtPriceLimitX96: 0n,
      }]);

      const settlement = new ethers.Contract(settlementAddr, [
        'function settleWithDex(tuple(tuple(uint[2] proofA, uint[2][2] proofB, uint[2] proofC, bytes32 pubKeyBind, uint256 commitmentRoot, bytes32 nullifier, bytes32 nonceNullifier, bytes32 newCommitment, address sellToken, address buyToken, uint128 sellAmount, uint128 buyAmount, uint16 maxFee, uint64 expiry, bytes32 claimsRoot, uint96 totalLocked, address relayer, bytes32 orderHash) proof, address dexRouter, bytes dexCalldata) p) external',
      ], signer);

      // publicSignals layout (see circuits/authorize.circom:506-529):
      //   [0]  pubKeyBind     (circuit output)
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
      // Source every field that is part of the verified proof from ps[] so the
      // on-chain verifier cannot reject us for an input/proof value drift.
      // Address-typed fields (sellToken/buyToken/relayer) arrive as decimal
      // field-element strings — the ABI encoder needs them as 0x-prefixed
      // checksummed addresses, so normalize via ethers.getAddress.
      const ps = proofResult.publicSignals;
      const toAddressHex = (fieldElement: string): string =>
        ethers.getAddress(ethers.toBeHex(BigInt(fieldElement), 20));
      const tx = await settlement.settleWithDex({
        proof: {
          proofA: proof.a,
          proofB: proof.b,
          proofC: proof.c,
          pubKeyBind: ps[0],
          commitmentRoot: ps[1],
          nullifier: ps[2],
          nonceNullifier: ps[3],
          newCommitment: ps[4],
          sellToken: toAddressHex(ps[5]),
          buyToken: toAddressHex(ps[6]),
          sellAmount: ps[7],
          buyAmount: ps[8],
          maxFee: ps[9],
          expiry: ps[10],
          claimsRoot: ps[11],
          totalLocked: ps[12],
          relayer: toAddressHex(ps[13]),
          orderHash: ps[14],
        },
        dexRouter,
        dexCalldata,
      });

      await tx.wait();

      // ─── Step 4: Save change note + mark original spent ─
      onProgress({ step: 'saving', txHash: tx.hash });

      await NoteStorageService.updateNoteStatus(note.id, 'spent');

      if (changeAmount > 0n) {
        await NoteStorageService.saveNote({
          id: newCommitment,
          commitment: newCommitment,
          secret: note.secret,
          salt: newSalt,
          pubKeyAx: keyPair.pubKeyAx,
          pubKeyAy: keyPair.pubKeyAy,
          token: note.token,
          tokenSymbol: note.tokenSymbol,
          amount: changeAmount.toString(),
          leafIndex: -1,
          txHash: tx.hash,
          status: 'pending',
          createdAt: Date.now(),
        });
      }

      // Persist claim data so the user can later produce the claim proof.
      // Route through PendingClaimsStorage so a future SecureStore migration
      // for the `secret` field touches a single module (#233 follow-up).
      const { PendingClaimsStorage } = await import('./PendingClaimsStorage');
      await PendingClaimsStorage.append([{
        secret: claimSecret,
        recipient: claimRecipient,
        token: buyToken,
        amount: buyAmount.toString(),
        releaseTime: '0',
        leafIndex: 0,
        allLeaves: claimLeaves,
        txHash: tx.hash,
      }]);

      onProgress({ step: 'success', txHash: tx.hash });
      return tx.hash;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Market order failed';
      onProgress({ step: 'error', error: message });
      return null;
    }
  },
};
