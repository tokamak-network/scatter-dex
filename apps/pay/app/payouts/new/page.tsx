"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import { LAUNCH_TOKENS } from "@zkscatter/sdk";
import {
  splitPayout,
  type PayoutBatch,
  pickTier,
  ACTIVE_TIERS,
  TIERS,
  type CircuitTier,
} from "@zkscatter/sdk/zk";
import {
  finalizeRealSettle,
  prepareRealSettle,
  submitRealSettle,
  type PreparedSettle,
} from "../../_lib/realSettle";
import { useCommitmentTree } from "../../_lib/commitmentTree";
import { authorizeProver } from "../../_lib/authorizeProver";
import { type ClaimPackage } from "@zkscatter/sdk/notes";
import { Field } from "@zkscatter/ui";
import { buildRunRecord } from "./_buildRunRecord";
import {
  ConfirmLargeAmount,
  ReviewRow,
  Stepper,
  Toggle,
} from "./_components/wizardChrome";
import { BalancePanel, FundsStep } from "./_components/FundsStep";
import {
  DepositCancelled,
  realDeposit,
  type DepositPhase,
} from "../../_lib/realDeposit";

// Largest tier with a live verifier — caps each individual settlement
// transaction's anonymity set. With multi-batch (Phase 1d-α) each
// batch is one settlement. `splitPayout` chunks by the SDK's fixed
// `MAX_CLAIMS_PER_SIDE` constant, which today equals this value
// (`TIER_16.cap = 16`); the two will diverge once a larger live tier
// ships and `splitPayout` is taught to chunk per the picked tier.
const MAX_TIER_CAP = ACTIVE_TIERS[ACTIVE_TIERS.length - 1]!.cap;
// Soft cap on batches per run. Each batch = one signed scatterDirectAuth
// tx + one source note from the vault. 4 keeps proving wall-clock
// reasonable (~5–9s mobile × 4 ≈ 20–36s) and the user signs four
// times in sequence — beyond that the UX gets unwieldy without a
// progress indicator + parallel proving. Not a contract / SDK limit;
// bumping is purely a UX call.
const MAX_BATCHES_PER_RUN = 4;
// Effective per-run recipient cap: 4 batches × 16 = 64 recipients.
const MAX_RECIPIENTS_PER_RUN = MAX_TIER_CAP * MAX_BATCHES_PER_RUN;
// Tiers known to the SDK but not yet wired on-chain — used to surface
// the roadmap signal in user-facing validation messages without hard-
// coding "64 / 128" copy that drifts as tiers ship.
const PLANNED_TIER_CAPS = TIERS.filter((t) => !ACTIVE_TIERS.includes(t)).map((t) => t.cap);
import { useWallet } from "@zkscatter/sdk/react";
import {
  loadRun,
  saveRun,
  type RecipientRow,
  type RunRecord,
} from "@zkscatter/sdk/storage";
import {
  mergeResumedClaimPackages,
  partialRunStats,
  recipientsToCsv,
} from "../../_lib/resumeRun";
import { useVault } from "../../_lib/vault";
import { useEdDSAKey } from "@zkscatter/sdk/react";
import { useRelayers } from "../../_lib/relayers";
import { getNetworkConfig, isNetworkConfigured } from "../../_lib/network";
import { csvSafeLabel, parseAmount, parseRecipientRows, toIsoDate } from "../../_lib/format";
import {
  autoPickSourceNotes,
  describeBatchFitError,
  pickPerBatchNotes,
  summarizeBalance,
  type SourceNotesPick,
} from "../../_lib/sourceNotes";
import { useWalletBook } from "../../_lib/walletBook";
import { AddressBookPicker } from "../../_components/AddressBookPicker";
import { WorkspaceBar } from "../../_components/WorkspaceBar";
import { useFolderStorage } from "../../_lib/folderStorage";
import type { WalletEntry } from "@zkscatter/sdk/storage";
import type { RelayerInfo } from "@zkscatter/sdk/relayer";

import { REASON_PLACEHOLDER, TEMPLATES, type TemplateId } from "./_templates";

import type { RecipientRow as Row } from "../../_lib/format";

// Default cap on what the relayer can deduct as a fee. Lives here
// until the org-settings page lands; the wizard exposes it as an
// override in the Funds step.
const DEFAULT_MAX_FEE_BPS = 30;

// TODO: read from org settings
const LARGE_AMOUNT_THRESHOLD = 50_000;

function today(): string {
  return toIsoDate(new Date());
}

/** Pay ships as a static export, so `useSearchParams` (used to read
 *  `?resume=<id>` for the resume-partial-run flow) needs a Suspense
 *  boundary or Next 15's prerender bails out — same pattern as the
 *  `/payouts/detail` page. */
export default function NewPayoutPage() {
  return (
    <Suspense
      fallback={
        <p className="text-sm text-[var(--color-text-muted)]">Loading payout…</p>
      }
    >
      <NewPayout />
    </Suspense>
  );
}

type ResumeState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; record: RunRecord; unsettled: RecipientRow[] }
  | { kind: "error"; message: string };

function NewPayout() {
  const searchParams = useSearchParams();
  const resumeId = searchParams?.get("resume") ?? undefined;
  const [resume, setResume] = useState<ResumeState>(
    resumeId ? { kind: "loading" } : { kind: "idle" },
  );
  const resumeRecord = resume.kind === "ready" ? resume.record : null;
  const resumeUnsettled = resume.kind === "ready" ? resume.unsettled : null;

  const [step, setStep] = useState(1);
  const [templateId, setTemplateId] = useState<TemplateId>("payroll");
  const template = TEMPLATES.find((t) => t.id === templateId)!;

  const [label, setLabel] = useState(template.defaultLabel);
  const [token, setToken] = useState(template.defaultToken);
  const [chain, setChain] = useState("Sepolia");
  const [csv, setCsv] = useState(template.sampleCsv);
  const [stealth, setStealth] = useState(true);
  const [notify, setNotify] = useState(true);
  const [reason, setReason] = useState("");
  const [claimFrom, setClaimFrom] = useState<string>();
  const [maxFeeBps, setMaxFeeBps] = useState(DEFAULT_MAX_FEE_BPS);
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const router = useRouter();

  const { account, chainId, signer } = useWallet();
  const tree = useCommitmentTree();
  const vault = useVault();
  const { notes, loaded: vaultLoaded } = vault;
  const {
    relayers,
    selected: relayer,
    select: selectRelayer,
    registryConfigured,
  } = useRelayers();
  const eddsa = useEdDSAKey();
  const walletBook = useWalletBook();
  const folder = useFolderStorage();
  const [showBookPicker, setShowBookPicker] = useState(false);

  const addressBookHint = !folder.ready
    ? "Pick a notes folder to load your address book."
    : !walletBook.loaded
      ? "Loading your address book…"
      : walletBook.corrupt
        ? "Address book file is corrupt — repair it from /recipients."
        : walletBook.entries.length === 0
          ? "Add recipients in /recipients first."
          : null;

  // Deposit progress state — `null` between attempts, set by
  // `realDeposit`'s `onPhase` callback during a run, retained on
  // `done` / `error` so the operator sees the outcome until they
  // start a new deposit.
  const [depositPhase, setDepositPhase] = useState<DepositPhase | null>(null);
  // Synchronous re-entry guard. State updates are async — two clicks
  // in the same render frame would both pass a `depositPhase`-only
  // check and start two deposits (double approve + double gas).
  // The ref flips before any await, so the second click bails out
  // immediately even though the corresponding state hasn't flushed.
  const depositInFlightRef = useRef(false);
  // AbortController per attempt — Cancel from <DepositProgress>
  // signals the in-flight realDeposit to bail at its next checkpoint.
  // Null between attempts.
  const depositAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setClaimFrom(today());
  }, []);

  // Resume only starts once the notes folder is mounted — the run
  // lives there. Template / token / label / claim-from edits are
  // locked downstream so the merged record stays a faithful
  // continuation of the original.
  useEffect(() => {
    if (!resumeId) return;
    if (!folder.ready) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await loadRun(resumeId);
        if (cancelled) return;
        if (!r) {
          setResume({ kind: "error", message: `Run ${resumeId} not found in this folder.` });
          return;
        }
        const { partial, unsettled } = partialRunStats(r);
        if (!partial) {
          setResume({
            kind: "error",
            message:
              "This run isn't partial — every recipient already has a claim package. Open the dashboard to share links.",
          });
          return;
        }
        const tpl = TEMPLATES.find((t) => t.id === r.category) ?? TEMPLATES[0]!;
        setTemplateId(tpl.id);
        setLabel(r.label);
        setToken(r.tokenSymbol);
        setCsv(recipientsToCsv(unsettled));
        // `claimFrom` on RecipientRow is per-row Unix seconds set
        // from `new Date("YYYY-MM-DD").getTime()` (UTC midnight).
        // Round-trip with UTC getters so non-UTC operators don't
        // see the date shift by a day. Any row carries the same
        // value, so the first one with the field is enough.
        const firstClaimFrom = unsettled.find((u) => u.claimFrom)?.claimFrom;
        if (firstClaimFrom) {
          setClaimFrom(new Date(firstClaimFrom * 1000).toISOString().slice(0, 10));
        }
        setStep(4);
        setResume({ kind: "ready", record: r, unsettled });
      } catch (err) {
        if (cancelled) return;
        setResume({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resumeId, folder.ready]);

  async function doSubmit() {
    setShowConfirm(false);
    setSubmitting(true);
    setSubmitError(null);
    let txHash: string | undefined;
    let claimPackages: ClaimPackage[] | undefined;
    try {
      const cfg = getNetworkConfig();
      // Real submit is only attempted when the network is wired AND
      // the wizard has all the dependencies a single-batch
      // scatterDirectAuth needs. The env-not-configured path stays as
      // a record-only demo so the dashboard still has something to
      // render in unwired environments.
      // Persist what we have so far. Returns the saved record's id
      // so the caller can navigate. `allowFailure` swallows the
      // save error on the partial-recovery path so we re-throw the
      // batch error rather than masking it with a save failure.
      const persist = async (allowFailure: boolean): Promise<string | null> => {
        if (!folder.ready) return null;
        // Resume path keeps one RunRecord per logical payout — the
        // helper stamps new claim packages onto the original by
        // `rowIndex` so already-issued packages stay intact and a
        // mid-loop failure leaves the remaining recipients pickable
        // by a follow-up resume. `settledAt` / `txHash` only advance
        // when this attempt actually produced something on-chain;
        // otherwise the dashboard would show a freshly-stamped
        // submission timestamp for a no-op resume (e.g. batch 1
        // failed before sending, or the env-not-configured demo
        // path).
        const advanced =
          (claimPackages?.length ?? 0) > 0 ||
          (!!txHash && !!resumeRecord && txHash !== resumeRecord.txHash);
        const record: RunRecord = resumeRecord
          ? mergeResumedClaimPackages({
              existing: resumeRecord,
              newPackages: claimPackages ?? [],
              txHash: advanced ? (txHash ?? resumeRecord.txHash) : resumeRecord.txHash,
              settledAt: advanced ? Math.floor(Date.now() / 1000) : resumeRecord.settledAt,
            })
          : buildRunRecord({
              templateId,
              label,
              token,
              tokenAddress,
              operatorAddress: account,
              chainId,
              rows,
              total,
              claimFrom,
              walletBook: walletBook.entries,
              txHash,
              claimPackages,
            });
        try {
          await saveRun(record);
          return record.id;
        } catch (saveErr) {
          if (!allowFailure) throw saveErr;
          console.warn("[Pay] partial run record save failed", saveErr);
          return null;
        }
      };

      if (isNetworkConfigured(cfg) && tokenAddress && batches.length > 0) {
        if (batches.length > MAX_BATCHES_PER_RUN) {
          throw new Error(
            `This run needs ${batches.length} settlement transactions; Pay caps at ${MAX_BATCHES_PER_RUN} per payout. Split into multiple runs.`,
          );
        }
        // Block signing when no notes folder is picked. The settle
        // would land on-chain but we'd have no place to persist the
        // RunRecord / ClaimPackages, permanently losing recipient
        // claim links — the `if (!folder.ready)` redirect-to-sample
        // at the bottom of doSubmit assumes nothing settled.
        if (!folder.ready) {
          throw new Error(
            "Pick a notes folder in the dashboard before signing — without it, your settled run can't persist the claim links recipients need.",
          );
        }
        if (!signer) throw new Error("Connect a wallet before signing.");
        if (!relayer) throw new Error("Pick a relayer in the Funds step.");
        if (!multiBatchFit?.covered) {
          const reason = multiBatchFit?.reason;
          if (reason) {
            const { title, body } = describeBatchFitError(reason, batches.length);
            throw new Error(`${title} — ${body}`);
          }
          throw new Error("No source notes cover this run — top up in the Funds step.");
        }
        // Overlap EdDSA derivation with worker boot + asset warm-up.
        // The zkey is ~19 MB; on cold cache its fetch dwarfs the
        // ECDSA-derive wallet round-trip.
        const [kp] = await Promise.all([eddsa.derive(), authorizeProver.ready()]);
        // Multi-batch pipeline: prove (queued, single-threaded) → sign
        // + send (sequential, signer-exclusive + monotonic nonces) →
        // receipts (parallel). The previous serial loop blocked
        // prove(i+1) on receipt(i); queueing all proves up front lets
        // the worker drain them while user-sign + receipt waits run
        // in the foreground. Each batch consumes a distinct source
        // note (change from batch i lands with leafIndex=-1, not
        // re-spendable in this run) so a reverted batch j doesn't
        // forfeit batch k's source — every fulfilled finalize gets
        // its vault update applied.
        const settlementAddress = cfg.contracts.privateSettlement;
        const settleArgs = (i: number) => ({
          batch: batches[i]!,
          tokenAddress,
          tokenSymbol: token,
          tokenDecimals: decimals,
          source: multiBatchFit.byBatch[i]!,
          relayer,
          chain: { signer, settlementAddress, chainId: cfg.chainId },
          maxFeeBps: safeMaxFeeBps,
          eddsaPrivateKey: kp.privateKey,
          tree,
          labels: { sender: account ?? undefined, run: label },
        });

        const preparePromises: Promise<PreparedSettle>[] = batches.map((_, i) =>
          prepareRealSettle(settleArgs(i)),
        );
        // Phase 2 may break before awaiting every prep promise; mark
        // them all handled so a later prep failure isn't logged as
        // an unhandled rejection. The actual error surfaces via the
        // await in Phase 2.
        preparePromises.forEach((p) => p.catch(() => undefined));

        const submitted: {
          tx: ethers.TransactionResponse;
          ctx: PreparedSettle["ctx"];
          spentNoteId: string;
        }[] = [];
        let partialBatchError: Error | null = null;
        for (let i = 0; i < batches.length; i++) {
          try {
            const prep = await preparePromises[i]!;
            const sent = await submitRealSettle(prep, signer);
            submitted.push({
              tx: sent.tx,
              ctx: sent.ctx,
              spentNoteId: multiBatchFit.byBatch[i]!.note.id,
            });
          } catch (err) {
            partialBatchError = err instanceof Error ? err : new Error(String(err));
            break;
          }
        }

        const aggClaimPackages: ClaimPackage[] = [];
        let lastTxHash: string | undefined;
        const finalized = await Promise.allSettled(
          submitted.map(({ tx, ctx }) => finalizeRealSettle(tx, ctx)),
        );
        for (let i = 0; i < finalized.length; i++) {
          const r = finalized[i]!;
          if (r.status !== "fulfilled") {
            if (!partialBatchError) {
              partialBatchError =
                r.reason instanceof Error ? r.reason : new Error(String(r.reason));
            }
            continue;
          }
          lastTxHash = r.value.txHash;
          aggClaimPackages.push(...r.value.claimPackages);
          if (r.value.change) {
            await vault.add({
              symbol: token,
              amount: ethers.formatUnits(r.value.change.amount, decimals),
              note: r.value.change.note,
              commitment: r.value.change.commitment,
              txHash: r.value.txHash,
            });
          }
          await vault.remove(submitted[i]!.spentNoteId);
        }

        txHash = lastTxHash;
        claimPackages = aggClaimPackages;
        if (partialBatchError) {
          await persist(/* allowFailure */ true);
          throw partialBatchError;
        }
      }

      if (!folder.ready) {
        // No notes folder picked → can't persist the run record.
        // Fall back to the sample so the dashboard still has
        // something to render.
        router.push("/payouts/detail?id=p_2026_04_payroll");
        return;
      }

      const savedId = await persist(/* allowFailure */ false);
      if (savedId) {
        router.push(`/payouts/detail?id=${encodeURIComponent(savedId)}`);
      }
    } catch (err) {
      console.error("[Pay] settle failed", err);
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function appendFromAddressBook(picked: WalletEntry[]) {
    if (picked.length === 0) return;
    // Reuse the wizard's already-parsed `rows` so we don't re-derive
    // the address column from raw CSV (which would shift if a future
    // template adds quoted fields). `eqAddr` handles checksum / case.
    const seen = new Set(rows.map((r) => r.address.toLowerCase()).filter(Boolean));
    const rowsToAdd = picked
      .filter((e) => !seen.has(e.address.toLowerCase()))
      .map((e) => `${csvSafeLabel(e.label)},${e.address},`);
    if (rowsToAdd.length === 0) return;
    const trimmed = csv.trimEnd();
    setCsv(trimmed.length > 0 ? `${trimmed}\n${rowsToAdd.join("\n")}` : rowsToAdd.join("\n"));
  }

  function pickTemplate(id: TemplateId) {
    const t = TEMPLATES.find((x) => x.id === id)!;
    setTemplateId(id);
    setLabel(t.defaultLabel);
    setToken(t.defaultToken);
    setCsv(t.sampleCsv);
    setReason("");
  }

  const rows: Row[] = useMemo(() => {
    return csv
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const parts = l.split(",").map((x) => (x ?? "").trim());
        return { name: parts[0] ?? "", address: parts[1] ?? "", amount: parts[2] ?? "" };
      })
      .filter((r) => r.address.length > 0);
  }, [csv]);

  const total = useMemo(
    () => rows.reduce((sum, r) => {
      const n = parseAmount(r.amount);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0),
    [rows],
  );

  const tokenInfo = LAUNCH_TOKENS[token];
  const tokenAddress = tokenInfo?.address?.toLowerCase();
  const decimals = tokenInfo?.decimals ?? 18;

  const { availableRaw, pendingRaw } = useMemo(
    () => (tokenAddress ? summarizeBalance(notes, tokenAddress) : { availableRaw: 0n, pendingRaw: 0n }),
    [notes, tokenAddress],
  );

  // Sum per-row bigints rather than going through the JS-float
  // `total`; otherwise 0.1 + 0.2 = 0.30000000000000004 turns into a
  // bigint shortfall that doesn't match what gets settled.
  const requiredRaw = useMemo<bigint>(() => {
    let sum = 0n;
    for (const r of rows) {
      const cleaned = r.amount.replace(/[,_\s]/g, "");
      if (!/^\d+(\.\d+)?$/.test(cleaned)) return 0n;
      try {
        sum += ethers.parseUnits(cleaned, decimals);
      } catch {
        return 0n;
      }
    }
    return sum;
  }, [rows, decimals]);

  // Fee at the user-set cap so "Required to escrow" never under-counts.
  // Sanitize first — browser number inputs can carry transient decimal
  // values (e.g. mid-typing "1.5"); `BigInt(1.5)` throws.
  const safeMaxFeeBps = Number.isFinite(maxFeeBps) ? Math.max(0, Math.trunc(maxFeeBps)) : 0;
  const feeRaw = (requiredRaw * BigInt(safeMaxFeeBps)) / 10_000n;
  const totalEscrowRaw = requiredRaw + feeRaw;
  const shortfallRaw = totalEscrowRaw > availableRaw ? totalEscrowRaw - availableRaw : 0n;

  const sourcePick = useMemo<SourceNotesPick>(
    // Pre-filter to reconciled notes so the displayed pick matches
    // what `pickPerBatchNotes` + realSettle can actually spend; an
    // unreconciled note in the auto-pick would silently advertise
    // coverage the proof path has to reject.
    () =>
      autoPickSourceNotes(
        notes.filter((n) => n.leafIndex >= 0),
        tokenAddress ?? "",
        totalEscrowRaw,
      ),
    [notes, tokenAddress, totalEscrowRaw],
  );

  const batches = useMemo<PayoutBatch[]>(() => {
    if (!tokenAddress || rows.length === 0 || !claimFrom) return [];
    try {
      const recipients = parseRecipientRows(rows, decimals, claimFrom);
      return splitPayout(recipients, { token: tokenAddress });
    } catch {
      return [];
    }
  }, [rows, tokenAddress, decimals, claimFrom]);

  // Pre-flight the multi-batch picker so the Funds step can warn
  // BEFORE Sign — without this, the user sees "covered" via
  // sourcePick (which sums totals across all notes) but doSubmit
  // throws at sign time because pickPerBatchNotes also requires
  // each batch to fit in a single reconciled note.
  const multiBatchFit = useMemo(() => {
    if (!tokenAddress || batches.length === 0) return null;
    return pickPerBatchNotes(notes, batches, tokenAddress);
  }, [notes, batches, tokenAddress]);

  // The tier governs each batch's anonymity set. Multi-batch runs
  // settle one batch per `scatterDirectAuth` tx; every batch shares
  // the same tier (the largest available — TIER_16 today). Returns
  // null only on an empty list; the `MAX_RECIPIENTS_PER_RUN` ceiling
  // is enforced by `validation` below.
  const tier = useMemo<CircuitTier | null>(() => {
    if (rows.length === 0) return null;
    const picked = pickTier(Math.min(rows.length, MAX_TIER_CAP));
    return ACTIVE_TIERS.includes(picked) ? picked : null;
  }, [rows.length]);

  const validation = useMemo(() => {
    const issues: string[] = [];
    // Cap-exceeded comes first because it blocks the run regardless of
    // per-row fixes — and slice(0, 5) below would otherwise hide it
    // behind five ordinary validation errors.
    if (rows.length > MAX_RECIPIENTS_PER_RUN) {
      const roadmap = PLANNED_TIER_CAPS.length > 0
        ? ` Larger circuits (${PLANNED_TIER_CAPS.join(" / ")}) are planned — for now, split into multiple runs.`
        : "";
      issues.push(
        `Pay supports up to ${MAX_RECIPIENTS_PER_RUN} recipients per payout (${MAX_BATCHES_PER_RUN} batches × ${MAX_TIER_CAP}).${roadmap}`,
      );
    }
    const seen = new Set<string>();
    for (const r of rows) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(r.address)) {
        issues.push(`Invalid address: ${r.address || "(empty)"}`);
      } else if (seen.has(r.address.toLowerCase())) {
        issues.push(`Duplicate address: ${r.address}`);
      }
      seen.add(r.address.toLowerCase());
      const n = parseAmount(r.amount);
      if (!r.amount || !Number.isFinite(n) || n <= 0) {
        issues.push(`Invalid amount for ${r.name || r.address}`);
      }
    }
    return issues.slice(0, 5);
  }, [rows]);

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
        <Link href="/" className="hover:text-[var(--color-text)]">Payouts</Link>
        <span>/</span>
        <span>New</span>
      </div>

      <WorkspaceBar />

      {resume.kind === "error" && (
        <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
          <strong className="mb-0.5 block">Couldn&apos;t load run to resume</strong>
          {resume.message}
        </div>
      )}
      {resume.kind === "loading" && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
          Loading partial run…
        </div>
      )}
      {resume.kind === "ready" && resumeUnsettled && (
        <div className="rounded-md border border-[var(--color-primary)] bg-[var(--color-primary-soft)] p-3 text-xs">
          <div className="font-semibold">
            Resuming partial run — {resumeUnsettled.length} of{" "}
            {resume.record.recipients.length} recipients still need their claim
            package
          </div>
          <div className="mt-1 text-[var(--color-text-muted)]">
            Template, label, token, and recipient list are locked so the
            merged record stays a faithful continuation. Pick fresh source
            notes in the Funds step — vault state has shifted since the
            original run.
          </div>
        </div>
      )}

      <Stepper step={step} onJump={setStep} />

      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        {step === 1 && (
          <div className="space-y-5">
            <div>
              <h2 className="text-lg font-semibold">Choose a template</h2>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                Templates pre-fill labels, sample data, and export format. You can change anything later.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  disabled={!!resumeRecord}
                  onClick={() => pickTemplate(t.id)}
                  className={`rounded-xl border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                    templateId === t.id
                      ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)]"
                      : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-border-strong)]"
                  }`}
                >
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-primary)]">
                    {t.name}
                  </div>
                  <div className="mt-1 font-semibold">{t.tagline}</div>
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">{t.body}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Token</h2>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Run label">
                <input
                  value={label}
                  disabled={!!resumeRecord}
                  onChange={(e) => setLabel(e.target.value)}
                  className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </Field>
              <Field label="Chain">
                <select
                  value={chain}
                  onChange={(e) => setChain(e.target.value)}
                  className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
                >
                  <option>Ethereum</option>
                  <option>Sepolia</option>
                  <option>Titan Sepolia</option>
                  <option>Local:8545</option>
                </select>
              </Field>
              <Field label="Token">
                <select
                  value={token}
                  disabled={!!resumeRecord}
                  onChange={(e) => setToken(e.target.value)}
                  className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <option>USDC</option>
                  <option>USDT</option>
                  <option>ETH</option>
                  <option>TON</option>
                </select>
              </Field>
            </div>
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
              Sender = the wallet connected in the header. Pay spends your
              already-deposited notes — the wallet only signs the proof, no
              transfer-from happens at sign time. Top up the source notes in
              the Funds step.
            </div>
            <BalancePanel
              token={token}
              decimals={decimals}
              availableRaw={availableRaw}
              requiredRaw={0n}
              shortfallRaw={0n}
              account={account}
              vaultLoaded={vaultLoaded}
              showRequired={false}
              onDeposit={() => undefined}
            />
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Recipients</h2>
              <div className="flex flex-col items-end gap-1 text-xs">
                <div className="flex gap-2">
                  <button
                    onClick={() => addressBookHint === null && setShowBookPicker(true)}
                    aria-disabled={addressBookHint !== null}
                    aria-describedby={addressBookHint ? "abp-hint" : undefined}
                    onMouseDown={(e) => addressBookHint !== null && e.preventDefault()}
                    className={`rounded border border-[var(--color-border-strong)] px-2 py-1 hover:bg-[var(--color-primary-soft)] ${
                      addressBookHint !== null ? "opacity-40" : ""
                    }`}
                  >
                    + Add from address book
                  </button>
                  <button className="rounded border border-[var(--color-border-strong)] px-2 py-1">Upload CSV</button>
                  <button className="rounded border border-[var(--color-border-strong)] px-2 py-1">Import from Safe</button>
                </div>
                {addressBookHint && (
                  <span id="abp-hint" className="text-[10px] text-[var(--color-text-subtle)]">
                    {addressBookHint}
                  </span>
                )}
              </div>
            </div>
            <div className="text-xs text-[var(--color-text-muted)]">
              Format: <span className="font-mono">{template.identifierLabel.toLowerCase()},address,amount</span> — one per line.
            </div>
            <textarea
              value={csv}
              readOnly={!!resumeRecord}
              onChange={(e) => setCsv(e.target.value)}
              rows={8}
              className="w-full rounded-md border border-[var(--color-border-strong)] bg-white p-3 font-mono text-sm read-only:cursor-not-allowed read-only:opacity-70"
              placeholder={`${template.identifierLabel.toLowerCase()},address,amount`}
            />
            {template.reasonLabel && (
              <Field label={template.reasonLabel}>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={REASON_PLACEHOLDER[template.id]}
                  className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
                />
              </Field>
            )}
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
              <div className="mb-2 text-xs font-semibold text-[var(--color-text-muted)]">Preview</div>
              <table className="w-full text-sm">
                <thead className="text-xs text-[var(--color-text-subtle)]">
                  <tr>
                    <th className="text-left">{template.identifierLabel}</th>
                    <th className="text-left">Address</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.address}-${i}`} className="border-t border-[var(--color-border)]">
                      <td className="py-1.5">{r.name}</td>
                      <td className="py-1.5 font-mono text-xs">{r.address.slice(0, 10)}…{r.address.slice(-4)}</td>
                      <td className="py-1.5 text-right font-mono">{r.amount} {token}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-3 flex justify-between text-sm">
                <span className="text-[var(--color-text-muted)]">{rows.length} recipients</span>
                <span className="font-semibold">{total.toLocaleString()} {token}</span>
              </div>
            </div>
            {validation.length > 0 && (
              <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
                <div className="mb-1 font-semibold">Fix before continuing</div>
                <ul className="list-disc space-y-0.5 pl-4">
                  {validation.map((v) => <li key={v}>{v}</li>)}
                </ul>
              </div>
            )}

            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
              <h3 className="text-sm font-semibold">Claim schedule</h3>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                When can recipients start claiming? All recipients use the same
                date for now — per-row overrides arrive in a later release.
              </p>
              <div className="mt-3 max-w-xs">
                <Field label="Available from">
                  <input
                    type="date"
                    value={claimFrom ?? ""}
                    min={claimFrom ?? ""}
                    disabled={!!resumeRecord}
                    onChange={(e) => setClaimFrom(e.target.value)}
                    className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </Field>
              </div>
              <p className="mt-2 text-[10px] text-[var(--color-text-subtle)]">
                Recipients can claim any time after this date — there is no expiry.
              </p>
            </div>

            <div className="space-y-2 text-sm">
              <Toggle checked={stealth} onChange={setStealth} label="Send via stealth address (recipients can't be linked on-chain)" />
              <Toggle checked={notify} onChange={setNotify} label="Notify recipients by email / Discord" />
            </div>
          </div>
        )}

        {step === 4 && (
          <FundsStep
            funds={{
              token,
              decimals,
              requiredRaw,
              feeRaw,
              totalEscrowRaw,
              availableRaw,
              pendingRaw,
              shortfallRaw,
            }}
            pick={{ sourcePick, batchCount: batches.length, multiBatchFit }}
            wallet={{ account, vaultLoaded }}
            relayer={{
              list: relayers,
              selected: relayer,
              registryConfigured,
              select: selectRelayer,
              maxFeeBps,
              setMaxFeeBps,
            }}
            onDeposit={() => {
              // Synchronous lock first — state-based checks would
              // race a same-frame double-click and start two flows.
              if (depositInFlightRef.current) return;
              if (!signer || !account) return;
              depositInFlightRef.current = true;
              const ctrl = new AbortController();
              depositAbortRef.current = ctrl;
              setDepositPhase({ kind: "preparing" });
              realDeposit({
                tokenSymbol: token,
                amountRaw: shortfallRaw,
                account,
                signer,
                eddsa,
                vault,
                onPhase: setDepositPhase,
                signal: ctrl.signal,
              })
                .catch((err) => {
                  if (err instanceof DepositCancelled) {
                    setDepositPhase({ kind: "cancelled" });
                    return;
                  }
                  console.error("[Pay] realDeposit failed", err);
                  setDepositPhase({
                    kind: "error",
                    error: err instanceof Error ? err.message : String(err),
                  });
                })
                .finally(() => {
                  depositInFlightRef.current = false;
                  depositAbortRef.current = null;
                });
            }}
          />
        )}

        {step === 4 && depositPhase && (
          <DepositProgress
            phase={depositPhase}
            onDismiss={() => setDepositPhase(null)}
            onCancel={() => depositAbortRef.current?.abort()}
          />
        )}

        {step === 5 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Review & sign</h2>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 divide-y divide-[var(--color-border)] text-sm">
              <ReviewRow k="Template" v={template.name} />
              <ReviewRow k="Label" v={label} />
              <ReviewRow k="Chain" v={chain} />
              <ReviewRow k="Token" v={token} />
              <ReviewRow k="Recipients" v={`${rows.length}`} />
              <ReviewRow k="Total" v={`${total.toLocaleString()} ${token}`} />
              <ReviewRow k="Available to claim from" v={claimFrom ?? "—"} />
              {template.reasonLabel && <ReviewRow k={template.reasonLabel} v={reason || "—"} />}
              <ReviewRow k="Stealth" v={stealth ? "Yes" : "No"} />
              <ReviewRow k="Notification" v={notify ? "Email + Discord" : "None"} />
              <ReviewRow k="Estimated gas" v="~$0.50 (one tx · varies by chain)" />
              <ReviewRow k="Scatter Pay fee" v="Free (launch event until Dec 31, 2026 · normally 0.05%, capped at $20)" />
            </dl>
            <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
              <strong className="mb-0.5 block">This cannot be reversed.</strong>
              Once signed and settled, recipients can claim any time after the
              date above — forever. The sender cannot recall a settled run.
            </div>
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
              {template.exportNote}
            </div>
            {tier && (
              <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs">
                <div className="mb-1 font-semibold text-[var(--color-text-muted)]">
                  Privacy plan
                </div>
                <div className="text-[var(--color-text-muted)]">
                  {batches.length === 1 ? (
                    <>
                      Tier {tier.cap} settlement — one private transaction with{" "}
                      <strong>{rows.length}</strong> real recipients hidden inside
                      an anonymity set of <strong>{tier.cap}</strong>. One signature.
                    </>
                  ) : (
                    <>
                      <strong>{batches.length}</strong> private transactions —
                      tier {tier.cap} per settlement, with{" "}
                      <strong>{rows.length}</strong> recipients spread across the
                      batches. One signature per batch (
                      <strong>{batches.length}</strong> total).
                    </>
                  )}
                </div>
              </div>
            )}
            <button
              disabled={validation.length > 0 || submitting}
              onClick={() => {
                if (total >= LARGE_AMOUNT_THRESHOLD) setShowConfirm(true);
                else void doSubmit();
              }}
              className="w-full rounded-lg bg-[var(--color-primary)] py-3 font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
            >
              {submitting ? "Proving + submitting…" : "Sign & submit"}
            </button>
            {submitError && (
              <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
                <strong className="mb-0.5 block">Submit failed</strong>
                {submitError}
              </div>
            )}
            <div className="text-center text-xs text-[var(--color-text-muted)]">
              You&apos;ll be asked to sign once. Recipients claim individually.
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-between">
        <button
          disabled={step === 1}
          onClick={() => setStep((s) => Math.max(1, s - 1))}
          className="rounded-md border border-[var(--color-border-strong)] px-4 py-2 text-sm disabled:opacity-40"
        >
          Back
        </button>
        {step < 5 ? (
          <button
            onClick={() => setStep((s) => s + 1)}
            className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            Next
          </button>
        ) : (
          <Link
            href="/payouts/detail?id=p_2026_04_payroll"
            className="rounded-md border border-[var(--color-border-strong)] px-4 py-2 text-sm"
          >
            View sample result →
          </Link>
        )}
      </div>

      {showConfirm && (
        <ConfirmLargeAmount
          total={total}
          token={token}
          recipients={rows.length}
          onCancel={() => setShowConfirm(false)}
          onConfirm={doSubmit}
        />
      )}
      {showBookPicker && (
        <AddressBookPicker
          entries={walletBook.entries}
          onCancel={() => setShowBookPicker(false)}
          onPick={(picked) => {
            appendFromAddressBook(picked);
            setShowBookPicker(false);
          }}
        />
      )}
    </div>
  );
}

const DEPOSIT_PHASE_COPY: Record<DepositPhase["kind"], string> = {
  preparing: "Preparing…",
  wrapping: "Wrapping ETH → WETH…",
  approving: "Approving token allowance…",
  proving: "Generating deposit proof…",
  submitting: "Submitting deposit transaction…",
  confirming: "Waiting for on-chain confirmation…",
  done: "Deposited",
  error: "Deposit failed",
  cancelled: "Deposit cancelled",
};

const TERMINAL_DEPOSIT_PHASES = new Set<DepositPhase["kind"]>([
  "done",
  "error",
  "cancelled",
]);

function DepositProgress({
  phase,
  onDismiss,
  onCancel,
}: {
  phase: DepositPhase;
  onDismiss: () => void;
  onCancel: () => void;
}) {
  const terminal = TERMINAL_DEPOSIT_PHASES.has(phase.kind);
  const isDone = phase.kind === "done";
  const isError = phase.kind === "error";
  const isCancelled = phase.kind === "cancelled";
  const tone = isDone
    ? "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-success)]"
    : isError
    ? "border-[var(--color-warning)] bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
    : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)]";
  return (
    <div className={`flex items-start gap-3 rounded-md border p-3 text-xs ${tone}`}>
      <div className="flex-1">
        <div className="font-semibold">
          {isDone ? "✓ " : ""}
          {DEPOSIT_PHASE_COPY[phase.kind]}
        </div>
        {phase.message && !terminal && (
          <div className="mt-0.5 text-[var(--color-text-subtle)]">{phase.message}</div>
        )}
        {isDone && phase.txHash && (
          <div className="mt-1 font-mono text-[10px]">{phase.txHash.slice(0, 18)}…</div>
        )}
        {isError && phase.error && <div className="mt-1">{phase.error}</div>}
        {isCancelled && (
          <div className="mt-0.5 text-[var(--color-text-subtle)]">
            Any tx already broadcast keeps confirming on-chain — Cancel only
            stops further steps.
          </div>
        )}
      </div>
      {!terminal ? (
        <button
          onClick={onCancel}
          className="rounded border border-current px-2 py-0.5 text-[10px]"
        >
          Cancel
        </button>
      ) : (
        <button
          onClick={onDismiss}
          className="rounded border border-current px-2 py-0.5 text-[10px]"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
