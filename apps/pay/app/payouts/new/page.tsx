"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ethers } from "ethers";
import { LAUNCH_TOKENS, chainName, isConfiguredAddress, eqAddr } from "@zkscatter/sdk";
import {
  splitPayout,
  withDeterministicSecrets,
  claimSeedFromKey,
  toBytes32Hex,
  type PayoutBatch,
  pickActiveTier,
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
import { computeBatchFee } from "../../_lib/payoutFees";
import { useIdentityStatus, useIdentityForAddresses } from "../../_lib/identity";
import { IdentityGateModal } from "../../_components/IdentityGateModal";
import { type ClaimPackage } from "@zkscatter/sdk/notes";
import { Field } from "@zkscatter/ui";
import { buildRunRecord } from "./_buildRunRecord";
import {
  ConfirmLargeAmount,
  ReviewRow,
  ReviewSection,
  Stepper,
  Toggle,
} from "./_components/wizardChrome";
import { FundsStep } from "./_components/FundsStep";
import {
  DepositCancelled,
  realDeposit,
  type DepositPhase,
} from "../../_lib/realDeposit";

// Largest tier with a live verifier — caps each individual settlement
// transaction's anonymity set.
const MAX_TIER_CAP = ACTIVE_TIERS[ACTIVE_TIERS.length - 1]!.cap;
// One payout = one commitment = one scatterDirectAuth tx. Multi-batch
// would require multiple source notes (UTXO model: each commitment is
// nullified atomically). Capping at one batch keeps the mental model
// simple — recipients fit inside the largest live circuit.
const MAX_BATCHES_PER_RUN = 1;
// Effective per-run recipient cap: 1 batch × largest active tier.
const MAX_RECIPIENTS_PER_RUN = MAX_TIER_CAP * MAX_BATCHES_PER_RUN;
const UPLOAD_STATUS_STYLES: Record<"ok" | "warn" | "error", string> = {
  ok: "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-success)]",
  warn: "border-[var(--color-warning)] bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
  error: "border-[var(--color-danger)] bg-red-50 text-[var(--color-danger)]",
};
// Tiers known to the SDK but not yet wired on-chain — used to surface
// the roadmap signal in user-facing validation messages without hard-
// coding "64 / 128" copy that drifts as tiers ship.
const PLANNED_TIER_CAPS = TIERS.filter((t) => !ACTIVE_TIERS.includes(t)).map((t) => t.cap);
import {
  useCuratedNetworkTokens,
  useWallet,
  type VaultNote,
} from "@zkscatter/sdk/react";
import {
  loadRun,
  saveRun,
  saveClaimsBackup,
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
import { formatRecipientCsvRow, formatRelativeAgo, parseAmount, parseRecipientRows, tokenBigIntToAddress, toIsoDateTimeSec } from "../../_lib/format";
import { csvEscape, csvSafeLabel, downloadCsv, splitCsvLine } from "@zkscatter/recipients/csv";
import { parseRecipientFile } from "@zkscatter/recipients/parser";
import {
  AddressBookPicker,
  SpreadsheetEditor,
  type RecipientField,
} from "@zkscatter/recipients";
import {
  clearWizardDraft,
  loadWizardDraft,
  saveWizardDraft,
} from "@zkscatter/sdk/storage";
import {
  autoPickSourceNotes,
  pickFromSelectedNotes,
  describeBatchFitError,
  pickPerBatchNotes,
  summarizeBalance,
  hasConfirmingDeposit,
  isLiveNote,
  type SourceNotesPick,
} from "../../_lib/sourceNotes";
import { useWalletBook } from "../../_lib/walletBook";
import { WorkspaceBar } from "../../_components/WorkspaceBar";
import { useFolderStorage } from "../../_lib/folderStorage";
import { type WalletEntry } from "@zkscatter/sdk/storage";
import type { RelayerInfo } from "@zkscatter/sdk/relayer";

import { REASON_PLACEHOLDER, CATEGORIES, type CategoryId } from "./_categories";

import type { RecipientRow as Row } from "../../_lib/format";

// Default cap on what the relayer can deduct as a fee. Lives here
// until the org-settings page lands; the wizard exposes it as an
// override in the Funds step.
const DEFAULT_MAX_FEE_BPS = 30;

// Pay's recipient editor only surfaces name/address/amount. `email`
// is upload-only (parser opts it in via `parseRecipientFile`), and
// `releaseAt` is set once for the whole run via the Claim schedule
// block — not per row.
const SPREADSHEET_COLUMNS: readonly RecipientField[] = ["name", "address", "amount"];

// TODO: read from org settings
const LARGE_AMOUNT_THRESHOLD = 50_000;

function today(): string {
  return toIsoDateTimeSec(new Date());
}

/** Earliest claim moment the wizard accepts. The buffer gives the
 *  operator time to settle on-chain + the recipient time to receive
 *  the link before the claim window opens; without it users could
 *  pick "now" and the receiver would race the settle tx. */
const CLAIM_FROM_BUFFER_MINUTES = 1;
function claimFromMin(): string {
  return toIsoDateTimeSec(
    new Date(Date.now() + CLAIM_FROM_BUFFER_MINUTES * 60_000),
  );
}

/** Render the wizard's `claimFrom` (local-time `datetime-local`
 *  string) as a short human-readable timestamp for the preview row.
 *  Falls back to the raw string when parsing fails so the operator
 *  still sees their input rather than an empty cell. */
function formatClaimFrom(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString();
}


/** Save the current run's recipient list as a CSV — same shape Step
 *  3 accepts on import, plus a header row carrying the run-level
 *  context (label / token / chain / claim time) so the file can be
 *  archived as the canonical orderbook for an off-chain audit
 *  trail. */
function downloadOrderbook(
  rows: readonly Row[],
  label: string,
  token: string,
  chain: string,
  claimFrom: string | null | undefined,
): void {
  const lines = [
    `# label,${csvEscape(label)}`,
    `# token,${csvEscape(token)}`,
    `# chain,${csvEscape(chain)}`,
    `# claim_from,${csvEscape(claimFrom ?? "")}`,
    `name,address,amount`,
    ...rows.map((r) =>
      `${csvEscape(r.name)},${csvEscape(r.address)},${csvEscape(r.amount)}`,
    ),
  ];
  downloadCsv(
    lines.join("\n"),
    `orderbook-${csvSafeLabel(label) || "run"}-${Date.now()}.csv`,
  );
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
      <NewPayoutGate />
    </Suspense>
  );
}

/** Identity gate. Blocks the wizard when the connected wallet
 *  isn't zk-X509 verified. Wallet-disconnected and loading states
 *  fall through to the wizard body — the wizard's existing
 *  "connect wallet" prompt handles the former, and the latter
 *  resolves within seconds without flashing a modal. */
function NewPayoutGate() {
  const router = useRouter();
  const { state } = useIdentityStatus();
  const blocking =
    state.kind === "unverified" ||
    state.kind === "expired" ||
    state.kind === "error";
  if (blocking) {
    return (
      <>
        <div className="mx-auto max-w-3xl py-6 text-center text-sm text-[var(--color-text-muted)]">
          Verify your identity to start a payout. The wizard unlocks once
          your wallet's zk-X509 status checks out.
        </div>
        <IdentityGateModal state={state} onClose={() => router.push("/")} />
      </>
    );
  }
  return <NewPayout />;
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
  const [categoryId, setCategoryId] = useState<CategoryId>("payroll");
  const category = CATEGORIES.find((c) => c.id === categoryId)!;

  const [label, setLabel] = useState(category.defaultLabel);
  const [token, setToken] = useState(category.defaultToken);
  // Chain selection used to be a free-form dropdown across multiple
  // testnets, but settle is wired to the build-time `cfg.chainId` —
  // changing the dropdown didn't actually change anything. Lock the
  // wizard to the configured chain so the displayed value matches the
  // tx target. When we add a multi-chain switcher this becomes a
  // dropdown again, sourced from `cfg.supportedChains`.
  const chain = chainName(getNetworkConfig().chainId);
  const [csv, setCsv] = useState(category.sampleCsv);
  // Per-recipient email captured at picker-time so a book entry's
  // email survives into the run record even if the book is later
  // edited. Keyed by lowercase recipient address.
  const [pickerEmails, setPickerEmails] = useState<Record<string, string>>({});
  // Picker-time snapshot map for label — same immutability rationale
  // as `pickerEmails` (see BuildRunRecordInput). Telegram / Kakao were
  // removed: the wizard no longer captures them at picker time, but
  // historical run records' optional fields stay backwards-compatible
  // in the storage schema.
  const [pickerLabels, setPickerLabels] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [claimFrom, setClaimFrom] = useState<string>();
  // Captured once on first render — used as the input's `min` so the
  // floor stays at "now" even after the user picks a future moment.
  // Without this, binding `min={claimFrom}` would trap the user: any
  // future selection would advance the floor and prevent moving the
  // value back earlier.
  const claimFromMinRef = useRef<string | null>(null);
  if (claimFromMinRef.current === null) {
    claimFromMinRef.current = claimFromMin();
  }
  // True when the picked claim moment is closer than the buffer to
  // wall-clock now. Re-evaluated on every render rather than memoed
  // so the warning lifts naturally as time advances past the
  // threshold (without forcing a tick state).
  const claimFromTooEarly =
    !!claimFrom &&
    Number.isFinite(Date.parse(claimFrom)) &&
    Date.parse(claimFrom) - Date.now() <
      CLAIM_FROM_BUFFER_MINUTES * 60_000;
  const [maxFeeBps, setMaxFeeBps] = useState(DEFAULT_MAX_FEE_BPS);
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // `kind` distinguishes total failure (nothing landed on-chain — the
  // wizard draft is the only artifact) from partial failure (≥ 1
  // batch broadcast — the source notes are spent and a RunRecord
  // should let the operator resume). `recoverable` flags whether the
  // expected recovery artifact actually exists: for "total" that's a
  // wizard draft on disk (requires `folder.ready`); for "partial"
  // it's a successfully persisted RunRecord (the partial-path persist
  // swallows save errors, so success is not guaranteed).
  const [submitError, setSubmitError] = useState<
    { kind: "total" | "partial"; message: string; recoverable: boolean } | null
  >(null);
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
  const [showBookPicker, setShowBookPicker] = useState(false);
  // Probe each address-book entry through the shared IdentityGate
  // cache so the picker can dim unverified ones (they can't claim).
  // Gated by `showBookPicker` so the RPC burst only happens when the
  // modal is actually opened — closing the modal lets the cache keep
  // serving subsequent opens without re-probing.
  const bookAddresses = useMemo(
    () =>
      showBookPicker
        ? walletBook.entries.map((e) => e.address ?? "").filter(Boolean)
        : [],
    [showBookPicker, walletBook.entries],
  );
  const bookIdentity = useIdentityForAddresses(bookAddresses);
  const getAddressVerification = useCallback(
    (addr: string): "verified" | "unverified" | null => {
      const v = bookIdentity.get(addr);
      if (!v) return null;
      return v.isVerified ? "verified" : "unverified";
    },
    [bookIdentity],
  );
  const folder = useFolderStorage();
  type UploadStatusKind = "ok" | "warn" | "error";
  const [uploadStatus, setUploadStatus] = useState<
    { kind: UploadStatusKind; message: string } | null
  >(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Recipient editor mode: textarea (CSV power-user) vs grid
  // (HR-friendly cell-by-cell view). Persisted so the user's choice
  // sticks across visits. Default is CSV for the existing user base;
  // first-time HR users can flip via the tab toggle in the UI.
  type EditMode = "csv" | "spreadsheet";
  // Defer the localStorage read to a post-mount effect. Pay ships as
  // a static export — pre-rendered HTML uses the "csv" default, so
  // any client-side initializer that returned "spreadsheet" would
  // trip a hydration mismatch on first render.
  const [editMode, setEditMode] = useState<EditMode>("csv");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("pay-recipient-edit-mode");
      // Whitelist the value before trusting it: a stale or hand-edited
      // entry (e.g. from a renamed mode) would otherwise admit anything
      // truthy and break the render branch.
      if (stored === "spreadsheet") setEditMode("spreadsheet");
    } catch {
      // localStorage can throw in privacy mode / blocked storage.
      // Silently fall back to the default — the wizard still works,
      // the user just doesn't get persistence.
    }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem("pay-recipient-edit-mode", editMode);
    } catch {
      // setItem can throw on quota exceeded / blocked storage. Same
      // policy: the choice still applies for the current session.
    }
  }, [editMode]);
  const draftLabelParam = searchParams?.get("label") ?? null;
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const [draftJustSaved, setDraftJustSaved] = useState(false);
  const [draftSaveError, setDraftSaveError] = useState<string | null>(null);
  const draftHydratedRef = useRef(false);
  // Tracks the label the draft was last persisted under. When the user
  // edits the label, the next save uses this to delete the old slot
  // before writing the new one — no duplicate drafts on rename.
  const lastSavedLabelRef = useRef<string | null>(null);

  // ── Draft restore — runs once after the folder is mounted so
  // FSA reads succeed. The resume-partial-run flow (?resume=<id>)
  // takes precedence: a partial run already has its own RunRecord,
  // hydrating a draft on top would double-stamp. When `?label=…`
  // is present we hydrate that draft slot; otherwise this is a fresh
  // wizard session and the defaults stand.
  useEffect(() => {
    if (draftHydratedRef.current) return;
    if (resume.kind === "loading") return;
    if (resume.kind === "ready") {
      draftHydratedRef.current = true;
      return;
    }
    if (!folder.ready) return;
    if (!draftLabelParam) {
      draftHydratedRef.current = true;
      return;
    }
    void loadWizardDraft(account, draftLabelParam).then((d) => {
      if (d) {
        // Drafts persist `templateId` as a free string; an old or
        // hand-edited value outside the current CategoryId union would
        // crash the render via `CATEGORIES.find(...)!` on line 201.
        const draftCat = CATEGORIES.find((c) => c.id === d.templateId);
        if (draftCat) setCategoryId(draftCat.id);
        setLabel(d.label);
        setToken(d.token);
        setCsv(d.csv);
        setReason(d.reason);
        setClaimFrom(d.claimFrom);
        setMaxFeeBps(d.maxFeeBps);
        setStep(d.step);
        setDraftSavedAt(d.savedAt);
        lastSavedLabelRef.current = d.label;
      }
      draftHydratedRef.current = true;
    });
  }, [folder.ready, resume.kind, draftLabelParam, account]);

  // Draft save is explicit — the "Save draft" button writes to storage.
  // Blanket auto-save was removed because it created ghost drafts the
  // operator never intended (every wizard mount produced a "(untitled)"
  // entry) and surprised users by silently mirroring URL state.
  //
  // The one exception is the deposit kickoff (see `onDeposit` below):
  // once the operator commits real funds to escrow, the run config must
  // survive the long on-chain confirm — a crash / closed tab during the
  // wait would otherwise orphan escrowed money from the recipient list
  // it was deposited for. That save is tied to an explicit, high-stakes
  // action on an already-named run, so it reintroduces neither problem.
  // Re-entry guard: the button and the deposit kickoff can both fire a
  // save; serialise them so two concurrent writes to the same draft can't
  // race (last-write-wins on the same label is otherwise benign, but the
  // lock keeps `lastSavedLabelRef` / the URL replace deterministic).
  const saveInFlightRef = useRef(false);
  // Guards the post-await side effects below: a draft save can outlive the
  // page (the user navigates away mid-save), and a late `router.replace`
  // would yank them back to /payouts/new.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const saveDraftNow = useCallback(async (): Promise<string | null> => {
    if (!account || !label.trim() || saveInFlightRef.current) return null;
    saveInFlightRef.current = true;
    setDraftSaveError(null);
    try {
      const saved = await saveWizardDraft(account, lastSavedLabelRef.current, {
        step,
        templateId: categoryId,
        label,
        token,
        csv,
        reason,
        claimFrom,
        maxFeeBps,
      });
      lastSavedLabelRef.current = saved.label;
      // Skip state + navigation if the user left mid-save.
      if (isMountedRef.current) {
        setDraftSavedAt(saved.savedAt);
        router.replace(`/payouts/new?label=${encodeURIComponent(saved.label)}`);
      }
      return saved.label;
    } catch (err) {
      console.error("[Pay] saveWizardDraft failed", err);
      if (isMountedRef.current) {
        setDraftSaveError(err instanceof Error ? err.message : String(err));
      }
      return null;
    } finally {
      saveInFlightRef.current = false;
    }
  }, [account, label, step, categoryId, token, csv, reason, claimFrom, maxFeeBps, router]);

  const addressBookHint = !folder.ready
    ? "Pick a notes folder to load your address book."
    : !walletBook.loaded
      ? "Loading your address book…"
      : walletBook.corrupt
        ? "Address book file is corrupt — repair it from /address-book."
        : walletBook.entries.length === 0
          ? "Add recipients in /address-book first."
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
    setClaimFrom(claimFromMin());
  }, []);

  // Resume only starts once the notes folder is mounted — the run
  // lives there. Category / token / label / claim-from edits are
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
        const cat = CATEGORIES.find((c) => c.id === r.category) ?? CATEGORIES[0]!;
        setCategoryId(cat.id);
        setLabel(r.label);
        setToken(r.tokenSymbol);
        setCsv(recipientsToCsv(unsettled));
        // `claimFrom` on RecipientRow is per-row Unix seconds set
        // from `new Date("YYYY-MM-DDTHH:mm:ss").getTime()` (LOCAL time).
        // Round-trip with local getters via `toIsoDateTimeSec` so a
        // mid-day unlock displays at the operator's wall-clock time
        // rather than drifting by their UTC offset. Any row carries
        // the same value, so the first one with the field is enough.
        const firstClaimFrom = unsettled.find((u) => u.claimFrom)?.claimFrom;
        if (firstClaimFrom) {
          setClaimFrom(toIsoDateTimeSec(new Date(firstClaimFrom * 1000)));
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
    let totalRelayerFeeRaw: bigint | undefined;
    // Per-payout claim-secret seed, set in the settle block below and read
    // by persist(). Deterministic from the wallet (or the resumed run's
    // persisted seed), so it's recomputed fresh each submit — no caching,
    // which avoids a stale seed after a wallet switch.
    let payoutSeed: bigint | undefined;
    // Whether `persist(allowFailure: true)` succeeded on the partial
    // path. The helper swallows save errors and returns null, so a
    // partial banner promising "saved" must check this flag rather
    // than assume the side effect happened.
    let partialRecordSaved = false;
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
              categoryId,
              label,
              token,
              tokenAddress,
              operatorAddress: account,
              chainId,
              rows,
              totalAmount: ethers.formatUnits(requiredRaw, decimals),
              claimFrom,
              txHash,
              claimPackages,
              emailByAddress: pickerEmails,
              labelByAddress: pickerLabels,
              ...(totalRelayerFeeRaw !== undefined
                ? { relayerFee: ethers.formatUnits(totalRelayerFeeRaw, decimals) }
                : {}),
              ...(payoutSeed !== undefined
                ? { payoutSeed: payoutSeed.toString() }
                : {}),
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
        // Validation disables Sign past the recipient cap; assert it here
        // too so a future gating regression fails loudly instead of silently
        // settling a truncated payout (parseRecipientRows below sees the full
        // `rows`, but the cap keeps batch sizing within the active tier).
        if (rows.length > MAX_RECIPIENTS_PER_RUN) {
          throw new Error(
            `This payout has ${rows.length} recipients; Pay caps at ${MAX_RECIPIENTS_PER_RUN} per run. Reduce recipients or split into multiple runs.`,
          );
        }
        // Derive claim secrets DETERMINISTICALLY from a per-payout seed
        // instead of the random secrets splitPayout() draws by default. The
        // original bug: a relayer-delay retry re-split with fresh random
        // secrets → a DIFFERENT claimsRoot over the same source-note
        // nullifier; the relayer settled one root but the other attempt's
        // packages got persisted, stranding funds under a root whose secrets
        // were lost. With a seeded derivation any retry/resume reproduces the
        // identical secrets and root. Resume reuses the original run's
        // persisted seed so the re-settle matches its already-issued
        // packages; a fresh run mints one and holds it in payoutSeedRef.
        // (finalizeRealSettle still hard-checks the on-chain event root.)
        // Batch-count guard up front (same length as submitBatches, which
        // we build after the EdDSA derive below) so we don't prompt the
        // wallet for a payout we'll reject anyway.
        if (batches.length > MAX_BATCHES_PER_RUN) {
          throw new Error(
            `This payout would need ${batches.length} settlement transaction${batches.length === 1 ? "" : "s"}; Pay caps at ${MAX_BATCHES_PER_RUN === 1 ? "one" : MAX_BATCHES_PER_RUN} per payout. Reduce recipients to ${MAX_RECIPIENTS_PER_RUN} or fewer, or split into multiple runs.`,
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
        // Derive the per-payout claim-secret seed DETERMINISTICALLY from the
        // wallet's eddsa key material (claimSeedFromKey) rather than random:
        // it's re-derivable from the wallet alone, so there's no stored seed
        // to lose and a recovery run can regenerate every claim secret by
        // re-signing. A resume reuses the original run's persisted seed so
        // the re-settle reproduces its already-issued packages' root. The
        // settle path stays idempotent (same wallet → same seed → same
        // claimsRoot on retry), and finalizeRealSettle still hard-checks the
        // on-chain event root.
        if (resumeRecord?.payoutSeed) {
          // Resume always prefers the original run's persisted seed so the
          // re-settle reproduces its already-issued packages' root.
          try {
            payoutSeed = BigInt(resumeRecord.payoutSeed);
          } catch {
            throw new Error(
              `This run's saved payoutSeed is invalid ("${resumeRecord.payoutSeed}") — can't reproduce its claim secrets to resume. Start a fresh payout instead.`,
            );
          }
        } else {
          // Deterministic from the connected wallet — recomputed each submit
          // (a retry re-derives the same value; a wallet switch derives the
          // new wallet's, with no stale cache).
          payoutSeed = claimSeedFromKey(kp.privateKey);
        }
        const submitBatches: PayoutBatch[] = splitPayout(
          await withDeterministicSecrets(
            parseRecipientRows(rows, decimals, claimFrom!),
            payoutSeed,
            tokenAddress,
          ),
          { token: tokenAddress },
        );
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
        const settleArgs = (i: number) => {
          const b = submitBatches[i]!;
          // Per-batch exact fee mirrors the run-wide breakdown so the
          // proof's sellAmount equals the on-chain charge — no bps
          // round-up over-collection.
          const batchFee = computeBatchFee({
            lockedAmount: b.totalAmount,
            recipientCount: b.claims.length,
            maxFeeBps: safeMaxFeeBps,
            claimFeePerRecipientRaw,
          });
          return {
            batch: b,
            tokenAddress,
            tokenSymbol: token,
            tokenDecimals: decimals,
            source: multiBatchFit.byBatch[i]!,
            relayer,
            chain: { signer, settlementAddress, chainId: cfg.chainId },
            maxFeeBps: batchFee.effectiveMaxFeeBps,
            feeRaw: batchFee.feeRaw,
            eddsaPrivateKey: kp.privateKey,
            eddsaPublicKey: kp.publicKey,
            tree,
            labels: { sender: account ?? undefined, run: label },
          };
        };

        const preparePromises: Promise<PreparedSettle>[] = submitBatches.map((_, i) =>
          prepareRealSettle(settleArgs(i)),
        );
        preparePromises.forEach((p) => p.catch(() => undefined));

        const readProvider = signer.provider;
        if (!readProvider) {
          throw new Error("Wallet has no provider — can't observe relayer-broadcast tx receipt.");
        }
        const submitted: {
          txHash: string;
          ctx: PreparedSettle["ctx"];
          spentNoteId: string;
        }[] = [];
        let partialBatchError: Error | null = null;
        for (let i = 0; i < submitBatches.length; i++) {
          try {
            const prep = await preparePromises[i]!;
            // Persist this batch's claim inputs keyed by claimsRoot BEFORE
            // dispatching to the relayer. If the settle lands on-chain but
            // the run record is never written (a crash, or a relayer that
            // returns a different attempt's tx hash), the secrets for the
            // root that actually settled stay recoverable from this backup —
            // the contract has no refund path, so a lost secret strands the
            // funds. A write failure aborts the batch (caught below) rather
            // than settling without a recoverable backup.
            await saveClaimsBackup({
              version: 1,
              createdAt: Math.floor(Date.now() / 1000),
              chainId: cfg.chainId,
              settlementAddress,
              claimsRoot: toBytes32Hex(prep.ctx.authResult.claimsRoot),
              tierCap: prep.ctx.batch.tier.cap,
              token: tokenAddress,
              tokenSymbol: token,
              tokenDecimals: decimals,
              payoutSeed: payoutSeed.toString(),
              runLabel: label,
              ...(account ? { senderLabel: account } : {}),
              relayerUrl: relayer.url,
              claims: prep.ctx.batch.claims.map((c) => ({
                recipient: c.recipient,
                amount: c.amount.toString(),
                releaseTime: c.releaseTime.toString(),
                secret: c.secret.toString(),
              })),
            });
            const sent = await submitRealSettle(prep, relayer.url);
            submitted.push({
              txHash: sent.txHash,
              ctx: sent.ctx,
              spentNoteId: multiBatchFit.byBatch[i]!.note.id,
            });
          } catch (err) {
            partialBatchError = err instanceof Error ? err : new Error(String(err));
            break;
          }
        }

        // Reflect broadcast progress as soon as the relayer accepts a
        // batch — `submitted` only holds entries the broadcast loop
        // successfully sent. If `finalizeRealSettle` later fails (e.g.
        // receipt timeout), `lastTxHash` will stay undefined but the
        // outer `txHash` already records that something landed, so the
        // catch block can classify the failure as partial rather than
        // total. The finalize loop overwrites `txHash` with the last
        // confirmed hash on the success path.
        if (submitted.length > 0) {
          txHash = submitted[submitted.length - 1]!.txHash;
        }

        const aggClaimPackages: ClaimPackage[] = [];
        let lastTxHash: string | undefined;
        totalRelayerFeeRaw = 0n;
        const finalized = await Promise.allSettled(
          submitted.map(({ txHash, ctx }) =>
            finalizeRealSettle(txHash, ctx, readProvider),
          ),
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
          totalRelayerFeeRaw = (totalRelayerFeeRaw ?? 0n) + r.value.relayerFee;
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
          // Only persist when at least one batch actually settled
          // on-chain — otherwise the run is a draft (no nullifier
          // consumed, source note still spendable) and a saved
          // RunRecord with `txHash=undefined, claimPackages=[]`
          // would pollute the dashboard with phantom payouts. The
          // resume-existing path stays as-is so a partially-settled
          // run keeps its record even if the resume attempt sends
          // nothing new.
          const anySettled = !!lastTxHash || aggClaimPackages.length > 0;
          if (anySettled || resumeRecord) {
            const id = await persist(/* allowFailure */ true);
            partialRecordSaved = id !== null;
          }
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
        const labelToClear = lastSavedLabelRef.current;
        if (labelToClear !== null) {
          clearWizardDraft(account, labelToClear).catch((err) =>
            console.error("Failed to clear wizard draft", err),
          );
        }
        router.push(`/payouts/detail?id=${encodeURIComponent(savedId)}`);
      }
    } catch (err) {
      console.error("[Pay] settle failed", err);
      // `txHash` / `claimPackages` are populated incrementally inside
      // the settle branch — if either is set, at least one batch
      // landed on-chain and a RunRecord was persisted (partial). With
      // neither, nothing settled and the auto-saved wizard draft is
      // the only artifact.
      const anySettled =
        !!txHash || (claimPackages?.length ?? 0) > 0 || !!resumeRecord;
      const kind: "total" | "partial" = anySettled ? "partial" : "total";
      // Total: the wizard draft only exists when a notes folder is
      // attached (both draft hooks early-return on `!folder.ready`).
      // Partial: the persist helper swallows save errors, so trust the
      // flag rather than assume success.
      const recoverable = kind === "total" ? folder.ready : partialRecordSaved;
      setSubmitError({
        kind,
        recoverable,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  }

  function appendFromAddressBook(picked: WalletEntry[]) {
    if (picked.length === 0) return;
    const seen = new Set(rows.map((r) => r.address.toLowerCase()).filter(Boolean));
    const rowsToAdd: string[] = [];
    const newEmails: Record<string, string> = {};
    const newLabels: Record<string, string> = {};
    // Snapshot every contact field the book entry carries at picker
    // time. The run record will only see these snapshots — buildRunRecord
    // never reads the live book — so a later book edit can't rewrite
    // a historical run's contact info.
    const snapshot = (lower: string, e: WalletEntry) => {
      if (e.email) newEmails[lower] = e.email;
      if (e.label) newLabels[lower] = e.label;
    };
    // Defensive guard: the picker already filters out address-less
    // entries up front, so this branch shouldn't fire in normal use.
    // Keep it so a future change that bypasses the picker still gets
    // a structurally sound row set.
    for (const e of picked) {
      if (!e.address) continue;
      const lower = e.address.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      snapshot(lower, e);
      rowsToAdd.push(formatRecipientCsvRow(e.label, e.address, ""));
    }
    if (rowsToAdd.length === 0) return;
    if (Object.keys(newEmails).length > 0) {
      setPickerEmails((prev) => ({ ...prev, ...newEmails }));
    }
    if (Object.keys(newLabels).length > 0) {
      setPickerLabels((prev) => ({ ...prev, ...newLabels }));
    }
    const trimmed = csv.trimEnd();
    setCsv(trimmed.length > 0 ? `${trimmed}\n${rowsToAdd.join("\n")}` : rowsToAdd.join("\n"));
  }

  async function handleRecipientFile(file: File) {
    if (resumeRecord) return;
    setUploadStatus(null);
    let result: Awaited<ReturnType<typeof parseRecipientFile>>;
    try {
      result = await parseRecipientFile(file);
    } catch (err) {
      setUploadStatus({
        kind: "error",
        message: `Failed to read ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    if (result.rows.length === 0) {
      setUploadStatus({
        kind: "error",
        message: result.warnings[0] ?? "No recipients found in file.",
      });
      return;
    }
    // Snapshot email at file-import time so a later address-book edit
    // can't rewrite a historical run's contact info. Self-contained:
    // file in → record out.
    const newEmails: Record<string, string> = {};
    const csvLines: string[] = [];
    for (const r of result.rows) {
      if (r.email && r.address) {
        newEmails[r.address.toLowerCase()] = r.email;
      }
      csvLines.push(formatRecipientCsvRow(r.name, r.address, r.amount));
    }
    if (Object.keys(newEmails).length > 0) {
      setPickerEmails((prev) => ({ ...prev, ...newEmails }));
    }
    const block = csvLines.join("\n");
    // Functional setCsv guards against stale closure state: the user can
    // edit the textarea or switch categories while async parse is in
    // flight, and `prev` always reflects the latest committed value.
    // Match against ANY category's sample so a mid-parse category switch
    // still replaces the (newly swapped-in) placeholder cleanly.
    let shouldReplace = false;
    setCsv((prev) => {
      const trimmed = prev.trimEnd();
      const isUntouchedSample = CATEGORIES.some(
        (c) => c.sampleCsv.trimEnd() === trimmed,
      );
      shouldReplace = trimmed.length === 0 || isUntouchedSample;
      return shouldReplace ? block : `${trimmed}\n${block}`;
    });
    const action = shouldReplace ? "Loaded" : "Appended";
    const emailCount = Object.keys(newEmails).length;
    const metaSuffix = emailCount > 0 ? ` (${emailCount} with email)` : "";
    const warn = result.warnings[0];
    setUploadStatus({
      kind: warn ? "warn" : "ok",
      message: `${action} ${result.rows.length} recipient(s) from ${file.name}${metaSuffix}.${warn ? ` ${warn}` : ""}`,
    });
  }

  function pickCategory(id: CategoryId) {
    const c = CATEGORIES.find((x) => x.id === id)!;
    setCategoryId(id);
    setLabel(c.defaultLabel);
    setToken(c.defaultToken);
    setCsv(c.sampleCsv);
    setReason("");
  }

  const rows: Row[] = useMemo(() => {
    return csv
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        // Quote-aware split so values the shared SpreadsheetEditor
        // emits via `csvEscape` (e.g. names containing `"`) round-trip
        // back into `rows` without column-shift or stray quote chars.
        const parts = splitCsvLine(l);
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

  // Resolve the network config once; the wizard uses its WETH
  // address for the native-ETH lookup below and `cfg.chainId` for
  // the chain-pill display elsewhere.
  const networkCfg = useMemo(() => getNetworkConfig(), []);
  // Resolve the token's address + decimals from the on-chain
  // Pool∩Settlement whitelist (a team deployment registers tokens via
  // setTokenWhitelist) rather than NEXT_PUBLIC_* env, so a token without
  // an env address (e.g. TON) still resolves. `networkCfg.tokens` is the
  // curated metadata + pre-load fallback.
  const { tokens: curatedTokens, loading: tokensLoading } =
    useCuratedNetworkTokens(networkCfg);
  // Only tokens actually on the on-chain whitelist (configured address)
  // are payable — an admin can remove a token via setTokenWhitelist and
  // it must drop out of the picker, not linger as "(not deployed)". Fall
  // back to the full curated list if the whitelist read yields nothing
  // (e.g. RPC hiccup) so the dropdown never goes empty.
  const selectableTokens = useMemo(() => {
    const configured = curatedTokens.filter((t) => isConfiguredAddress(t.address));
    return configured.length > 0 ? configured : curatedTokens;
  }, [curatedTokens]);
  const tokenInfo =
    curatedTokens.find((t) => t.symbol === token) ?? LAUNCH_TOKENS[token];
  // For native ETH the vault stores notes against WETH (the deposit
  // wraps ETH → WETH before escrow), so the wizard's lookup key has
  // to match. Without this the Funds step's `summarizeBalance`
  // misses a freshly-deposited ETH note and shows 0 even after
  // a successful deposit.
  // `useCuratedNetworkTokens` already resolved native ETH to the WETH
  // address (whitelist, or the env slot as fallback), so `.address` is
  // usable for both native and non-native tokens.
  const tokenAddress = tokenInfo?.address?.toLowerCase();
  const decimals = tokenInfo?.decimals ?? 18;

  // If the selected token is no longer payable (de-whitelisted on-chain,
  // or a category default that isn't deployed) snap the selection to the
  // first selectable one. Skip while the whitelist is still loading (the
  // pre-resolve list uses env fallbacks) and when resuming a saved run
  // (its token is fixed). Without this a removed token can stay the
  // active value and a deposit/settle would fail downstream.
  useEffect(() => {
    if (tokensLoading || resumeRecord) return;
    if (selectableTokens.length === 0) return;
    if (selectableTokens.some((t) => t.symbol === token)) return;
    setToken(selectableTokens[0]!.symbol);
  }, [tokensLoading, selectableTokens, token, resumeRecord]);

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

  // Display-only sibling of `requiredRaw`: SKIPS unparseable rows
  // instead of bailing to the 0n sentinel, so the review total keeps
  // tracking the valid rows while the operator is mid-edit (one bad
  // amount string would otherwise blank the whole figure — Copilot
  // review on PR #1009). Settlement and the shortfall check stay on
  // the strict `requiredRaw`; validation blocks submit while any row
  // is invalid, so the two only diverge in transient editing states.
  const displayTotalRaw = useMemo<bigint>(() => {
    let sum = 0n;
    for (const r of rows) {
      const cleaned = r.amount.replace(/[,_\s]/g, "");
      if (!/^\d+(\.\d+)?$/.test(cleaned)) continue;
      try {
        sum += ethers.parseUnits(cleaned, decimals);
      } catch {
        continue;
      }
    }
    return sum;
  }, [rows, decimals]);

  // Sanitize first — browser number inputs can carry transient decimal
  // values (e.g. mid-typing "1.5"); `BigInt(1.5)` throws. Upper clamp
  // mirrors the protocol limit (uint16 bps cap) so a stale draft or
  // non-UI write path can't push `serviceFeeRaw` past 100%.
  const safeMaxFeeBps = Number.isFinite(maxFeeBps)
    ? Math.max(0, Math.min(10_000, Math.trunc(maxFeeBps)))
    : 0;
  // Native ETH runs are settled in the same currency the relayer
  // pays gas in, so there's nothing to pre-collect — bps service
  // fee already covers the relayer's economics. Skip the policy
  // lookup so a stray `CLAIM_FEE_ETH` env doesn't accidentally
  // double-charge an ETH payout.
  const claimFeePerRecipientRaw = (() => {
    if (token === "ETH") return 0n;
    const str = relayer?.api?.claim_fees?.[token];
    if (!str) return 0n;
    try {
      return ethers.parseUnits(str, decimals);
    } catch (err) {
      // Don't silently swallow — a typo (`0,05` vs `0.05`) would
      // zero the reserve and have the relayer eat claim gas. Logged
      // so operators can spot misconfigured policies in the browser
      // console without breaking the page.
      console.warn(
        `[pay] Failed to parse claim_fees["${token}"]="${str}":`,
        err,
      );
      return 0n;
    }
  })();
  // Run-wide breakdown used by FundsStep's UI (service / reserve /
  // total rows). Per-batch math at submit time recomputes the same
  // values for each batch via the same helper. Integer division in
  // `serviceFeeRaw` means `floor(sum × bps / 10000)` can differ from
  // `Σ floor(batchᵢ × bps / 10000)` by at most one token-raw unit
  // per batch — display drift is bounded by `batches.length` and
  // sub-cent in practice; the on-chain charge is always the
  // per-batch sum.
  const runFee = computeBatchFee({
    lockedAmount: requiredRaw,
    recipientCount: rows.length,
    maxFeeBps: safeMaxFeeBps,
    claimFeePerRecipientRaw,
  });
  const { serviceFeeRaw, claimReserveRaw, feeRaw, sellAmount: totalEscrowRaw } = runFee;

  // Operator-controlled checklist of vault notes to spend. Defaults
  // to whatever auto-pick would have chosen but switches to manual
  // mode the moment the operator toggles a checkbox — once manual,
  // the wizard never re-syncs with auto-pick so a flipping
  // totalEscrowRaw doesn't silently reset the selection mid-flow.
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(() => new Set());
  const [manualPick, setManualPick] = useState(false);
  const tokenNotes = useMemo<VaultNote[]>(() => {
    if (!tokenAddress) return [];
    return notes.filter(
      (n) =>
        // Drop phantom deposits (reverted tx → never inserted) so they
        // don't show up as spendable/pending notes for the run.
        isLiveNote(n) &&
        eqAddr(tokenBigIntToAddress(n.note.token), tokenAddress),
    );
  }, [notes, tokenAddress]);
  const autoSourcePick = useMemo<SourceNotesPick>(
    () =>
      autoPickSourceNotes(
        notes.filter((n) => n.leafIndex >= 0),
        tokenAddress ?? "",
        totalEscrowRaw,
      ),
    [notes, tokenAddress, totalEscrowRaw],
  );
  // Sync the checkbox selection with auto-pick until the operator
  // overrides it; afterwards the selection is theirs to manage.
  useEffect(() => {
    if (manualPick) return;
    const autoIds = new Set(autoSourcePick.notes.map((n) => n.note.id));
    setSelectedNoteIds(autoIds);
  }, [autoSourcePick, manualPick]);
  const sourcePick = useMemo<SourceNotesPick>(
    () =>
      manualPick
        ? pickFromSelectedNotes(notes, selectedNoteIds, tokenAddress ?? "", totalEscrowRaw)
        : autoSourcePick,
    [manualPick, notes, selectedNoteIds, tokenAddress, totalEscrowRaw, autoSourcePick],
  );
  const batches = useMemo<PayoutBatch[]>(() => {
    if (!tokenAddress || rows.length === 0 || !claimFrom) return [];
    try {
      // Clamp before parsing so the displayed Tier / batch count
      // matches `tier`, and a paste of 10k rows doesn't parse the
      // overflow. Validation still flags the original row count and
      // disables Sign — this clamp only affects the preview.
      const cappedRows = rows.slice(0, MAX_RECIPIENTS_PER_RUN);
      const recipients = parseRecipientRows(cappedRows, decimals, claimFrom);
      return splitPayout(recipients, { token: tokenAddress });
    } catch {
      return [];
    }
  }, [rows, tokenAddress, decimals, claimFrom]);

  // Single-batch settle consumes one commitment, so the actionable
  // top-up is `totalEscrowRaw` (mint a self-sufficient new note) —
  // not the sum gap, since a fresh deposit is an independent UTXO
  // that doesn't merge with existing notes. Multi-batch keeps the
  // per-sum shortfall; per-batch fit lives in `multiBatchFit` /
  // `BatchFitWarning`.
  const isSingleBatch = batches.length <= 1;
  const largestEligibleRaw = useMemo<bigint>(() => {
    let max = 0n;
    for (const n of tokenNotes) {
      if (n.leafIndex < 0) continue;
      if (n.note.amount > max) max = n.note.amount;
    }
    return max;
  }, [tokenNotes]);
  const shortfallRaw = ((): bigint => {
    if (isSingleBatch) {
      return largestEligibleRaw >= totalEscrowRaw ? 0n : totalEscrowRaw;
    }
    if (sourcePick.covered) return 0n;
    if (totalEscrowRaw > availableRaw) return totalEscrowRaw - availableRaw;
    return totalEscrowRaw - sourcePick.pickedRaw;
  })();
  const toggleNoteSelection = useCallback((id: string) => {
    setManualPick(true);
    setSelectedNoteIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  // Single-select counterpart for batch=1 runs. Replaces the entire
  // selection with `{id}` so the panel's radio semantics match the
  // settle constraint (one source note per `scatterDirectAuth` call).
  const selectSingleNote = useCallback((id: string) => {
    setManualPick(true);
    setSelectedNoteIds(new Set([id]));
  }, []);

  // Pre-flight the multi-batch picker so the Funds step can warn
  // BEFORE Sign — without this, the user sees "covered" via
  // sourcePick (which sums totals across all notes) but doSubmit
  // throws at sign time because pickPerBatchNotes also requires
  // each batch to fit in a single reconciled note.
  const multiBatchFit = useMemo(() => {
    if (!tokenAddress || batches.length === 0) return null;
    // Honor the operator's manual selection only when they've
    // actually overridden the auto-pick. In auto mode `selectedNoteIds`
    // mirrors `autoSourcePick.notes` (a *covering* subset, not a fit
    // for every batch), so passing it here would prematurely shrink
    // the eligible pool and could turn a multi-batch run uncovered.
    // Auto-pick stays full-eligible-set; manual mode locks the picker
    // to what the operator checked so preview ↔ settle agree.
    const restrictTo = manualPick ? selectedNoteIds : undefined;
    return pickPerBatchNotes(notes, batches, tokenAddress, restrictTo);
  }, [notes, batches, tokenAddress, selectedNoteIds, manualPick]);

  // The tier governs each batch's anonymity set. Multi-batch runs
  // settle one batch per `scatterDirectAuth` tx; every batch shares
  // the picked tier. `pickActiveTier` returns the smallest active
  // tier that covers the run, falling back to the largest active
  // tier when no single active tier fits — that's the multi-batch
  // path. With only TIER_16 active today the picker always returns
  // TIER_16; once TIER_64 ships, runs of 17–64 collapse to one batch.
  const tier = useMemo<CircuitTier | null>(() => {
    if (rows.length === 0) return null;
    return pickActiveTier(Math.min(rows.length, MAX_RECIPIENTS_PER_RUN));
  }, [rows.length]);

  // Probe every recipient against the identity registry. The
  // bulk hook fans out one RPC per uncached address; the cache is
  // shared across the address book and claim page so re-visiting
  // the same recipient doesn't refetch.
  const recipientAddresses = useMemo(
    () => rows.map((r) => r.address).filter(Boolean),
    [rows],
  );
  const recipientIdentity = useIdentityForAddresses(recipientAddresses);

  const validation = useMemo(() => {
    const issues: string[] = [];
    // Shape-of-input checks (empty / cap-exceeded) come first because
    // they block the run regardless of per-row fixes — and slice(0, 5)
    // below would otherwise hide them behind five ordinary validation
    // errors. The two are mutually exclusive (0 vs >MAX).
    if (rows.length === 0) {
      issues.push("Add at least one recipient.");
    }
    if (rows.length > MAX_RECIPIENTS_PER_RUN) {
      const roadmap = PLANNED_TIER_CAPS.length > 0
        ? ` Larger circuits (${PLANNED_TIER_CAPS.join(" / ")}) are planned — for now, split into multiple runs.`
        : "";
      const txCopy = MAX_BATCHES_PER_RUN === 1
        ? "one settlement transaction"
        : `${MAX_BATCHES_PER_RUN} settlement transactions`;
      issues.push(
        `Pay supports up to ${MAX_RECIPIENTS_PER_RUN} recipients per payout (${txCopy}).${roadmap}`,
      );
    }
    if (!tokenAddress) {
      issues.push(
        `${token} isn't deployed on this network — pick another token in Step 2.`,
      );
    }
    const seen = new Set<string>();
    const unverifiedLabels: string[] = [];
    for (const r of rows) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(r.address)) {
        issues.push(`Invalid address: ${r.address || "(empty)"}`);
      } else if (seen.has(r.address.toLowerCase())) {
        issues.push(`Duplicate address: ${r.address}`);
      } else {
        // Only addresses that pass shape + duplicate checks are
        // worth probing — invalid strings would always return null.
        const v = recipientIdentity.get(r.address);
        // `null` = lookup pending; treat as OK at submit-time so a
        // slow RPC doesn't block valid runs. Once it resolves and
        // surfaces an unverified state, validation re-runs.
        if (v && !v.isVerified) {
          unverifiedLabels.push(r.name || r.address);
        }
      }
      seen.add(r.address.toLowerCase());
      const n = parseAmount(r.amount);
      if (!r.amount || !Number.isFinite(n) || n <= 0) {
        issues.push(`Invalid amount for ${r.name || r.address}`);
      }
    }
    if (unverifiedLabels.length > 0) {
      const preview = unverifiedLabels.slice(0, 3).join(", ");
      const tail =
        unverifiedLabels.length > 3
          ? ` and ${unverifiedLabels.length - 3} more`
          : "";
      issues.push(
        `Unverified recipient${unverifiedLabels.length === 1 ? "" : "s"}: ${preview}${tail}. They must complete zk-X509 verification before they can claim.`,
      );
    }
    if (!claimFrom) {
      issues.push("Set the claim time in the Recipients step.");
    }
    // Funds-step concerns (shortfallRaw, multiBatchFit.covered) are
    // intentionally NOT included here — the Step 3 → 4 next-button
    // is gated on `validation.length > 0`, and the only way to fix a
    // shortfall is to advance to Step 4 and deposit more. They're
    // already enforced separately by `step4Block` and the submit
    // button's pre-submit check, so duplicating them here would
    // trap users on Step 3.
    return issues.slice(0, 5);
  }, [
    rows,
    recipientIdentity,
    tokenAddress,
    token,
    claimFrom,
  ]);

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">
        {resume.kind === "ready" ? "Resume payout" : "New payout"}
      </h1>

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
            Category, label, token, and recipient list are locked so the
            merged record stays a faithful continuation. Pick fresh source
            notes in the Funds step — vault state has shifted since the
            original run.
          </div>
        </div>
      )}

      <Stepper step={step} onJump={setStep} />

      <div className="flex items-end justify-between">
        <h2 className="text-lg font-semibold text-[var(--color-text-muted)]">
          {label || "(untitled)"}
        </h2>
        {resume.kind !== "ready" && draftSavedAt && (
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            <span title={new Date(draftSavedAt * 1000).toLocaleString()}>
              Draft saved {formatRelativeAgo(draftSavedAt)}
            </span>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        {step === 1 && (
          <div className="space-y-5">
            <div>
              <h2 className="text-lg font-semibold">Choose a category</h2>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                Categories pre-fill the run label, default token, and export format. You can change anything later.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  disabled={!!resumeRecord}
                  onClick={() => pickCategory(c.id)}
                  className={`rounded-xl border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                    categoryId === c.id
                      ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)]"
                      : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-border-strong)]"
                  }`}
                >
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-primary)]">
                    {c.name}
                  </div>
                  <div className="mt-1 font-semibold">{c.tagline}</div>
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">{c.body}</p>
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
              <Field
                label="Chain"
                hint="Pay is wired to one chain per deployment. Multi-chain switching arrives once the contracts ship to additional networks."
              >
                <input
                  value={chain}
                  disabled
                  className="w-full cursor-not-allowed rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[var(--color-text-muted)]"
                />
              </Field>
              <Field label="Token">
                <select
                  value={token}
                  disabled={!!resumeRecord}
                  onChange={(e) => setToken(e.target.value)}
                  className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {/* Resuming a saved run: the token is fixed and the
                      select is disabled, so render the full curated list
                      — if the run's token was since de-whitelisted it
                      must still show (filtering it out would blank the
                      value). New runs use the whitelist-filtered list. */}
                  {(resumeRecord ? curatedTokens : selectableTokens).map((t) => (
                    <option key={t.symbol} value={t.symbol}>
                      {t.symbol}
                      {isConfiguredAddress(t.address) ? "" : " (not deployed)"}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
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
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={!!resumeRecord}
                    className="rounded border border-[var(--color-border-strong)] px-2 py-1 hover:bg-[var(--color-primary-soft)] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Upload CSV / Excel
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleRecipientFile(f);
                      // Reset so picking the same filename twice still fires onChange.
                      e.target.value = "";
                    }}
                  />
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-[var(--color-text-muted)]">Download sample:</span>
                  <a
                    href="/samples/recipients-sample.csv"
                    download
                    className="rounded border border-[var(--color-border-strong)] px-2 py-1 font-medium hover:bg-[var(--color-primary-soft)]"
                  >
                    ↓ Sample CSV
                  </a>
                  <a
                    href="/samples/recipients-sample.xlsx"
                    download
                    className="rounded border border-[var(--color-border-strong)] px-2 py-1 font-medium hover:bg-[var(--color-primary-soft)]"
                  >
                    ↓ Sample Excel
                  </a>
                </div>
                {addressBookHint && (
                  <span id="abp-hint" className="text-[10px] text-[var(--color-text-subtle)]">
                    {addressBookHint}
                  </span>
                )}
              </div>
            </div>
            {(() => {
              const empty = rows.length === 0;
              const missingAmount =
                rows.length > 0 && rows.some((r) => !r.amount.trim());
              const warnClass = "font-semibold text-[var(--color-warning)]";
              return (
                <div className="text-xs text-[var(--color-text-muted)]">
                  Format:{" "}
                  <span className="font-mono">
                    <span className={empty ? warnClass : ""}>
                      {category.identifierLabel.toLowerCase()}
                    </span>
                    ,
                    <span className={empty ? warnClass : ""}>address</span>
                    ,
                    <span className={empty || missingAmount ? warnClass : ""}>
                      amount
                    </span>
                  </span>{" "}
                  — one per line. Amounts are in the selected token (e.g. 3500.00 USDC).
                  Optional column via upload: <span className="font-mono">email</span>.
                  {empty ? (
                    <span className="ml-2 text-[var(--color-warning)]">
                      ← add at least one recipient line below.
                    </span>
                  ) : missingAmount ? (
                    <span className="ml-2 text-[var(--color-warning)]">
                      ← fill the amount column on every row.
                    </span>
                  ) : null}
                </div>
              );
            })()}
            {uploadStatus && (
              <div
                className={`rounded-md border px-3 py-2 text-xs ${UPLOAD_STATUS_STYLES[uploadStatus.kind]}`}
                role={uploadStatus.kind === "error" ? "alert" : "status"}
              >
                <div className="flex items-start justify-between gap-3">
                  <span>{uploadStatus.message}</span>
                  <button
                    aria-label="Dismiss"
                    onClick={() => setUploadStatus(null)}
                    className="text-[10px] underline opacity-70 hover:opacity-100"
                  >
                    dismiss
                  </button>
                </div>
              </div>
            )}
            <div className="flex border-b border-[var(--color-border)] text-xs">
              {(["csv", "spreadsheet"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setEditMode(m)}
                  aria-pressed={editMode === m}
                  className={`px-3 py-1.5 ${
                    editMode === m
                      ? "border-b-2 border-[var(--color-primary)] font-medium text-[var(--color-primary)]"
                      : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  }`}
                >
                  {m === "csv" ? "CSV" : "Spreadsheet"}
                </button>
              ))}
            </div>
            {editMode === "csv" ? (
              (() => {
                const empty = rows.length === 0;
                const missingAmount =
                  rows.length > 0 && rows.some((r) => !r.amount.trim());
                const needsAttention = empty || missingAmount;
                return (
                  <textarea
                    value={csv}
                    readOnly={!!resumeRecord}
                    onChange={(e) => setCsv(e.target.value)}
                    rows={8}
                    className={`w-full rounded-md border bg-white p-3 font-mono text-sm read-only:cursor-not-allowed read-only:opacity-70 ${
                      needsAttention
                        ? "border-[var(--color-warning)]"
                        : "border-[var(--color-border-strong)]"
                    }`}
                    placeholder={`${category.identifierLabel.toLowerCase()},address,amount`}
                  />
                );
              })()
            ) : (
              <SpreadsheetEditor
                csv={csv}
                onCsvChange={setCsv}
                columns={SPREADSHEET_COLUMNS}
                readOnly={!!resumeRecord}
              />
            )}
            {category.reasonLabel && (
              <Field label={category.reasonLabel}>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={REASON_PLACEHOLDER[category.id]}
                  className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
                />
              </Field>
            )}

            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
              <h3 className="text-sm font-semibold">Claim schedule</h3>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                When can recipients start claiming? Pick a moment at least{" "}
                {CLAIM_FROM_BUFFER_MINUTES} minutes from now so the settle tx
                lands and the claim links reach recipients before the window
                opens.
              </p>
              <div className="mt-3 max-w-xs">
                <Field label="Available from">
                  <input
                    type="datetime-local"
                    step={1}
                    value={claimFrom ?? ""}
                    min={claimFromMinRef.current ?? ""}
                    disabled={!!resumeRecord}
                    onChange={(e) => setClaimFrom(e.target.value)}
                    className={`w-full rounded-md border bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60 ${
                      claimFromTooEarly
                        ? "border-[var(--color-warning)]"
                        : "border-[var(--color-border-strong)]"
                    }`}
                  />
                </Field>
              </div>
              {claimFromTooEarly ? (
                <p className="mt-2 text-xs font-medium text-[var(--color-warning)]">
                  Claim time must be at least {CLAIM_FROM_BUFFER_MINUTES} minutes
                  from now.
                </p>
              ) : (
                <p className="mt-2 text-[10px] text-[var(--color-text-subtle)]">
                  Recipients can claim any time after the moment set above — there is no expiry.
                </p>
              )}
            </div>

            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
              <div className="mb-2 text-xs font-semibold text-[var(--color-text-muted)]">Preview</div>
              <table className="w-full text-sm">
                <thead className="text-xs text-[var(--color-text-subtle)]">
                  <tr>
                    <th className="text-left">{category.identifierLabel}</th>
                    <th className="text-left">Address</th>
                    <th className="text-left pl-3">Identity</th>
                    <th className="text-right">Amount</th>
                    <th className="text-left pl-3">Available from</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, MAX_RECIPIENTS_PER_RUN).map((r, i) => {
                    // Per-row zk-X509 status: surface verified vs
                    // unverified vs still-loading inline so the
                    // operator doesn't have to cross-reference the
                    // names in the "Fix before continuing" banner
                    // back to the table.
                    const shapeOk = /^0x[a-fA-F0-9]{40}$/.test(r.address);
                    // `recipientIdentity.get()` returns `AddressVerification | null`
                    // (never `undefined`); the inner `BatchCheckerContext.get`
                    // already lowercases the address before the cache lookup, so
                    // raw / checksummed / lowercase recipients all hit the same
                    // entry — no extra normalize call needed here.
                    const v = shapeOk ? recipientIdentity.get(r.address) : null;
                    let identityCell: ReactNode;
                    if (!shapeOk) {
                      identityCell = (
                        <span className="text-[var(--color-text-subtle)]">—</span>
                      );
                    } else if (v === null) {
                      identityCell = (
                        <span className="text-[var(--color-text-subtle)]">Checking…</span>
                      );
                    } else if (v.isVerified) {
                      identityCell = (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-success-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-success)]">
                          <span aria-hidden>✓</span>
                          Verified
                        </span>
                      );
                    } else {
                      identityCell = (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-warning-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-warning)]">
                          <span aria-hidden>!</span>
                          Unverified
                        </span>
                      );
                    }
                    return (
                      <tr key={`${r.address}-${i}`} className="border-t border-[var(--color-border)]">
                        <td className="py-1.5">{r.name}</td>
                        <td className="py-1.5 font-mono text-xs">{r.address.slice(0, 10)}…{r.address.slice(-4)}</td>
                        <td className="py-1.5 pl-3">{identityCell}</td>
                        <td className="py-1.5 text-right font-mono">{r.amount} {token}</td>
                        <td className="py-1.5 pl-3 text-xs text-[var(--color-text-muted)]">
                          {claimFrom ? formatClaimFrom(claimFrom) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {rows.length > MAX_RECIPIENTS_PER_RUN && (
                <div className="mt-2 text-xs text-[var(--color-warning)]">
                  …and {rows.length - MAX_RECIPIENTS_PER_RUN} more rows hidden
                  (preview capped at {MAX_RECIPIENTS_PER_RUN}).
                </div>
              )}
              <div className="mt-3 flex justify-between text-sm">
                <span
                  className={
                    rows.length > MAX_RECIPIENTS_PER_RUN
                      ? "font-semibold text-[var(--color-warning)]"
                      : "text-[var(--color-text-muted)]"
                  }
                >
                  {rows.length} / {MAX_RECIPIENTS_PER_RUN} recipients
                </span>
                {/* Format from the exact bigint sum — float toLocaleString()
                    caps at 3 fraction digits and would show 0.0005 ETH as
                    "0.001". Lenient sum so a mid-edit invalid row doesn't
                    blank the figure. */}
                <span className="font-semibold">{ethers.formatUnits(displayTotalRaw, decimals)} {token}</span>
              </div>
            </div>
            {validation.length > 0 && (
              <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
                <div className="mb-1 font-semibold">Fix before continuing</div>
                <ul className="list-disc space-y-0.5 pl-4">
                  {validation.map((v, i) => <li key={`${i}:${v}`}>{v}</li>)}
                </ul>
              </div>
            )}

          </div>
        )}

        {step === 4 && (
          <FundsStep
            funds={{
              token,
              decimals,
              requiredRaw,
              feeRaw,
              serviceFeeRaw,
              claimReserveRaw,
              claimFeePerRecipientRaw,
              recipientCount: rows.length,
              totalEscrowRaw,
              availableRaw,
              pendingRaw,
              shortfallRaw,
            }}
            pick={{
              sourcePick,
              batchCount: batches.length,
              multiBatchFit,
              tokenNotes,
              selectedIds: selectedNoteIds,
              onToggle: toggleNoteSelection,
              onSelect: selectSingleNote,
            }}
            wallet={{ account, vaultLoaded }}
            relayer={{
              list: relayers,
              selected: relayer,
              registryConfigured,
              select: selectRelayer,
              maxFeeBps,
              setMaxFeeBps,
            }}
            onRecheck={tree.refresh}
            explorerBase={networkCfg.explorerBase}
            depositBusy={
              depositPhase != null &&
              !TERMINAL_DEPOSIT_PHASES.has(depositPhase.kind)
            }
            onDeposit={() => {
              // Synchronous lock first — state-based checks would
              // race a same-frame double-click and start two flows.
              if (depositInFlightRef.current) return;
              if (!signer || !account) return;
              // Durable guard against a *second* deposit while the first
              // is still confirming. `realDeposit` persists the note to
              // the vault before awaiting the receipt, so a freshly-
              // submitted deposit is a recent pending note — vault-
              // derived, so it survives a reload / tab swap (where the
              // in-flight ref would be lost). Time-bounded so a stale /
              // phantom / discarded pending note can't block deposits
              // forever. Without this, "wallet kept prompting → kept
              // approving" produced two on-chain deposits (lot-1 + lot-2).
              if (hasConfirmingDeposit(tokenNotes, Date.now())) {
                setDepositPhase({
                  kind: "error",
                  error:
                    "A previous deposit is still confirming on-chain (see Deposit balance below). " +
                    "Wait for it to settle before depositing again — re-depositing now would lock " +
                    "the funds in a second, separate note.",
                });
                return;
              }
              depositInFlightRef.current = true;
              const ctrl = new AbortController();
              depositAbortRef.current = ctrl;
              setDepositPhase({ kind: "preparing" });
              // Persist the run before the long on-chain confirm so the
              // escrowed funds stay tied to their recipient list even if
              // the tab is closed / crashes mid-wait. Best-effort —
              // never block or fail the deposit on a draft-save error.
              void saveDraftNow();
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

            <ReviewSection title="Run">
              <ReviewRow k="Category" v={category.name} />
              <ReviewRow k="Label" v={label} />
              <ReviewRow k="Chain" v={chain} />
              <ReviewRow k="Token" v={token} />
              <ReviewRow k="Recipients" v={`${rows.length}`} />
              {category.reasonLabel && <ReviewRow k={category.reasonLabel} v={reason || "—"} />}
            </ReviewSection>

            <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[var(--color-text-muted)]">
                  Recipients ({rows.length})
                </h3>
                <button
                  type="button"
                  onClick={() => downloadOrderbook(rows, label, token, chain, claimFrom)}
                  className="rounded-md border border-[var(--color-border-strong)] px-2 py-1 text-xs hover:bg-[var(--color-bg)]"
                >
                  Download CSV
                </button>
              </div>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-[var(--color-text-muted)]">
                    <tr>
                      <th className="py-1 text-left font-normal">Name</th>
                      <th className="py-1 text-left font-normal">Address</th>
                      <th className="py-1 text-right font-normal">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-border)]">
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td className="py-1.5 pr-2">{r.name || "—"}</td>
                        <td className="py-1.5 pr-2 font-mono text-xs">
                          {r.address ? `${r.address.slice(0, 8)}…${r.address.slice(-4)}` : "—"}
                        </td>
                        <td className="py-1.5 text-right font-mono">
                          {r.amount} {token}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <ReviewSection title="Amounts">
              <ReviewRow
                k="Recipients total"
                v={`${ethers.formatUnits(requiredRaw, decimals)} ${token}`}
              />
              <ReviewRow
                k="Relayer fee (max)"
                v={`${ethers.formatUnits(feeRaw, decimals)} ${token}`}
              />
              <ReviewRow
                k="Order amount (recipients + fee)"
                v={
                  <strong>
                    {ethers.formatUnits(requiredRaw + feeRaw, decimals)} {token}
                  </strong>
                }
              />
            </ReviewSection>

            <ReviewSection title="Schedule">
              <ReviewRow
                k="Available to claim from"
                v={
                  claimFromTooEarly ? (
                    <div className="flex flex-col items-end gap-1">
                      <input
                        type="datetime-local"
                        step={1}
                        value={claimFrom ?? ""}
                        min={claimFromMin()}
                        onChange={(e) => setClaimFrom(e.target.value)}
                        className="rounded-md border border-[var(--color-warning)] bg-white px-3 py-1.5 text-sm"
                      />
                      <span className="text-xs text-[var(--color-warning)]">
                        Claim time has passed (or is within {CLAIM_FROM_BUFFER_MINUTES} min). Pick a new moment.
                      </span>
                    </div>
                  ) : (
                    claimFrom ?? "—"
                  )
                }
              />
            </ReviewSection>

            <ReviewSection title="Settlement">
              <ReviewRow
                k="Relayer"
                v={
                  relayer
                    ? `${relayer.name && relayer.name.length > 0 ? relayer.name : relayer.api?.name ?? `${relayer.address.slice(0, 10)}…`}`
                    : "—"
                }
              />
              <ReviewRow
                k="Relayer fee (actual)"
                v={(() => {
                  // Actual fee billed = relayer's on-chain rate, capped
                  // by the user's max. The Amounts section above shows
                  // the cap (max) so the user sees both the worst-case
                  // escrow figure and the bill they should expect.
                  const effectiveBps = relayer
                    ? Math.min(relayer.fee, safeMaxFeeBps)
                    : safeMaxFeeBps;
                  const actualFee =
                    (requiredRaw * BigInt(effectiveBps)) / 10_000n;
                  return `${ethers.formatUnits(actualFee, decimals)} ${token}`;
                })()}
              />
              <ReviewRow
                k="Spent from deposits"
                v={`${ethers.formatUnits(sourcePick.pickedRaw, decimals)} ${token}`}
              />
              {sourcePick.changeRaw > 0n && (
                <ReviewRow
                  k="Change returned"
                  v={`${ethers.formatUnits(sourcePick.changeRaw, decimals)} ${token}`}
                />
              )}
              <ReviewRow k="Estimated gas" v="~$0.50 (one tx · varies by chain)" />
            </ReviewSection>
            <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
              <strong className="mb-0.5 block">This cannot be reversed.</strong>
              Once signed and settled, recipients can claim any time after the
              date above — forever. The sender cannot recall a settled run.
            </div>
            {tier && (
              <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs">
                <div className="mb-1 flex items-center justify-between font-semibold text-[var(--color-text-muted)]">
                  <span>Privacy plan</span>
                  <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide">
                    Tier {tier.cap}
                  </span>
                </div>
                <div className="text-[var(--color-text-muted)]">
                  {batches.length === 1 ? (
                    <>
                      One private transaction —{" "}
                      <strong>{rows.length}</strong> real recipients hidden
                      inside an anonymity set of <strong>{tier.cap}</strong>.
                      One signature.
                    </>
                  ) : (
                    <>
                      <strong>{rows.length}</strong> recipients spread across{" "}
                      <strong>{batches.length}</strong> tier-{tier.cap}{" "}
                      settlements (one signature per batch). A larger circuit
                      that covers all recipients in one batch
                      {PLANNED_TIER_CAPS.length > 0 ? (
                        <>
                          {" "}
                          (tier{" "}
                          {PLANNED_TIER_CAPS.find((c) => c >= rows.length) ??
                            PLANNED_TIER_CAPS[PLANNED_TIER_CAPS.length - 1]}
                          )
                        </>
                      ) : null}{" "}
                      is planned but not yet live.
                    </>
                  )}
                </div>
              </div>
            )}
            <button
              disabled={
                validation.length > 0 ||
                submitting ||
                claimFromTooEarly ||
                shortfallRaw > 0n ||
                (multiBatchFit !== null && !multiBatchFit.covered)
              }
              title={
                claimFromTooEarly
                  ? `Claim time must be at least ${CLAIM_FROM_BUFFER_MINUTES} minutes from now`
                  : shortfallRaw > 0n
                    ? `Funds short by ${ethers.formatUnits(shortfallRaw, decimals)} ${token} — top up in Step 4`
                    : multiBatchFit && !multiBatchFit.covered
                      ? "Source notes don't fit the batched settlement — adjust in Step 4"
                      : undefined
              }
              onClick={() => {
                if (total >= LARGE_AMOUNT_THRESHOLD) setShowConfirm(true);
                else void doSubmit();
              }}
              className="w-full rounded-lg bg-[var(--color-primary)] py-3 font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
            >
              {submitting ? "Proving + submitting…" : "Sign & submit"}
            </button>
            {submitError && (
              <div className="space-y-2 rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
                <strong className="block">Submit failed</strong>
                <p>
                  {submitError.kind === "total"
                    ? submitError.recoverable
                      ? "Nothing was sent on-chain. Your inputs are still saved as a draft — pick it back up from the dashboard whenever you want to retry."
                      : "Nothing was sent on-chain. Your inputs were not saved (no notes folder attached) — keep this tab open and retry, or attach a folder to enable draft persistence."
                    : submitError.recoverable
                      ? "Some batches landed on-chain but the run did not finish. The partial result is saved — open it from the dashboard to resume the remaining recipients."
                      : "Some batches landed on-chain but the run did not finish, and the partial record could not be saved. Copy the details below before navigating away — you'll need them to recover the run."}
                </p>
                {submitError.recoverable && (
                  <Link
                    href="/dashboard"
                    className="inline-block rounded-md border border-[var(--color-warning)] px-2.5 py-1 font-medium hover:bg-[var(--color-warning)] hover:text-white"
                  >
                    {submitError.kind === "total" ? "Go to drafts" : "Go to dashboard"}
                  </Link>
                )}
                <details className="text-[var(--color-text-muted)]">
                  <summary className="cursor-pointer text-[10px] uppercase tracking-wide">
                    Details
                  </summary>
                  <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[10px]">
                    {submitError.message}
                  </pre>
                </details>
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
          (() => {
            // Steps 3 and 4 each have prerequisites that must be in
            // place before the operator can move on. Step 3 covers the
            // CSV / claim-time inputs; step 4 (Funds) covers the
            // relayer pick + a covered-shortfall check so the Sign
            // step doesn't open with a half-funded run.
            const step3Block =
              step === 3 &&
              (rows.length === 0 ||
                !claimFrom ||
                claimFromTooEarly ||
                validation.length > 0);
            const step4Block =
              step === 4 &&
              (!relayer || !sourcePick.covered || !multiBatchFit?.covered);
            const blockNext = step3Block || step4Block;
            const nextDisableReason = step3Block
              ? rows.length === 0
                ? "Add at least one recipient"
                : !claimFrom
                  ? "Pick the claim-schedule moment"
                  : claimFromTooEarly
                    ? `Claim time must be at least ${CLAIM_FROM_BUFFER_MINUTES} minutes from now`
                    : "Fix the CSV errors above before continuing"
              : step4Block
                ? !relayer
                  ? "Pick a relayer to dispatch the settle tx"
                  : !sourcePick.covered
                    ? "Select deposits whose total covers the escrow amount"
                    : "Top up the shortfall before advancing to Review"
                : undefined;
            return (
              <div className="flex items-center gap-2">
                {resume.kind !== "ready" && (
                  <button
                    type="button"
                    disabled={!account || !label.trim() || !folder.ready}
                    title={
                      !account
                        ? "Connect a wallet to save drafts"
                        : !label.trim()
                        ? "Enter a label first"
                        : !folder.ready
                        ? "Pick a notes folder in the dashboard before saving drafts"
                        : "Save now and sync the URL so refresh resumes this draft"
                    }
                    onClick={() => {
                      void saveDraftNow().then((saved) => {
                        if (!saved) return;
                        setDraftJustSaved(true);
                        window.setTimeout(() => setDraftJustSaved(false), 1500);
                      });
                    }}
                    className={`rounded-md border px-4 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed ${
                      draftJustSaved
                        ? "border-[var(--color-success,green)] bg-[var(--color-success-soft,#e6f4ea)] text-[var(--color-success,green)]"
                        : "border-[var(--color-border-strong)] hover:bg-[var(--color-bg)]"
                    }`}
                  >
                    {draftJustSaved ? "Saved ✓" : "Save draft"}
                  </button>
                )}
                <button
                  onClick={() => setStep((s) => s + 1)}
                  disabled={blockNext}
                  title={nextDisableReason}
                  className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
                >
                  Next
                </button>
                {draftSaveError && (
                  <span className="ml-2 text-xs text-[var(--color-warning)]">
                    Save failed: {draftSaveError}
                  </span>
                )}
              </div>
            );
          })()
        ) : null}
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
          getVerification={getAddressVerification}
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
    : isCancelled
    ? "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)]"
    : "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-success)]";
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
