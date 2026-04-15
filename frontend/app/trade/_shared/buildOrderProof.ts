import { ethers } from "ethers";
import type { TokenInfo } from "../../lib/tokens";
import { isMetaAddress, generateStealthAddress } from "../../lib/stealth";
import { poseidonHash, buildMerkleTree, randomFieldElement, computeCommitment, getMerkleProof } from "../../lib/zk/commitment";
import type { StoredNote } from "../../lib/zk/note-storage";
import { getReadProvider, getSafeFromBlock } from "../../lib/provider";
import { getCommitmentPoolAddress } from "../../lib/config";
import { COMMITMENT_POOL_ABI } from "../../lib/contracts";

export type RecipientMode = "standard" | "stealth";

export interface ClaimRow {
  id: number;
  mode: RecipientMode;
  address: string;
  amount: string;
  delay: string;
  delayUnit: "min" | "hr" | "day";
}

export interface BuildOrderParams {
  sellToken: TokenInfo;
  buyToken: TokenInfo;
  sellAmount: string;
  buyAmount: string;
  expiry: string;
  claims: ClaimRow[];
  account: string;
  selectedNote: StoredNote;
  changeSalt: bigint | null;
  maxFee: bigint;
  relayerAddress: string;
  eddsaPrivateKey: Uint8Array;
  zkRelayerUrl?: string;
  /** Called with a human-readable status before each long-running step
   *  so the UI can show what the user is waiting on instead of a single
   *  opaque "Signing order with EdDSA..." line. */
  onProgress?: (message: string) => void;
}

export async function buildOrderProof(params: BuildOrderParams) {
  const { sellToken, buyToken, sellAmount, buyAmount, expiry, claims, account, selectedNote, changeSalt, maxFee, relayerAddress, eddsaPrivateKey, zkRelayerUrl, onProgress } = params;
  const report = (msg: string) => onProgress?.(msg);

  report("Preparing order data...");
  const parsedSell = ethers.parseUnits(sellAmount, sellToken.decimals);
  const parsedBuy = ethers.parseUnits(buyAmount, buyToken.decimals);
  const expiryTimestamp = BigInt(Math.floor(Date.now() / 1000) + Number(expiry) * 3600);
  const nonce = BigInt(Date.now());

  if (parsedSell > selectedNote.note.amount) {
    throw new Error(`Sell amount exceeds note balance (${selectedNote.amount} ${sellToken.symbol})`);
  }

  // Same salt must flow into (a) the pre-computed `expectedChangeCommitment`
  // written to the note file and (b) the prover's residual-commitment
  // hash. Submit button is disabled while `change > 0n && !changeSalt`
  // so this throw is defense-in-depth.
  const change = selectedNote.note.amount - parsedSell;
  let newSalt = 0n;
  let expectedChangeCommitment = 0n;
  if (change > 0n) {
    if (!changeSalt) throw new Error("Change salt not ready — please retry in a moment.");
    newSalt = changeSalt;
    expectedChangeCommitment = await computeCommitment({
      ownerSecret: selectedNote.note.ownerSecret, token: selectedNote.note.token,
      amount: change, salt: newSalt,
      pubKeyAx: selectedNote.note.pubKeyAx, pubKeyAy: selectedNote.note.pubKeyAy,
    });
  }

  // Build claims data (with optional ephemeralPubKey for stealth)
  const claimDataWithEpk = claims.map((c, idx) => {
    let recipient: string;
    let ephemeralPubKey: string | undefined;
    if (c.mode === "stealth") {
      if (!c.address || !isMetaAddress(c.address)) throw new Error(`Claim #${idx + 1}: Stealth mode requires a valid meta-address (st:eth:0x...)`);
      const stealth = generateStealthAddress(c.address);
      recipient = stealth.stealthAddress;
      ephemeralPubKey = stealth.ephemeralPubKey;
    } else if (c.address && !ethers.isAddress(c.address)) {
      throw new Error(`Claim #${idx + 1}: Invalid recipient address`);
    } else {
      recipient = c.address || account || ethers.ZeroAddress;
    }
    const delaySec = (parseInt(c.delay) || 1) * (c.delayUnit === "day" ? 86400 : c.delayUnit === "hr" ? 3600 : 60);
    const releaseTime = BigInt(Math.floor(Date.now() / 1000) + delaySec);
    const claimSecret = randomFieldElement();
    const claimAmount = c.amount ? ethers.parseUnits(c.amount, buyToken.decimals).toString() : "0";
    return { secret: claimSecret.toString(), recipient: BigInt(recipient).toString(), token: BigInt(buyToken.address).toString(), amount: claimAmount, releaseTime: releaseTime.toString(), ephemeralPubKey };
  });
  const claimData = claimDataWithEpk.map(({ ephemeralPubKey: _, ...rest }) => rest);

  // Compute claimsRoot
  report("Hashing claims and building claims tree...");
  const claimLeafHashes = await Promise.all(
    claimData.map((c) => poseidonHash([BigInt(c.secret), BigInt(c.recipient), BigInt(c.token), BigInt(c.amount), BigInt(c.releaseTime)]))
  );
  const padded = [...claimLeafHashes];
  while (padded.length < 16) padded.push(0n);
  const { root: claimsRoot } = await buildMerkleTree(padded, 4);

  // Fetch Merkle proof (relayer fast path, then on-chain fallback)
  report("Fetching commitment Merkle proof...");
  let merkleProof: { root: bigint; pathElements: bigint[]; pathIndices: number[] };
  try {
    if (!zkRelayerUrl) throw new Error("no relayer");
    const mpRes = await fetch(`${zkRelayerUrl}/api/info/merkle-proof?leafIndex=${selectedNote.leafIndex}`);
    if (!mpRes.ok) throw new Error("unavailable");
    const mpData = await mpRes.json();
    merkleProof = { root: BigInt(mpData.root), pathElements: mpData.pathElements.map((e: string) => BigInt(e)), pathIndices: mpData.pathIndices };
  } catch {
    report("Fetching commitment Merkle proof from chain (slower)...");
    const provider = getReadProvider();
    const poolContract = new ethers.Contract(getCommitmentPoolAddress(), COMMITMENT_POOL_ABI, provider);
    const events = await poolContract.queryFilter(poolContract.filters.CommitmentInserted(), await getSafeFromBlock(provider));
    const leaves: bigint[] = [];
    for (const ev of events) { const e = ev as ethers.EventLog; const idx = Number(e.args.leafIndex); while (leaves.length <= idx) leaves.push(0n); leaves[idx] = BigInt(e.args.commitment); }
    const tree = await buildMerkleTree(leaves, 20);
    const proof = getMerkleProof(tree.layers, selectedNote.leafIndex);
    merkleProof = { root: tree.root, pathElements: proof.pathElements, pathIndices: proof.pathIndices };
  }

  // Generate authorize proof in Web Worker
  report("Generating ZK proof (this is the slow step, ~10–30s)...");
  const { generateAuthorizeProofInWorker } = await import("../../lib/zk/authorize-worker-client");
  const proofResult = await generateAuthorizeProofInWorker({
    note: selectedNote.note, leafIndex: selectedNote.leafIndex, merkleProof,
    sellAmount: parsedSell, buyToken: buyToken.address, buyAmount: parsedBuy,
    maxFee, expiry: expiryTimestamp, nonce, relayer: relayerAddress,
    eddsaPrivateKey,
    claims: claimData.map(c => ({ secret: BigInt(c.secret), recipient: c.recipient, token: c.token, amount: BigInt(c.amount), releaseTime: BigInt(c.releaseTime) })),
    // Same salt as `expectedChangeCommitment`. Gate on `change > 0n`,
    // not `newSalt > 0n` — `0n` is a valid (if astronomically unlikely)
    // salt that truthiness-gating would silently drop.
    newSalt: change > 0n ? newSalt : undefined,
  });

  return { proofResult, claimData, claimDataWithEpk, claimsRoot, padded, parsedSell, parsedBuy, expiryTimestamp, nonce, change, newSalt, expectedChangeCommitment };
}

