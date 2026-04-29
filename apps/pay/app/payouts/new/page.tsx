"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
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
  realSettle,
  PHASE_1C_MULTI_BATCH_MSG,
  PHASE_1C_MULTI_NOTE_MSG,
} from "../../_lib/realSettle";
import { useCommitmentTree } from "../../_lib/commitmentTree";
import { getAuthorizeProver } from "../../_lib/authorizeProver";

// Largest tier with a live verifier — this caps Pay's per-run recipient
// count. Computed at module scope because ACTIVE_TIERS is a compile-time
// constant; recomputing it per render would be wasted work.
const MAX_ACTIVE_CAP = ACTIVE_TIERS[ACTIVE_TIERS.length - 1]!.cap;
// Tiers known to the SDK but not yet wired on-chain — used to surface
// the roadmap signal in user-facing validation messages without hard-
// coding "64 / 128" copy that drifts as tiers ship.
const PLANNED_TIER_CAPS = TIERS.filter((t) => !ACTIVE_TIERS.includes(t)).map((t) => t.cap);
import { useWallet } from "@zkscatter/sdk/react";
import {
  saveRun,
  type RecipientRow,
  type RunCategory,
  type RunRecord,
} from "@zkscatter/sdk/storage";
import { useVault } from "../../_lib/vault";
import { useEdDSAKey } from "../../_lib/eddsaKey";
import { useRelayers } from "../../_lib/relayers";
import { getNetworkConfig, isNetworkConfigured } from "../../_lib/network";
import { parseRecipientRows, tokenBigIntToAddress } from "../../_lib/format";
import { autoPickSourceNotes, type SourceNotesPick } from "../../_lib/sourceNotes";
import { useWalletBook } from "../../_lib/walletBook";
import { AddressBookPicker } from "../../_components/AddressBookPicker";
import { WorkspaceBar } from "../../_components/WorkspaceBar";
import { useFolderStorage } from "../../_lib/folderStorage";
import type { WalletEntry } from "@zkscatter/sdk/storage";
import type { RelayerInfo } from "@zkscatter/sdk/relayer";

type Row = { name: string; address: string; amount: string };

type TemplateId = "payroll" | "grants" | "bonus" | "contractor";

type Template = {
  id: TemplateId;
  name: string;
  tagline: string;
  body: string;
  defaultLabel: string;
  defaultToken: string;
  identifierLabel: string;
  reasonLabel?: string;
  sampleCsv: string;
  exportNote: string;
};

const TEMPLATES: Template[] = [
  {
    id: "payroll",
    name: "Payroll",
    tagline: "Monthly salaries",
    body: "Monthly salary run for employees. Withholding-friendly export.",
    defaultLabel: "April payroll",
    defaultToken: "USDC",
    identifierLabel: "Employee",
    sampleCsv: `Alice,0xab12cd34ef56789012345678901234567890abcd,3500
Bob,0xcd34ef56789012345678901234567890abcdef12,4200
Carol,0xef56789012345678901234567890abcdef123456,3800
Dan,0x789012345678901234567890abcdef1234567890,5000`,
    exportNote: "Payroll export includes per-employee breakdown for withholding reconciliation.",
  },
  {
    id: "grants",
    name: "Grants",
    tagline: "DAO grants",
    body: "Pay grant recipients from a Snapshot result or working group.",
    defaultLabel: "Q2 grants — public goods WG",
    defaultToken: "USDC",
    identifierLabel: "Recipient",
    reasonLabel: "Proposal / Snapshot link",
    sampleCsv: `Project Lighthouse,0xab12cd34ef56789012345678901234567890abcd,15000
ZK Toolkit,0xcd34ef56789012345678901234567890abcdef12,8000
Docs Crew,0xef56789012345678901234567890abcdef123456,4500`,
    exportNote: "Grants export pairs each transfer with its proposal link for transparency reports.",
  },
  {
    id: "bonus",
    name: "Bonus",
    tagline: "Bonuses & incentives",
    body: "One-off bonus rounds where size differences should stay private.",
    defaultLabel: "EOY bonus 2026",
    defaultToken: "USDC",
    identifierLabel: "Employee",
    reasonLabel: "Reason / approver",
    sampleCsv: `Alice,0xab12cd34ef56789012345678901234567890abcd,2000
Bob,0xcd34ef56789012345678901234567890abcdef12,3500
Carol,0xef56789012345678901234567890abcdef123456,1500`,
    exportNote: "Bonus export records the approver and reason against each line.",
  },
  {
    id: "contractor",
    name: "Contractor batch",
    tagline: "Freelancer settlement",
    body: "Settle a wave of contractors at once without leaking per-contractor rates.",
    defaultLabel: "April contractor settlement",
    defaultToken: "USDC",
    identifierLabel: "Contractor",
    reasonLabel: "Invoice reference",
    sampleCsv: `Studio North,0xab12cd34ef56789012345678901234567890abcd,6200
J. Park (design),0xcd34ef56789012345678901234567890abcdef12,2400
M. Lee (research),0xef56789012345678901234567890abcdef123456,3100`,
    exportNote: "Contractor export attaches invoice references for sole-proprietor accounting.",
  },
];

const STEPPER_LABELS = [
  "Template",
  "Token",
  "Recipients",
  "Funds",
  "Review & sign",
] as const;

// Default cap on what the relayer can deduct as a fee. Lives here
// until the org-settings page lands; the wizard exposes it as an
// override in the Funds step.
const DEFAULT_MAX_FEE_BPS = 30;

// TODO: read from org settings
const LARGE_AMOUNT_THRESHOLD = 50_000;

function today(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

const REASON_PLACEHOLDER: Record<TemplateId, string> = {
  payroll: "",
  grants: "https://snapshot.org/#/acme.eth/proposal/0x…",
  bonus: "Approved by CEO · EOY review cycle",
  contractor: "INV-2026-04-*",
};

// `123,456.78` and `1_000` style separators are common in spreadsheets
// — strip them before parseFloat so totals don't silently undercount.
function parseAmount(input: string): number {
  const cleaned = input.replace(/[,_\s]/g, "");
  if (cleaned === "" || !/^-?\d+(\.\d+)?$/.test(cleaned)) return NaN;
  return parseFloat(cleaned);
}

export default function NewPayout() {
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
  const { notes, loaded: vaultLoaded } = useVault();
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

  useEffect(() => {
    setClaimFrom(today());
  }, []);

  async function doSubmit() {
    setShowConfirm(false);
    setSubmitting(true);
    setSubmitError(null);
    let txHash: string | undefined;
    try {
      const cfg = getNetworkConfig();
      // Real submit is only attempted when the network is wired AND
      // the wizard has all the dependencies a single-batch
      // scatterDirectAuth needs. The env-not-configured path stays as
      // a record-only demo so the dashboard still has something to
      // render in unwired environments.
      if (isNetworkConfigured(cfg) && tokenAddress && batches.length > 0) {
        if (batches.length > 1) throw new Error(PHASE_1C_MULTI_BATCH_MSG);
        if (!signer) throw new Error("Connect a wallet before signing.");
        if (!relayer) throw new Error("Pick a relayer in the Funds step.");
        if (!sourcePick.covered || sourcePick.notes.length === 0) {
          throw new Error("No source note covers this run total — top up in the Funds step.");
        }
        if (sourcePick.notes.length > 1) throw new Error(PHASE_1C_MULTI_NOTE_MSG);
        // Overlap the EdDSA derivation with the worker boot + asset
        // warm-up. The zkey is ~19 MB; on a cold cache its fetch can
        // dwarf the ECDSA-derive round-trip with the wallet. Both
        // promises are independent so Promise.all is safe.
        const prover = getAuthorizeProver();
        const [kp] = await Promise.all([eddsa.derive(), prover.ready()]);
        const result = await realSettle({
          batch: batches[0]!,
          tokenAddress,
          source: sourcePick.notes[0]!,
          relayer,
          chain: { signer, settlementAddress: cfg.contracts.privateSettlement },
          maxFeeBps: safeMaxFeeBps,
          eddsaPrivateKey: kp.privateKey,
          tree,
        });
        txHash = result.txHash;
      }

      if (!folder.ready) {
        // No notes folder picked → can't persist the run record.
        // Fall back to the sample so the dashboard still has
        // something to render.
        router.push("/payouts/detail?id=p_2026_04_payroll");
        return;
      }

      const record = buildRunRecord({
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
      });
      await saveRun(record);
      router.push(`/payouts/detail?id=${encodeURIComponent(record.id)}`);
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

  // Strip CSV-breaking characters from a free-form label so a comma
  // or newline in the address-book entry doesn't shift columns.
  // The wizard's CSV parser is `line.split(",")` (no quoting), so the
  // simplest correctness guarantee is "labels can't contain commas
  // or newlines."
  function csvSafeLabel(label: string): string {
    return label.replace(/[,\n\r]/g, " ").trim();
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

  const availableRaw = useMemo<bigint>(() => {
    if (!tokenAddress) return 0n;
    let sum = 0n;
    for (const n of notes) {
      if (tokenBigIntToAddress(n.note.token) === tokenAddress) sum += n.note.amount;
    }
    return sum;
  }, [notes, tokenAddress]);

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
    () => autoPickSourceNotes(notes, tokenAddress ?? "", totalEscrowRaw),
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

  // The picked tier governs the on-chain settlement layout for this
  // run. Returns null when the recipient count is empty or exceeds
  // the active-tier ceiling — `validation` below surfaces the latter
  // as a user-facing error so we don't need a separate guard here.
  const tier = useMemo<CircuitTier | null>(() => {
    if (rows.length === 0 || rows.length > MAX_ACTIVE_CAP) return null;
    const picked = pickTier(rows.length);
    return ACTIVE_TIERS.includes(picked) ? picked : null;
  }, [rows.length]);

  const validation = useMemo(() => {
    const issues: string[] = [];
    // Cap-exceeded comes first because it blocks the run regardless of
    // per-row fixes — and slice(0, 5) below would otherwise hide it
    // behind five ordinary validation errors.
    if (rows.length > MAX_ACTIVE_CAP) {
      const roadmap = PLANNED_TIER_CAPS.length > 0
        ? ` Larger circuits (${PLANNED_TIER_CAPS.join(" / ")}) are planned — split this list across runs for now.`
        : "";
      issues.push(
        `Pay supports up to ${MAX_ACTIVE_CAP} recipients per payout.${roadmap}`,
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
                  onClick={() => pickTemplate(t.id)}
                  className={`rounded-xl border p-4 text-left transition ${
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
                  onChange={(e) => setLabel(e.target.value)}
                  className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
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
                  onChange={(e) => setToken(e.target.value)}
                  className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
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
              onChange={(e) => setCsv(e.target.value)}
              rows={8}
              className="w-full rounded-md border border-[var(--color-border-strong)] bg-white p-3 font-mono text-sm"
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
                    onChange={(e) => setClaimFrom(e.target.value)}
                    className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
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
            token={token}
            decimals={decimals}
            requiredRaw={requiredRaw}
            feeRaw={feeRaw}
            totalEscrowRaw={totalEscrowRaw}
            availableRaw={availableRaw}
            shortfallRaw={shortfallRaw}
            sourcePick={sourcePick}
            account={account}
            vaultLoaded={vaultLoaded}
            relayers={relayers}
            relayer={relayer}
            registryConfigured={registryConfigured}
            selectRelayer={selectRelayer}
            maxFeeBps={maxFeeBps}
            setMaxFeeBps={setMaxFeeBps}
            onDeposit={() =>
              dryRunDeposit({ tokenSymbol: token, amountRaw: shortfallRaw, account, eddsa })
            }
          />
        )}

        {step === 5 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Review & sign</h2>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 divide-y divide-[var(--color-border)] text-sm">
              <Row k="Template" v={template.name} />
              <Row k="Label" v={label} />
              <Row k="Chain" v={chain} />
              <Row k="Token" v={token} />
              <Row k="Recipients" v={`${rows.length}`} />
              <Row k="Total" v={`${total.toLocaleString()} ${token}`} />
              <Row k="Available to claim from" v={claimFrom ?? "—"} />
              {template.reasonLabel && <Row k={template.reasonLabel} v={reason || "—"} />}
              <Row k="Stealth" v={stealth ? "Yes" : "No"} />
              <Row k="Notification" v={notify ? "Email + Discord" : "None"} />
              <Row k="Estimated gas" v="~$0.50 (one tx · varies by chain)" />
              <Row k="Scatter Pay fee" v="Free (launch event until Dec 31, 2026 · normally 0.05%, capped at $20)" />
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
                  Tier {tier.cap} settlement — one private transaction with{" "}
                  <strong>{rows.length}</strong> real recipients hidden inside an
                  anonymity set of <strong>{tier.cap}</strong>. One signature.
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

function ConfirmLargeAmount({
  total,
  token,
  recipients,
  onCancel,
  onConfirm,
}: {
  total: number;
  token: string;
  recipients: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-xl">
        <h3 className="text-lg font-semibold">Confirm large payout</h3>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          You&apos;re about to send{" "}
          <strong>{total.toLocaleString()} {token}</strong> to{" "}
          <strong>{recipients} recipients</strong>. Once signed, this run
          cannot be reversed — recipients can claim it any time, forever.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-[var(--color-border-strong)] px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            Sign & submit
          </button>
        </div>
      </div>
    </div>
  );
}

function Stepper({ step, onJump }: { step: number; onJump: (n: number) => void }) {
  return (
    <div className="flex gap-2">
      {STEPPER_LABELS.map((l, i) => {
        const n = i + 1;
        const active = n === step;
        const done = n < step;
        const clickable = done || active;
        return (
          <button
            key={l}
            disabled={!clickable}
            onClick={() => clickable && onJump(n)}
            className={`flex-1 rounded-md border px-3 py-2 text-left text-sm ${
              active
                ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
                : done
                ? "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)]"
                : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-subtle)]"
            }`}
          >
            <span className="mr-2 font-semibold">{n}</span>
            {l}
          </button>
        );
      })}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-semibold text-[var(--color-text-muted)]">{label}</span>
      {children}
    </label>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="py-2 text-[var(--color-text-muted)]">{k}</dt>
      <dd className="py-2 text-right font-medium">{v}</dd>
    </>
  );
}

function BalancePanel({
  token,
  decimals,
  availableRaw,
  requiredRaw,
  shortfallRaw,
  account,
  vaultLoaded,
  showRequired,
  onDeposit,
}: {
  token: string;
  decimals: number;
  availableRaw: bigint;
  requiredRaw: bigint;
  shortfallRaw: bigint;
  account: string | null;
  vaultLoaded: boolean;
  /** When false (e.g. step 2 before recipients exist) only Available
   *  is shown. The Required / Shortfall lines need real recipient
   *  entries, so they're hidden until step 3+. */
  showRequired: boolean;
  onDeposit: () => void;
}) {
  const fmt = (raw: bigint) => ethers.formatUnits(raw, decimals);
  const configured = isNetworkConfigured(getNetworkConfig());

  if (!account) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
        Connect a wallet to see your available pool balance.
      </div>
    );
  }
  if (!vaultLoaded) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
        Reading your vault…
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs">
      <div className="flex justify-between">
        <span className="text-[var(--color-text-muted)]">Available {token}</span>
        <span className="font-mono">{fmt(availableRaw)}</span>
      </div>
      {showRequired && requiredRaw > 0n && (
        <div className="mt-1 flex justify-between">
          <span className="text-[var(--color-text-muted)]">Required for run</span>
          <span className="font-mono">{fmt(requiredRaw)}</span>
        </div>
      )}
      {showRequired && shortfallRaw > 0n && (
        <div className="mt-2 rounded border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-2 text-[var(--color-warning)]">
          <div className="mb-1">
            Shortfall: <strong>{fmt(shortfallRaw)} {token}</strong>. Top up before signing.
          </div>
          <DepositButton
            account={account}
            configured={configured}
            label={`Deposit ${fmt(shortfallRaw)} ${token}`}
            onClick={onDeposit}
          />
        </div>
      )}
    </div>
  );
}

interface DryRunDepositArgs {
  tokenSymbol: string;
  amountRaw: bigint;
  account: string | null;
  eddsa: ReturnType<typeof useEdDSAKey>;
}

async function dryRunDeposit({ tokenSymbol, amountRaw, account, eddsa }: DryRunDepositArgs) {
  const tokenInfo = LAUNCH_TOKENS[tokenSymbol];
  if (!account || !tokenInfo) return;
  const cfg = getNetworkConfig();
  let publicKey: readonly [bigint, bigint] | null = null;
  try {
    const kp = await eddsa.derive();
    publicKey = kp.publicKey;
  } catch (err) {
    console.warn("[Pay dry-run] EdDSA key not derived — deposit input will be incomplete", err);
  }
  // Phase B will replace this log with `ensureAllowance + generateDepositProof + callDeposit`.
  console.info("[Pay dry-run] deposit", {
    chainId: cfg.chainId,
    pool: cfg.contracts.commitmentPool,
    settlement: cfg.contracts.privateSettlement,
    token: tokenInfo.address,
    amount: amountRaw.toString(),
    account,
    publicKey: publicKey ? [publicKey[0].toString(), publicKey[1].toString()] : null,
  });
}

interface FundsStepProps {
  token: string;
  decimals: number;
  requiredRaw: bigint;
  feeRaw: bigint;
  totalEscrowRaw: bigint;
  availableRaw: bigint;
  shortfallRaw: bigint;
  sourcePick: SourceNotesPick;
  account: string | null;
  vaultLoaded: boolean;
  relayers: RelayerInfo[];
  relayer: RelayerInfo | null;
  registryConfigured: boolean;
  selectRelayer: (address: string) => void;
  maxFeeBps: number;
  setMaxFeeBps: (bps: number) => void;
  onDeposit: () => void;
}

function FundsStep({
  token,
  decimals,
  requiredRaw,
  feeRaw,
  totalEscrowRaw,
  availableRaw,
  shortfallRaw,
  sourcePick,
  account,
  vaultLoaded,
  relayers,
  relayer,
  registryConfigured,
  selectRelayer,
  maxFeeBps,
  setMaxFeeBps,
  onDeposit,
}: FundsStepProps) {
  const fmt = (raw: bigint) => ethers.formatUnits(raw, decimals);
  const configured = isNetworkConfigured(getNetworkConfig());
  const onlineRelayers = relayers.filter((r) => r.online);
  // Keep the currently-selected relayer in the dropdown even after it
  // goes offline so the controlled <select> never has a `value` that
  // doesn't match an `<option>` (React would warn + show the wrong
  // entry). The offline option is rendered with a "(offline)" suffix
  // so the user can still see what they had picked.
  const relayerOptions =
    relayer && !relayer.online ? [relayer, ...onlineRelayers] : onlineRelayers;

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold">Funds</h2>
      <p className="text-xs text-[var(--color-text-muted)]">
        Pick a relayer, set the max fee cap, and confirm which already-deposited
        notes will fund this run. Top up via Deposit if there&apos;s a shortfall.
      </p>

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-xs">
        <h3 className="mb-2 text-sm font-semibold">Relayer</h3>
        {!registryConfigured ? (
          <div className="text-[var(--color-warning)]">
            No relayer registry configured. Set <span className="font-mono">NEXT_PUBLIC_PAY_RELAYER_REGISTRY</span> to enable signing.
          </div>
        ) : onlineRelayers.length === 0 ? (
          <div className="text-[var(--color-warning)]">
            No relayers online right now. Try again in a minute.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Selected relayer">
              <select
                value={relayer?.address ?? ""}
                onChange={(e) => selectRelayer(e.target.value)}
                className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-xs"
              >
                {relayerOptions.map((r) => (
                  <option key={r.address} value={r.address}>
                    {r.api?.name ?? r.address.slice(0, 10)}… · {r.fee} bps
                    {r.online ? "" : " (offline)"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Max fee (bps)">
              <input
                type="number"
                min={0}
                max={1000}
                step={1}
                value={maxFeeBps}
                onChange={(e) =>
                  setMaxFeeBps(Math.max(0, Math.min(1000, Math.trunc(Number(e.target.value) || 0))))
                }
                className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-xs"
              />
            </Field>
          </div>
        )}
      </div>

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-xs">
        <h3 className="mb-2 text-sm font-semibold">Required to escrow</h3>
        <dl className="space-y-1 font-mono">
          <FundsRow k="Recipients total" v={`${fmt(requiredRaw)} ${token}`} />
          <FundsRow k={`Fee at max (${maxFeeBps} bps)`} v={`${fmt(feeRaw)} ${token}`} />
          <FundsRow k="Total to escrow" v={`${fmt(totalEscrowRaw)} ${token}`} bold />
        </dl>
      </div>

      {!account ? (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
          Connect a wallet to see your source notes.
        </div>
      ) : !vaultLoaded ? (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
          Reading your vault…
        </div>
      ) : (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-xs">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Source notes (auto-pick)</h3>
            <button
              disabled
              title="Manual selection arrives in Phase E"
              className="rounded border border-[var(--color-border-strong)] px-2 py-1 text-[var(--color-text-subtle)] opacity-40"
            >
              Change selection
            </button>
          </div>
          <div className="mb-2 text-[var(--color-text-muted)]">
            Available: <span className="font-mono">{fmt(availableRaw)} {token}</span>
          </div>
          {sourcePick.notes.length > 0 ? (
            <ul className="space-y-0.5 font-mono">
              {sourcePick.notes.map(({ note: n, spend }) => (
                <li key={n.id} className="flex justify-between">
                  <span>
                    {n.label} · deposited {new Date(n.createdAt).toISOString().slice(0, 10)}
                  </span>
                  <span>
                    {fmt(spend)} / {fmt(n.note.amount)} {token}
                  </span>
                </li>
              ))}
              <li className="mt-2 flex justify-between border-t border-[var(--color-border)] pt-2 text-[var(--color-text-muted)]">
                <span>Change after run (new note)</span>
                <span>{fmt(sourcePick.changeRaw)} {token}</span>
              </li>
            </ul>
          ) : (
            <div className="text-[var(--color-text-muted)]">
              {availableRaw > 0n
                ? "Matching notes are available, but they don't cover the run total. Deposit below to close the shortfall."
                : "No matching notes yet. Deposit below to fund this run."}
            </div>
          )}
        </div>
      )}

      {shortfallRaw > 0n && (
        <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
          <div className="mb-1">
            Shortfall: <strong>{fmt(shortfallRaw)} {token}</strong>. Top up before
            advancing to Review.
          </div>
          <DepositButton
            account={account}
            configured={configured}
            label={`Deposit ${fmt(shortfallRaw)} ${token}`}
            onClick={onDeposit}
          />
        </div>
      )}
    </div>
  );
}

function DepositButton({
  account,
  configured,
  label,
  onClick,
}: {
  account: string | null;
  configured: boolean;
  label: string;
  onClick: () => void;
}) {
  const disabled = !configured || !account;
  const reason = !account
    ? "Connect a wallet to deposit"
    : !configured
      ? "Set NEXT_PUBLIC_PAY_* contract addresses to enable deposits"
      : undefined;
  const text = !configured
    ? "Deposit (env not configured)"
    : !account
      ? "Deposit (connect wallet)"
      : label;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={reason}
      className="rounded bg-[var(--color-primary)] px-2 py-1 text-white disabled:opacity-40"
    >
      {text}
    </button>
  );
}

function FundsRow({ k, v, bold }: { k: string; v: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-semibold" : ""}`}>
      <dt className="text-[var(--color-text-muted)]">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

/** Mint a URL-safe id derived from the timestamp + a random suffix.
 *  Filenames key off this id (`zkscatter-run-<id>.json`) so collisions
 *  between two settles in the same second would silently overwrite —
 *  the random tail keeps each id unique without needing a registry
 *  lookup. Uses `crypto.randomUUID()` when available; the fallback
 *  produces the same `wk_<timestamp>_<rand>` shape the folder helper
 *  uses for workspace ids. */
function mintRunId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `p_${crypto.randomUUID()}`;
  }
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 10);
  return `p_${ts}_${rand}`;
}

/** Format a JS number total back into the comma-separated display
 *  string that `RunRecord.totalAmount` expects. Uses 2 fraction
 *  digits like the wizard's review screen. */
function formatTotal(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** Construct a `RunRecord` from the wizard's parsed state. The record
 *  is the operator-side mirror of the settle tx — recipient names /
 *  amounts / claim-from windows live here and never on-chain.
 *
 *  `txHash` is a placeholder until the real settle path lands; the
 *  detail page reads but doesn't link to it yet, so a deterministic
 *  zero hash is fine. `settleGasPaid` stays undefined for the same
 *  reason. The dashboard tolerates both gaps. */
function buildRunRecord(input: {
  templateId: TemplateId;
  label: string;
  token: string;
  tokenAddress: string | undefined;
  operatorAddress: string | null;
  chainId: number | null;
  rows: Row[];
  total: number;
  claimFrom: string | undefined;
  walletBook: WalletEntry[];
  /** Real settle tx hash when scatterDirectAuth was submitted; falls
   *  back to a deterministic zero hash for env-not-configured demos. */
  txHash?: string;
}): RunRecord {
  const now = Math.floor(Date.now() / 1000);
  const claimFromUnix = input.claimFrom
    ? Math.floor(new Date(input.claimFrom).getTime() / 1000)
    : null;
  const isFutureClaim = claimFromUnix !== null && claimFromUnix > now;

  const bookByAddress = new Map<string, WalletEntry>();
  for (const e of input.walletBook) bookByAddress.set(e.address.toLowerCase(), e);

  const recipients: RecipientRow[] = input.rows.map((r, i) => {
    const lower = r.address.toLowerCase();
    const book = bookByAddress.get(lower);
    return {
      rowIndex: i,
      name: r.name || book?.label || lower,
      address: lower,
      amount: r.amount,
      // Brand-new runs have no claim activity yet; "available" is
      // the right initial state for free-claim, "locked" while the
      // wizard's claim-from is in the future.
      status: isFutureClaim ? "locked" : "available",
      ...(isFutureClaim ? { claimFrom: claimFromUnix! } : {}),
      ...(book?.email ? { email: book.email } : {}),
      ...(book?.discordHandle ? { discordHandle: book.discordHandle } : {}),
    };
  });

  // RunCategory has an "other" bucket the wizard's TemplateId set
  // doesn't include; the cast is safe because the four template ids
  // are a subset of the category union.
  const category: RunCategory = input.templateId;

  return {
    id: mintRunId(),
    label: input.label,
    operatorAddress: (input.operatorAddress ?? "").toLowerCase(),
    category,
    createdAt: now,
    settledAt: now,
    chainId: input.chainId ?? 0,
    txHash: input.txHash ?? "0x" + "0".repeat(64),
    tokenSymbol: input.token,
    tokenAddress: input.tokenAddress ?? "",
    totalAmount: formatTotal(input.total),
    recipients,
    notifications: [],
  };
}
