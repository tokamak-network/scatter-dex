"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import Link from "next/link";
import { ethers } from "ethers";
import { Lock, Loader2, AlertCircle, Download, ShieldCheck, FolderOpen, Coins } from "lucide-react";
import { TradeDetail, type TradeData } from "../../components/TradeDetail";
import { useWallet } from "../../lib/wallet";
import { getPrivateSettlementAddress, getCommitmentPoolAddress } from "../../lib/config";
import { getReadProvider, getEarliestBlock, cacheEarliestBlock } from "../../lib/provider";
import { getTokenList, type TokenInfo } from "../../lib/tokens";
import {
  generateNote,
  computeCommitment,
  computeNullifier,
  computeClaimNullifier,
  poseidonHash,
  toBytes32Hex,
  type CommitmentNote,
} from "../../lib/zk/commitment";
import { PRIVATE_SETTLEMENT_ABI, COMMITMENT_POOL_ABI, COMMITMENT_POOL_IFACE, ERC20_ABI } from "../../lib/contracts";
import {
  isFileSystemAvailable,
  selectNotesFolder,
  hasFolderSelected,
  getFolderName,
  saveNote,
  loadNotes,
  loadClaimsFiles,
  deleteNote,
  loadConfigFromFolder,
  saveConfigToFolder,
  loadEdDSAKeyFromFolder,
  saveEdDSAKeyToFolder,
  type StoredNote,
} from "../../lib/zk/note-storage";
import { generateDepositProofInWorker } from "../../lib/zk/deposit-worker-client";
import {
  deriveEdDSAKey,
  DERIVE_MESSAGE,
  isEncryptedKeyPair,
  serializeKeyPairEncrypted,
  deserializeKeyPairEncrypted,
  type EdDSAKeyPair,
} from "../../lib/zk/eddsa";
import {
  fetchCapabilities,
  supportsAtomicBatch,
  sendCalls,
  waitForCallsReceipt,
  Eip5792Unsupported,
  type SendCallsCall,
} from "../../lib/eip5792";
import { friendlyError } from "../../lib/error-messages";
import ExplorerLink from "../../components/ExplorerLink";


type TxState = "idle" | "deriving_key" | "approving" | "depositing" | "success" | "error";

export default function PrivateEscrowPage() {
  const { account, signer, chainId, connect } = useWallet();
  const tokens = getTokenList();

  const [notes, setNotes] = useState<StoredNote[]>([]);
  const [orderFiles, setOrderFiles] = useState<Array<{ order?: { leafIndex: number; sellAmount: string; buyAmount: string; sellToken: string; buyToken: string; maxFee: number }; claims: Array<{ secret?: string; recipient: string; token?: string; amount: string; releaseTime: string; leafIndex?: number }>; createdAt: string }>>([]);
  const [folderReady, setFolderReady] = useState(false);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [selectedTrade, setSelectedTrade] = useState<TradeData | null>(null);
  const [depositTokenIdx, setDepositTokenIdx] = useState(0);
  const [depositAmount, setDepositAmount] = useState("");
  const [txState, setTxState] = useState<TxState>("idle");
  const [txError, setTxError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  // EdDSA trading key cached for the session, scoped by account. First
  // deposit either unlocks the stored key (1 signMessage popup) or
  // derives+saves a new one (1 signMessage popup + folder write);
  // subsequent deposits in the same session reuse this state and skip
  // the popup entirely. Keeping the account alongside the key prevents
  // a wallet switch mid-session from silently binding new deposits to
  // the previous account's pubkey.
  const [cachedKey, setCachedKey] = useState<{ account: string; keyPair: EdDSAKeyPair } | null>(null);
  const keyPair = cachedKey && account && cachedKey.account.toLowerCase() === account.toLowerCase()
    ? cachedKey.keyPair
    : null;
  useEffect(() => {
    // Drop stale cache when the connected account changes (covers wallet
    // switches and disconnects). The in-memory keyPair would otherwise
    // still satisfy the "is cached" check inside handleDeposit.
    if (cachedKey && account && cachedKey.account.toLowerCase() !== account.toLowerCase()) {
      setCachedKey(null);
    }
  }, [account, cachedKey]);

  // EIP-5792 capabilities are stable per (wallet, account, chain); caching
  // at the page level keeps the deposit-click hot path free of the extra
  // `wallet_getCapabilities` RPC.
  const [canAtomicBatch, setCanAtomicBatch] = useState(false);
  useEffect(() => {
    setCanAtomicBatch(false);
    if (!signer?.provider || !account || chainId == null) return;
    let cancelled = false;
    (async () => {
      try {
        const caps = await fetchCapabilities(signer.provider as ethers.BrowserProvider, account);
        if (!cancelled) setCanAtomicBatch(supportsAtomicBatch(caps, chainId));
      } catch {
        /* wallets that throw on the capability probe stay on sequential */
      }
    })();
    return () => { cancelled = true; };
  }, [account, chainId, signer]);

  const poolAddress = process.env.NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS || "";
  const selectedToken = tokens[depositTokenIdx] as TokenInfo | undefined;
  const fsAvailable = isFileSystemAvailable();
  const [walletBalance, setWalletBalance] = useState<string | null>(null);

  // Track which notes are spent on-chain (nullifier consumed)
  const [spentNotes, setSpentNotes] = useState<Set<string>>(new Set());
  // Track whether all claims for a given leafIndex are completed
  const [allClaimsDone, setAllClaimsDone] = useState<Record<number, boolean>>({});
  const [syncError, setSyncError] = useState(false);

  useEffect(() => {
    if (notes.length === 0) return;
    let cancelled = false;
    setSyncError(false);
    (async () => {
      try {
        const provider = getReadProvider();
        const settlement = new ethers.Contract(
          getPrivateSettlementAddress(), PRIVATE_SETTLEMENT_ABI, provider
        );

        // Check spent notes in parallel
        const activeNotes = notes.filter((n) => n.leafIndex >= 0);
        const spentResults = await Promise.all(
          activeNotes.map(async (n) => {
            const nullifier = await computeNullifier(n.note);
            const isSpent = await settlement.nullifiers(toBytes32Hex(nullifier));
            return { commitment: n.commitment, isSpent };
          })
        );
        const spent = new Set(spentResults.filter((r) => r.isSpent).map((r) => r.commitment));
        if (!cancelled) setSpentNotes(spent);

        // Check claim statuses per leafIndex in parallel
        const claimChecks = orderFiles
          .filter((o) => o.order && o.claims?.length)
          .map(async (o) => {
            const leafIdx = o.order!.leafIndex;
            const results = await Promise.all(
              o.claims.map(async (c: { secret?: string | bigint; leafIndex?: number }) => {
                if (c.secret == null || c.leafIndex == null) return true;
                // [M4] Use the centralised computeClaimNullifier helper so the
                //      tag definition cannot drift from circuits/zk-prover.
                const claimNull = await computeClaimNullifier(BigInt(c.secret), BigInt(c.leafIndex));
                return settlement.claimNullifiers(toBytes32Hex(claimNull));
              })
            );
            return { leafIdx, allDone: results.every(Boolean) };
          });
        const claimResults = await Promise.all(claimChecks);
        const claimsDone: Record<number, boolean> = {};
        for (const { leafIdx, allDone } of claimResults) claimsDone[leafIdx] = allDone;
        if (!cancelled) setAllClaimsDone(claimsDone);

        // Resolve leafIndex for change notes (leafIndex === -1) from on-chain events
        const changeNotesList = notes.filter((n) => n.leafIndex === -1);
        if (changeNotesList.length > 0) {
          const poolAddr = getCommitmentPoolAddress();
          const poolContract = new ethers.Contract(
            poolAddr,
            ["event CommitmentInserted(uint256 indexed commitment, uint32 leafIndex, uint256 timestamp)"],
            provider
          );
          // Query per change note using indexed commitment filter (efficient).
          // Compute fromBlock once to avoid repeated localStorage reads.
          const fromBlock = getEarliestBlock();
          // Resolve leafIndex for each pending change note. Retry on
          // transient RPC errors (e.g. drpc's 500 "Temporary internal error")
          // so a single blip doesn't leave the note stuck at leafIndex=-1 —
          // those notes aren't selectable in the trade form.
          const queryWithRetry = async (commitBigInt: bigint, maxAttempts = 3): Promise<ethers.EventLog[] | null> => {
            for (let i = 0; i < maxAttempts; i++) {
              try {
                const logs = await poolContract.queryFilter(
                  poolContract.filters.CommitmentInserted(commitBigInt),
                  fromBlock,
                );
                return logs as ethers.EventLog[];
              } catch (e) {
                if (i === maxAttempts - 1) { console.warn("Failed to resolve change note after retries:", e); return null; }
                await new Promise((r) => setTimeout(r, 400 * (i + 1)));
              }
            }
            return null;
          };
          const resolved = await Promise.all(changeNotesList.map(async (cn) => {
            const commitBigInt = BigInt(cn.commitment);
            const logs = await queryWithRetry(commitBigInt);
            if (logs && logs.length > 0) {
              const e = logs[logs.length - 1];
              return { cn, leafIdx: Number(e.args.leafIndex) };
            }
            return null;
          }));

          // Apply file updates sequentially to avoid storage race conditions
          let anyResolved = false;
          for (const r of resolved) {
            if (r) {
              await deleteNote(r.cn);
              await saveNote({ ...r.cn, leafIndex: r.leafIdx });
              anyResolved = true;
            }
          }
          if (anyResolved && !cancelled) {
            const reloaded = await loadNotes();
            setNotes(reloaded);
            return;
          }
        }
      } catch (e) {
        console.warn("Failed to sync on-chain status:", e);
        if (!cancelled) setSyncError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [notes, orderFiles]);

  // Fetch wallet balance for selected token
  useEffect(() => {
    if (!account || !selectedToken) { setWalletBalance(null); return; }
    (async () => {
      try {
        const provider = getReadProvider();
        let bal: bigint;
        if (selectedToken.isNative) {
          bal = await provider.getBalance(account);
        } else {
          const erc20 = new ethers.Contract(selectedToken.address, ERC20_ABI, provider);
          bal = await erc20.balanceOf(account);
        }
        setWalletBalance(ethers.formatUnits(bal, selectedToken.decimals));
      } catch {
        setWalletBalance(null);
      }
    })();
  }, [account, selectedToken, txState]);

  // Load notes + order files when folder is selected
  const refreshNotes = useCallback(async () => {
    if (!hasFolderSelected()) return;
    const loaded = await loadNotes();
    setNotes(loaded);
    try {
      const claims = await loadClaimsFiles();
      setOrderFiles(claims as unknown as typeof orderFiles);
    } catch { /* ignore */ }
  }, []);

  // ─── Select Folder ─────────────────────────────────────────────
  const handleSelectFolder = useCallback(async () => {
    const ok = await selectNotesFolder();
    if (ok) {
      setFolderReady(true);
      setFolderName(getFolderName());
      await refreshNotes();
      // Sync earliest block from folder config → localStorage
      try {
        const cfg = await loadConfigFromFolder();
        if (typeof cfg.earliestBlock === "number") cacheEarliestBlock(cfg.earliestBlock);
      } catch (e) { console.warn("Failed to sync config from folder:", e); }
    }
  }, [refreshNotes]);

  // ─── Deposit ───────────────────────────────────────────────────
  const handleDeposit = useCallback(async () => {
    if (!signer || !account || !selectedToken || !depositAmount || !poolAddress) return;
    if (!hasFolderSelected()) {
      setTxError("Please select a notes folder first");
      return;
    }
    setTxError(null);
    setTxHash(null);

    try {
      const parsed = ethers.parseUnits(depositAmount, selectedToken.decimals);
      if (parsed <= 0n) return;

      // [issue #128] Derive the user's deterministic BabyJub signing
      // keypair before generating the note — the commitment preimage
      // binds the pubkey so every deposit must be paired with a known
      // key the user can re-derive from the same MetaMask signature.
      //
      // Session caching: once unlocked (or freshly generated) the key
      // is kept in React state, so only the first deposit of a session
      // incurs the sign-message popup. Private-order uses the same
      // folder-backed pattern.
      let kp = keyPair;
      if (!kp) {
        // Mark the handler busy before the first await — the button's
        // `disabled={isBusy}` check (which now includes "deriving_key")
        // prevents a double-click from launching a second signMessage
        // prompt while this one is awaiting the wallet.
        setTxState("deriving_key");
        const saved = await loadEdDSAKeyFromFolder(account);
        if (saved && isEncryptedKeyPair(saved)) {
          const signature = await signer.signMessage(DERIVE_MESSAGE);
          kp = await deserializeKeyPairEncrypted(saved, signature, account);
        } else {
          const { keyPair: derived, signature } = await deriveEdDSAKey(signer);
          kp = derived;
          try {
            const encrypted = await serializeKeyPairEncrypted(kp, signature, account);
            await saveEdDSAKeyToFolder(encrypted, account);
          } catch (e) {
            // Non-fatal: the in-memory key still lets the current
            // session proceed; next session will re-derive.
            console.warn("[private-escrow] failed to persist EdDSA key to folder:", e);
          }
        }
        // Cache with the owning account so a wallet switch invalidates
        // the cached key instead of reusing it for the new account.
        setCachedKey({ account, keyPair: kp });
      }

      // For native ETH: commitment uses the WETH address (same underlying token)
      const commitTokenAddr = selectedToken.address;
      const note = generateNote(commitTokenAddr, parsed, kp.publicKey);
      // commitment is derived inside generateDepositProof so it cannot
      // drift from the note's preimage; we still compute it once here for
      // event parsing / note storage below.
      const commitment = await computeCommitment(note);

      // Build the deposit proof up-front. It depends only on the note's
      // own secrets (no on-chain state), so generating it now lets us
      // bundle `deposit` into an EIP-7702 batch alongside wrap/approve.
      // Falls back-to-back compatible: the legacy sequential path below
      // reuses the same proof rather than regenerating it.
      setTxState("depositing");
      const depositProof = await generateDepositProofInWorker(note);

      const pool = new ethers.Contract(poolAddress, COMMITMENT_POOL_ABI, signer);
      const depositCallData = pool.interface.encodeFunctionData("deposit", [
        depositProof.proof.a,
        depositProof.proof.b,
        depositProof.proof.c,
        depositProof.commitment,
        commitTokenAddr,
        parsed,
      ]);

      const wethIface = new ethers.Interface(["function deposit() external payable"]);
      const erc20 = new ethers.Contract(selectedToken.address, ERC20_ABI, signer);
      const allowance: bigint = await erc20.allowance(account, poolAddress);
      const needsApprove = allowance < parsed;

      // Atomic batch via EIP-5792; falls back to sequential below.
      let receipt: ethers.TransactionReceipt | null = null;
      const provider = signer.provider;

      if (provider && canAtomicBatch && chainId != null) {
        const calls: SendCallsCall[] = [];
        if (selectedToken.isNative) {
          calls.push({
            to: selectedToken.address,
            value: ethers.toQuantity(parsed),
            data: wethIface.encodeFunctionData("deposit", []),
          });
        }
        if (needsApprove) {
          calls.push({
            to: selectedToken.address,
            data: erc20.interface.encodeFunctionData("approve", [poolAddress, ethers.MaxUint256]),
          });
        }
        calls.push({ to: poolAddress, data: depositCallData });

        try {
          const result = await sendCalls(provider as ethers.BrowserProvider, {
            from: account,
            chainId,
            calls,
          });
          const status = await waitForCallsReceipt(provider as ethers.BrowserProvider, result.id);
          // For atomic batches all entries share one transaction hash;
          // the last receipt carries the full logs, which is what
          // downstream leafIndex parsing needs. Reverted batches
          // still come back as `status: "completed"` per 5792 — the
          // per-tx `receipts[i].status` is `"0x0"` for revert — so
          // we must check both presence and success before proceeding.
          const last = status.receipts?.[status.receipts.length - 1];
          if (!last) {
            // Batch was accepted by the wallet but the status payload
            // has no receipts. Proceeding to the sequential path here
            // would double-submit, so raise instead.
            throw new Error("Atomic batch completed but wallet returned no receipts");
          }
          if (last.status !== "0x1") {
            throw new Error(`Atomic batch reverted on-chain (tx ${last.transactionHash})`);
          }
          receipt = {
            hash: last.transactionHash,
            blockNumber: Number(last.blockNumber),
            logs: last.logs.map((l) => ({
              address: l.address,
              data: l.data,
              topics: l.topics,
            })),
          } as unknown as ethers.TransactionReceipt;
        } catch (err) {
          if (!(err instanceof Eip5792Unsupported)) throw err;
          console.info(
            "[private-escrow] wallet does not support EIP-5792 atomic batch, falling back to sequential txs",
          );
        }
      }

      if (!receipt) {
        // Legacy sequential path — one MetaMask popup per step.
        if (selectedToken.isNative) {
          setTxState("approving");
          const wethContract = new ethers.Contract(
            selectedToken.address,
            ["function deposit() external payable", ...ERC20_ABI],
            signer,
          );
          const wrapTx = await wethContract.deposit({ value: parsed });
          await wrapTx.wait();
          if (needsApprove) {
            const approveTx = await wethContract.approve(poolAddress, ethers.MaxUint256);
            await approveTx.wait();
          }
        } else if (needsApprove) {
          setTxState("approving");
          const approveTx = await erc20.approve(poolAddress, ethers.MaxUint256);
          await approveTx.wait();
        }

        setTxState("depositing");
        const tx = await pool.deposit(
          depositProof.proof.a,
          depositProof.proof.b,
          depositProof.proof.c,
          depositProof.commitment,
          commitTokenAddr,
          parsed,
        );
        receipt = await tx.wait();
      }

      if (!receipt) throw new Error("deposit receipt was null");
      setTxHash(receipt.hash);

      // Parse leafIndex from event
      let leafIndex = 0;
      for (const log of receipt.logs) {
        try {
          const p = COMMITMENT_POOL_IFACE.parseLog({ topics: [...log.topics], data: log.data });
          if (p?.name === "CommitmentInserted") {
            leafIndex = Number(p.args.leafIndex);
          }
        } catch { /* skip */ }
      }
      // Cache deploy block for future event queries (localStorage + folder)
      if (receipt.blockNumber) {
        cacheEarliestBlock(receipt.blockNumber);
        try { await saveConfigToFolder("earliestBlock", receipt.blockNumber); } catch (e) { console.warn("Failed to save config to folder:", e); }
      }

      // Save note to folder
      const storedNote: StoredNote = {
        note,
        commitment: commitment.toString(),
        tokenSymbol: selectedToken.symbol,
        tokenAddress: selectedToken.address,
        amount: depositAmount,
        leafIndex,
        txHash: receipt.hash,
        createdAt: Date.now(),
      };
      await saveNote(storedNote);
      await refreshNotes();

      setTxState("success");
      setDepositAmount("");
    } catch (e: unknown) {
      setTxState("error");
      setTxError(friendlyError(e));
    }
  }, [signer, account, chainId, canAtomicBatch, selectedToken, depositAmount, poolAddress, refreshNotes, keyPair]);

  // ─── Hide Note (local-only) ────────────────────────────────────
  // Deletion is intentionally not exposed: a note file is the ONLY
  // record of the secrets needed to spend or claim a commitment, so
  // a UX-driven trash button is too dangerous (one wrong click loses
  // funds). Instead we maintain a per-account "hidden" set in
  // localStorage that filters notes out of the visible list. The
  // file on disk is untouched, so unhiding restores the entry and
  // the user can recover funds at any time.
  const hiddenStorageKey = account ? `escrow:hiddenNotes:${account.toLowerCase()}` : null;
  const [hiddenNotes, setHiddenNotes] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    if (!hiddenStorageKey) { setHiddenNotes(new Set()); return; }
    try {
      const raw = window.localStorage.getItem(hiddenStorageKey);
      // Guard against malformed payloads (manual edits, schema drift,
      // legacy non-array values) — fall back to an empty set rather
      // than throwing during render.
      const parsed = raw ? JSON.parse(raw) : [];
      setHiddenNotes(Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === "string")) : new Set());
    } catch {
      setHiddenNotes(new Set());
    }
  }, [hiddenStorageKey]);

  // Functional-update wrapper: derives `next` from the latest state
  // inside the setter so rapid hide/unhide clicks can't drop updates
  // via stale closures, and only persists the actually-applied value.
  const persistHidden = useCallback((update: (prev: Set<string>) => Set<string>) => {
    setHiddenNotes((prev) => {
      const next = update(prev);
      if (hiddenStorageKey) {
        try {
          window.localStorage.setItem(hiddenStorageKey, JSON.stringify(Array.from(next)));
        } catch { /* quota / private mode — keep state in memory */ }
      }
      return next;
    });
  }, [hiddenStorageKey]);

  const handleHideNote = useCallback((n: StoredNote) => {
    persistHidden((prev) => {
      const next = new Set(prev);
      next.add(n.commitment);
      return next;
    });
  }, [persistHidden]);

  const handleUnhideNote = useCallback((n: StoredNote) => {
    persistHidden((prev) => {
      const next = new Set(prev);
      next.delete(n.commitment);
      return next;
    });
  }, [persistHidden]);

  // Manual refresh: re-read the notes folder + re-run on-chain status
  // checks. Useful after a claim or settle that happened in another tab
  // — without this the page only re-indexes when notes/orderFiles
  // change, which doesn't fire on simple navigation back.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleManualRefresh = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await refreshNotes();
    } finally {
      setIsRefreshing(false);
    }
  }, [refreshNotes, isRefreshing]);

  // Count hidden commitments that actually exist in the current
  // folder, so the "Show hidden (N)" toggle reflects only what the
  // user can see — not stale entries from past sessions / wallets.
  const hiddenInFolderCount = useMemo(
    () => notes.reduce((acc, n) => acc + (hiddenNotes.has(n.commitment) ? 1 : 0), 0),
    [notes, hiddenNotes],
  );

  const isBusy = txState === "deriving_key" || txState === "approving" || txState === "depositing";

  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-on-surface-variant/60">
        <Lock className="w-12 h-12 mb-4 opacity-40" />
        <p className="text-lg font-medium mb-4">Connect wallet to use Private Escrow</p>
        <button onClick={() => connect()} className="gradient-btn text-on-primary-fixed px-6 py-2.5 rounded-md font-bold text-sm">
          Connect Wallet
        </button>
      </div>
    );
  }

  if (!poolAddress) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-on-surface-variant/60">
        <AlertCircle className="w-12 h-12 mb-4 opacity-40" />
        <p className="text-lg font-medium">CommitmentPool not deployed</p>
        <p className="text-sm mt-2">Set NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS in .env.local</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-headline font-semibold text-on-surface flex items-center gap-2">
          <Lock className="w-6 h-6 text-primary" />
          Private Escrow
        </h1>
        <p className="text-sm text-on-surface-variant/70 mt-1">
          ZK commitment-based escrow. Your balance is hidden on-chain.
        </p>
      </div>

      {/* Local storage warning */}
      <div className="flex items-start gap-3 p-4 rounded-xl bg-tertiary/5 border border-tertiary/20">
        <AlertCircle className="w-5 h-5 text-tertiary flex-shrink-0 mt-0.5" />
        <div className="text-xs text-on-surface-variant space-y-1">
          <p className="font-semibold text-tertiary">Your secret notes are stored locally only</p>
          <p>
            zkScatter does not store any personal data on its servers. Your commitment notes
            (containing secret keys needed to withdraw or trade) are saved as local files
            that only you control. <strong>If you lose these files, your deposited funds
            cannot be recovered.</strong> Please back up your notes folder regularly.
          </p>
        </div>
      </div>

      {/* Folder Selection */}
      {fsAvailable && !folderReady && (
        <div className="bg-surface-container rounded-xl p-6 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-on-surface">Select Notes Folder</h3>
            <p className="text-xs text-on-surface-variant/60 mt-1">
              Choose a local folder to store your private notes. Notes are saved as JSON files — you control the backup.
            </p>
          </div>
          <button
            onClick={handleSelectFolder}
            className="flex items-center gap-2 px-4 py-2.5 rounded-md gradient-btn text-on-primary-fixed font-bold text-sm"
          >
            <FolderOpen className="w-4 h-4" />
            Select Folder
          </button>
        </div>
      )}

      {!fsAvailable && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-yellow-500/10 text-yellow-500 text-xs">
          <AlertCircle className="w-4 h-4 shrink-0" />
          File System Access API not available. Use Chrome for local folder storage.
        </div>
      )}

      <div className="grid grid-cols-12 gap-8">
        {/* Left: Notes */}
        <div className="col-span-12 lg:col-span-8">
          <div className="bg-surface-container rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-outline-variant/10 flex justify-between items-center">
              <h3 className="font-headline font-bold text-on-surface">
                Private Notes ({notes.length})
              </h3>
              <div className="flex items-center gap-3">
                {folderReady && (
                  <span className="text-xs text-emerald-400 flex items-center gap-1">
                    <FolderOpen className="w-3.5 h-3.5" /> {folderName ?? "Folder connected"}
                  </span>
                )}
                {hiddenInFolderCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowHidden((v) => !v)}
                    className="text-xs text-on-surface-variant/70 hover:text-on-surface transition-colors"
                  >
                    {showHidden ? `Hide hidden (${hiddenInFolderCount})` : `Show hidden (${hiddenInFolderCount})`}
                  </button>
                )}
                {folderReady && (
                  <button
                    type="button"
                    onClick={handleManualRefresh}
                    disabled={isRefreshing}
                    className="text-xs text-on-surface-variant/70 hover:text-on-surface transition-colors flex items-center gap-1.5 disabled:opacity-50"
                    title="Re-read notes folder and re-check on-chain status"
                  >
                    {isRefreshing && <Loader2 className="w-3 h-3 animate-spin" />}
                    Refresh
                  </button>
                )}
              </div>
            </div>

            {syncError && (
              <div className="mx-6 mt-3 flex items-center gap-2 p-2.5 rounded-lg bg-amber-500/10 text-amber-400 text-xs">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                Could not sync on-chain status. Note statuses may be outdated.
              </div>
            )}

            {!folderReady ? (
              <div className="px-6 py-16 text-center text-on-surface-variant/50">
                <FolderOpen className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p>Select a folder to view and manage your private notes.</p>
              </div>
            ) : notes.length === 0 ? (
              <div className="px-6 py-16 text-center text-on-surface-variant/50">
                <ShieldCheck className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p>No private deposits yet.</p>
                <p className="text-xs mt-1">Deposit tokens to create a private commitment.</p>
              </div>
            ) : (
              <div className="divide-y divide-outline-variant/10">
                {notes
                  .filter((n) => n.leafIndex >= 0)
                  .filter((n) => showHidden || !hiddenNotes.has(n.commitment))
                  .map((n) => {
                  // Find pending change notes linked to this note (same ownerSecret, leafIndex === -1)
                  const changeNotes = notes.filter((c) =>
                    c.leafIndex === -1 &&
                    c.note.ownerSecret === n.note.ownerSecret &&
                    c.commitment !== n.commitment
                  );
                  const isSpent = spentNotes.has(n.commitment);
                  const hasChange = changeNotes.length > 0;
                  const claimsDone = allClaimsDone[n.leafIndex] === true;
                  const statusLabel = isSpent
                    ? (claimsDone ? "Spent" : "Trading")
                    : "Active";
                  const statusStyle = isSpent
                    ? (claimsDone
                      ? "bg-on-surface-variant/10 text-on-surface-variant/50"
                      : "bg-blue-500/10 text-blue-400")
                    : "bg-emerald-500/10 text-emerald-400";
                  // Spent notes that have no pending change are dead — fully
                  // gray them out (bg + opacity) so they visually recede.
                  // Spent notes with Trading-state change keep normal colors
                  // so the user can still interact with the pending payout.
                  const isDead = isSpent && claimsDone;
                  return (
                  <div key={n.commitment}>
                    <div
                      onClick={() => setExpandedKey(expandedKey === n.commitment ? null : n.commitment)}
                      className={`px-6 py-4 flex items-center justify-between cursor-pointer transition-colors ${expandedKey === n.commitment ? "bg-surface-bright/10" : ""} ${
                        isDead
                          ? "opacity-40 grayscale bg-on-surface-variant/5 hover:bg-on-surface-variant/10"
                          : "hover:bg-surface-bright/20"
                      }`}
                    >
                      <div className="flex items-center gap-4">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isSpent ? "bg-on-surface-variant/10" : "bg-primary/10"}`}>
                          <Lock className={`w-5 h-5 ${isSpent ? "text-on-surface-variant/40" : "text-primary"}`} />
                        </div>
                        <div>
                          <div className={`font-semibold flex items-center gap-2 ${isSpent && !hasChange ? "text-on-surface-variant/50 line-through" : "text-on-surface"}`}>
                            {n.amount} {n.tokenSymbol}
                            {isSpent && hasChange && !claimsDone && (
                              <span className="flex items-center gap-1 text-xs font-normal text-amber-400">
                                <Coins className="w-3 h-3" />
                                Change {changeNotes[0].amount} {changeNotes[0].tokenSymbol}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-on-surface-variant/50 font-mono">
                            leaf #{n.leafIndex} &middot; {new Date(n.createdAt).toLocaleDateString()}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`text-xs px-2 py-1 rounded font-medium ${statusStyle}`}>
                          {statusLabel}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            hiddenNotes.has(n.commitment) ? handleUnhideNote(n) : handleHideNote(n);
                          }}
                          className="text-xs px-2 py-1 rounded text-on-surface-variant/60 hover:text-on-surface hover:bg-surface-bright/40 transition-colors"
                          title={
                            hiddenNotes.has(n.commitment)
                              ? "Unhide — show this commitment in the list again"
                              : "Hide — remove from this list (note file stays on disk; funds are not affected)"
                          }
                        >
                          {hiddenNotes.has(n.commitment) ? "Unhide" : "Hide"}
                        </button>
                      </div>
                    </div>
                    {expandedKey === n.commitment && (
                      <div className="px-6 py-4 bg-surface-container/50 border-t border-outline-variant/5 space-y-4">
                        {/* Note details */}
                        <div className="bg-surface-container rounded-lg px-4 py-3">
                          <div className="grid grid-cols-4 gap-y-3 text-xs">
                            <div>
                              <div className="text-[10px] text-on-surface-variant/40 uppercase tracking-wider">Token</div>
                              <div className="font-mono text-on-surface mt-1">{n.tokenSymbol}</div>
                            </div>
                            <div>
                              <div className="text-[10px] text-on-surface-variant/40 uppercase tracking-wider">Amount</div>
                              <div className="font-mono text-on-surface mt-1">{n.amount}</div>
                            </div>
                            <div>
                              <div className="text-[10px] text-on-surface-variant/40 uppercase tracking-wider">Leaf</div>
                              <div className="font-mono text-on-surface mt-1">#{n.leafIndex}</div>
                            </div>
                            <div>
                              <div className="text-[10px] text-on-surface-variant/40 uppercase tracking-wider">Date</div>
                              <div className="text-on-surface mt-1">{new Date(n.createdAt).toLocaleDateString()}</div>
                            </div>
                          </div>
                          <div className="mt-3 pt-3 border-t border-outline-variant/5 space-y-2 text-xs">
                            <div>
                              <div className="text-[10px] text-on-surface-variant/40 uppercase tracking-wider">Commitment</div>
                              <div className="font-mono text-on-surface/80 mt-1 text-[11px] break-all leading-relaxed">{n.commitment}</div>
                            </div>
                            {n.txHash && (
                              <div>
                                <div className="text-[10px] text-on-surface-variant/40 uppercase tracking-wider">Deposit Tx</div>
                                <div className="flex items-center gap-2 mt-1">
                                  <ExplorerLink kind="tx" value={n.txHash} chainId={chainId} className="text-primary" />
                                  <button
                                    onClick={() => navigator.clipboard.writeText(n.txHash)}
                                    className="shrink-0 text-on-surface-variant/40 hover:text-on-surface transition-colors text-xs"
                                    title="Copy"
                                  >Copy</button>
                                </div>
                              </div>
                            )}
                            <div>
                              <div className="text-[10px] text-on-surface-variant/40 uppercase tracking-wider">Token Address</div>
                              <div className="font-mono text-on-surface/80 mt-1 text-[11px] break-all">{n.tokenAddress}</div>
                            </div>
                          </div>
                        </div>

                        {/* Linked trades + change notes */}
                        {(() => {
                          const linkedOrders = orderFiles.filter((o) => o.order?.leafIndex === n.leafIndex);
                          if (linkedOrders.length === 0 && changeNotes.length === 0) return null;
                          return (
                            <div className="mt-3 pt-3 border-t border-outline-variant/10 space-y-3">
                              {linkedOrders.length > 0 && (
                                <div>
                                  <h4 className="text-xs font-bold text-on-surface-variant mb-2">Trade History</h4>
                                  <div className="space-y-1">
                                    {linkedOrders.map((o, oi) => (
                                      <button
                                        key={oi}
                                        onClick={(e) => { e.stopPropagation(); setSelectedTrade(o as unknown as TradeData); }}
                                        className="w-full text-left"
                                      >
                                        <TradeDetail trade={o as unknown as TradeData} compact />
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {changeNotes.length > 0 && (
                                <div>
                                  {changeNotes.map((cn) => (
                                    <div key={cn.commitment} className="bg-amber-500/5 border border-amber-500/15 rounded-lg px-4 py-3 flex items-center justify-between">
                                      <div className="flex items-center gap-3">
                                        <Coins className="w-4 h-4 text-amber-400" />
                                        <div>
                                          <div className="text-sm font-semibold text-amber-400">
                                            {cn.amount} {cn.tokenSymbol}
                                          </div>
                                          <div className="text-xs text-on-surface-variant/50">
                                            Change · Trade in progress...
                                          </div>
                                        </div>
                                      </div>
                                      <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold border bg-amber-500/15 text-amber-400 border-amber-500/20">
                                        Pending
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                  );
                })}

                {/* Change notes from settled trades — shown as independent escrow entries.
                    Once the parent escrow is spent AND all its claims are done, the change
                    commitment is effectively a finalized balance for the user, so we drop
                    the amber "Change" styling and surface it as a regular commitment entry. */}
                {notes.filter((cn) => {
                  if (cn.leafIndex !== -1) return false;
                  // Hide change entries when the user hid them (toggle
                  // controlled by `showHidden`) — keeps the change list
                  // consistent with the parent note list above.
                  if (!showHidden && hiddenNotes.has(cn.commitment)) return false;
                  // Show as independent entry only when parent note is spent
                  return notes.some((parent) =>
                    parent.leafIndex >= 0 &&
                    parent.note.ownerSecret === cn.note.ownerSecret &&
                    parent.commitment !== cn.commitment &&
                    spentNotes.has(parent.commitment)
                  );
                }).map((cn) => {
                  const parent = notes.find((p) =>
                    p.leafIndex >= 0 &&
                    p.note.ownerSecret === cn.note.ownerSecret &&
                    p.commitment !== cn.commitment &&
                    spentNotes.has(p.commitment)
                  );
                  const finalized = !!parent && allClaimsDone[parent.leafIndex] === true;
                  return (
                    <div key={cn.commitment} className="px-6 py-4 flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${finalized ? "bg-primary/10" : "bg-amber-500/10"}`}>
                          {finalized
                            ? <Lock className="w-5 h-5 text-primary" />
                            : <Coins className="w-5 h-5 text-amber-400" />}
                        </div>
                        <div>
                          <div className="font-semibold text-on-surface">
                            {cn.amount} {cn.tokenSymbol}
                          </div>
                          <div className="text-xs text-on-surface-variant/50">
                            {finalized ? "Commitment" : "Change"} &middot; {new Date(cn.createdAt).toLocaleDateString()}
                          </div>
                        </div>
                      </div>
                      <span className={`text-xs px-2 py-1 rounded font-medium ${finalized ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-400"}`}>
                        {finalized ? "Active" : "Change"}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right: Deposit */}
        <div className="col-span-12 lg:col-span-4">
          <div className="glass-card rounded-xl p-8 border border-outline-variant/10">
            <h3 className="font-headline text-xl font-bold mb-6 text-on-surface">
              Private Deposit
            </h3>

            <div className="space-y-6">
              <div>
                <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Token</label>
                <select
                  value={depositTokenIdx}
                  onChange={(e) => setDepositTokenIdx(Number(e.target.value))}
                  disabled={isBusy}
                  className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md py-2.5 px-3 disabled:opacity-50"
                >
                  {tokens.map((t, i) => (
                    <option key={`${t.symbol}-${i}`} value={i}>{t.symbol}</option>
                  ))}
                </select>
                {walletBalance !== null && selectedToken && (
                  <div className="mt-2 text-[10px] text-on-surface-variant">
                    Wallet: {walletBalance} {selectedToken.symbol}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Amount</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  disabled={isBusy}
                  className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md text-lg font-mono py-2.5 px-3 disabled:opacity-50"
                  placeholder="0.00"
                />
              </div>

              {txState === "deriving_key" && (
                <div className="flex items-center gap-2 text-xs text-on-surface-variant">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Unlocking trading key...
                </div>
              )}
              {txState === "approving" && (
                <div className="flex items-center gap-2 text-xs text-on-surface-variant">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Approving token...
                </div>
              )}
              {txState === "depositing" && (
                <div className="flex items-center gap-2 text-xs text-on-surface-variant">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Creating private commitment...
                </div>
              )}
              {txState === "error" && txError && (
                <div className="text-xs p-3 rounded-md bg-error/5 text-error truncate">{txError}</div>
              )}
              {txState === "success" && (
                <div className="text-xs p-3 rounded-md bg-tertiary/5 text-tertiary space-y-2">
                  <div>Deposit successful! Note saved to folder.</div>
                  {txHash && (
                    <div className="flex items-center gap-2 text-on-surface-variant/50">
                      <ExplorerLink kind="tx" value={txHash} chainId={chainId} />
                      <button
                        onClick={() => navigator.clipboard.writeText(txHash)}
                        className="shrink-0 hover:text-on-surface transition-colors"
                        title="Copy tx hash"
                      >
                        📋
                      </button>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Link
                      href="/trade/private-order"
                      className="px-3 py-1.5 rounded-md bg-primary/20 text-primary text-[11px] font-semibold hover:bg-primary/30 transition-colors"
                    >
                      Create Order →
                    </Link>
                    <Link
                      href="/trade/private-history"
                      className="px-3 py-1.5 rounded-md bg-surface-bright text-on-surface text-[11px] font-medium hover:bg-surface-bright/80 transition-colors"
                    >
                      View History
                    </Link>
                  </div>
                </div>
              )}

              <button
                onClick={handleDeposit}
                disabled={isBusy || !depositAmount || !folderReady}
                className="w-full gradient-btn text-on-primary-fixed py-4 rounded-md font-bold text-sm uppercase tracking-widest hover:scale-[0.99] active:scale-95 transition-all disabled:opacity-50 disabled:pointer-events-none"
              >
                {!folderReady ? "Select Folder First" : isBusy ? "Processing..." : "Deposit Privately"}
              </button>

              <div className="text-xs text-on-surface-variant/40 text-center">
                Notes are saved as JSON files in your selected folder.
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Trade Detail Modal */}
      {selectedTrade && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setSelectedTrade(null)}>
          <div className="w-full max-w-lg mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="glass-card rounded-2xl border border-outline-variant/20 shadow-2xl overflow-hidden">
              <div className="flex items-center justify-between px-6 py-4 border-b border-outline-variant/10">
                <h3 className="text-lg font-headline font-bold text-on-surface">Trade Detail</h3>
                <button onClick={() => setSelectedTrade(null)} className="text-on-surface-variant/50 hover:text-on-surface text-xl transition-colors">✕</button>
              </div>
              <div className="p-4">
                <TradeDetail trade={selectedTrade} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
