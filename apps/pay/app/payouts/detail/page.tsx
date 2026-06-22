"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ethers } from "ethers";
import { useOutsideClick } from "@zkscatter/ui";
import { shortAddr, useMounted, useWallet } from "@zkscatter/sdk/react";
import { decodeClaimPackage } from "@zkscatter/sdk/notes";
import { formatTokenLabel } from "@zkscatter/sdk";
import { shortTxHash } from "@zkscatter/sdk/util";
import { submitClaim } from "../../_lib/claimSubmit";
import {
  addClaimInboxEntry,
  indexLatestNotifications,
  listClaimsBackups,
  saveRun,
  type ClaimedRecipientInput,
  type NotificationChannel,
  type NotificationLog,
  type RecipientRow,
  type RunRecord,
} from "@zkscatter/sdk/storage";
import { WorkspaceBar } from "../../_components/WorkspaceBar";
import { useFolderStorage } from "../../_lib/folderStorage";
import { useRunRecord } from "../../_lib/runRecord";
import { makeIsRootSettled, repairRunClaims } from "../../_lib/repairClaims";
import { ClaimReconciler } from "../../_lib/claimReconciler";
import { getNetworkConfig } from "../../_lib/network";
import { buildExplorerTxUrl, buildExplorerAddressUrl } from "../../_lib/explorerUrl";
import { partialRunStats } from "../../_lib/resumeRun";
import { downloadRunCsv } from "../../_lib/exportRun";
import { buildClaimUrl } from "../../_lib/claimUrl";
import { formatLocalStamp, formatLocalStampSec, formatUtcStamp } from "../../_lib/format";

const SAMPLE_RUN_ID = "p_2026_04_payroll";
const EMAIL: NotificationChannel = "email";

type BusyKind = "row" | "seed" | null;

/** Pre-Next 16 the route was `/payouts/[id]`; Pay now ships as a
 *  static export (Firebase Hosting), which forbids dynamic route
 *  params. The id moves to a `?id=` query string read at runtime
 *  via `useSearchParams`, which Next requires to be wrapped in a
 *  `<Suspense>` boundary so the static prerender doesn't bail out.
 *  Old `/payouts/<id>` deep-links should be redirected at the host
 *  layer (Firebase rewrite rule) until the migration completes. */
export default function PayoutDetail() {
  return (
    <Suspense
      fallback={
        <p className="text-sm text-[var(--color-text-muted)]">
          Loading payout…
        </p>
      }
    >
      <PayoutDetailInner />
    </Suspense>
  );
}

function PayoutDetailInner() {
  const searchParams = useSearchParams();
  const id = searchParams?.get("id") ?? undefined;
  const folder = useFolderStorage();
  const run = useRunRecord(id);
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const [busy, setBusy] = useState<BusyKind>(null);
  const closeMenu = useCallback(() => setOpenMenu(null), []);

  const breadcrumb = (
    <div
      data-print="hide"
      className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]"
    >
      <Link href="/dashboard" className="hover:text-[var(--color-text)]">Payouts</Link>
      <span>/</span>
      <span className="font-mono text-xs">{id ?? "—"}</span>
    </div>
  );

  const shell = (children: ReactNode) => (
    <div className="space-y-4">
      {breadcrumb}
      <div data-print="hide">
        <WorkspaceBar />
      </div>
      {children}
    </div>
  );

  if (folder.available === false) return shell(<UnsupportedBanner />);

  if (folder.available === true && !folder.ready) {
    // WorkspaceBar (inside the shell) renders the Pick-folder CTA in
    // both the unready and restoring states; nothing extra to show.
    return shell(null);
  }

  if (!run.loaded) {
    return shell(<p className="text-sm text-[var(--color-text-muted)]">Loading run record…</p>);
  }

  if (run.corrupt) {
    return shell(
      <CorruptBanner message={run.corrupt.message} filename={`zkscatter-run-${id}.json`} />,
    );
  }

  if (!run.record) {
    return shell(
      <>
        <h1 className="text-2xl font-semibold">Run not found</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          No <span className="font-mono">zkscatter-run-{id}.json</span> in your notes folder.
          Live run records arrive in Phase B once the wizard is wired to the contract — for now
          you can seed the sample <span className="font-mono">{SAMPLE_RUN_ID}</span> run to see
          the notification flow.
        </p>
        <div className="flex gap-2">
          {id === SAMPLE_RUN_ID && (
            <button
              disabled={busy !== null}
              onClick={async () => {
                setBusy("seed");
                try {
                  await saveRun(buildSampleRun());
                  await run.refresh();
                } finally {
                  setBusy(null);
                }
              }}
              className="rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
            >
              {busy === "seed" ? "Seeding…" : "Seed sample run"}
            </button>
          )}
          <Link
            href="/dashboard"
            className="rounded-md border border-[var(--color-border-strong)] px-3 py-2 text-sm"
          >
            ← Back to dashboard
          </Link>
        </div>
      </>,
    );
  }

  const record = run.record;
  const settlementAddress = getNetworkConfig().contracts.privateSettlement;
  return shell(
    <>
      <ClaimReconciler
        record={record}
        settlementAddress={settlementAddress}
        markClaimed={run.markClaimed}
      />
      <PayoutBody
        record={record}
        busy={busy}
        setBusy={setBusy}
        openMenu={openMenu}
        setOpenMenu={setOpenMenu}
        closeMenu={closeMenu}
        markSent={run.markSent}
        markClaimed={run.markClaimed}
        refresh={run.refresh}
        error={run.error}
      />
    </>,
  );
}

function PayoutBody({
  record,
  busy,
  setBusy,
  openMenu,
  setOpenMenu,
  closeMenu,
  markSent,
  markClaimed,
  refresh,
  error,
}: {
  record: RunRecord;
  busy: BusyKind;
  setBusy: Dispatch<SetStateAction<BusyKind>>;
  openMenu: number | null;
  setOpenMenu: Dispatch<SetStateAction<number | null>>;
  closeMenu: () => void;
  markSent: (input: { rowIndex: number; channel: NotificationChannel; toAddress: string }) => Promise<boolean>;
  markClaimed: (entries: ClaimedRecipientInput[]) => Promise<number>;
  refresh: () => Promise<void>;
  error: string | null;
}) {
  const logsByRow = useMemo(() => indexLatestNotifications(record), [record]);

  // Hooks needed for the inline gasless claim path. Read-provider is
  // always available once the WalletProvider mounts.
  const { readProvider } = useWallet();
  const [claimingRow, setClaimingRow] = useState<number | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  /** Current step of the in-flight claim (validating → proving →
   *  submitting). Drives the progress banner so the operator knows
   *  the modal isn't frozen mid-prove (proof generation can run
   *  10–20s depending on tier). */
  const [claimPhase, setClaimPhase] = useState<
    "validating" | "proving" | "submitting" | null
  >(null);
  /** Tx hash of the most recently completed claim. Surfaced as a
   *  brief success banner so the operator gets explicit confirmation
   *  even before the claim reconciler flips the row's badge. Cleared
   *  by the operator's Dismiss click or by the next claim. */
  const [lastClaimTx, setLastClaimTx] = useState<{ rowIndex: number; txHash: string } | null>(null);

  /** In-flight + result state for the "Save all to Claims inbox" bulk
   *  action. `inboxResult` is a short summary shown next to the button
   *  (e.g. "2 saved, 1 already there") so the operator gets explicit
   *  feedback — and re-running shows everything as already-there rather
   *  than silently no-op'ing. */
  const [savingInbox, setSavingInbox] = useState(false);
  const [inboxResult, setInboxResult] = useState<string | null>(null);

  /** Save THIS recipient's claim link to the operator's local Claims
   *  inbox. Useful when the operator is also a recipient (common in
   *  demo flows) or wants to pre-stage the claim for later. Decodes
   *  the row's encoded ClaimPackage and persists it under the active
   *  folder; the inbox UI surfaces it next time the operator opens
   *  /claims. Best-effort: silently swallow corrupt-payload errors
   *  (the row's claim badge already surfaces those). */
  /** Decode `row`'s claim package and upsert it into the local inbox.
   *  Returns whether the entry was freshly added (`true`) vs. already
   *  present (`false`). Shared by the single-row and bulk handlers so
   *  the decode/persist path lives in one place. Throws on a corrupt
   *  payload — callers decide how loud to be about it. */
  const saveRowToInbox = useCallback(async (row: RecipientRow): Promise<boolean> => {
    const pkg = decodeClaimPackage(row.claimPackage!);
    const { isNew } = await addClaimInboxEntry({
      rawInput:
        typeof window !== "undefined"
          ? buildClaimUrl(window.location.origin, "saved", row)
          : "",
      pkg,
    });
    return isNew;
  }, []);

  const onSaveToInbox = useCallback(
    async (row: RecipientRow) => {
      if (!row.claimPackage) return;
      setOpenMenu(null);
      try {
        await saveRowToInbox(row);
      } catch (err) {
        console.warn("[Pay] save-to-inbox failed", err);
      }
    },
    [saveRowToInbox],
  );

  /** Save EVERY recipient's claim link to the local Claims inbox in one
   *  click, instead of opening the row menu per recipient. Idempotent:
   *  `addClaimInboxEntry` dedupes on (claimsRoot, leafIndex), so rows
   *  already in the inbox are reported as "already there" and never
   *  duplicated — running this repeatedly is safe. */
  const onSaveAllToInbox = useCallback(async () => {
    setOpenMenu(null);
    const eligible = record.recipients.filter((r) => r.claimPackage);
    if (eligible.length === 0) return;
    setSavingInbox(true);
    setInboxResult(null);
    let added = 0;
    let existing = 0;
    let failed = 0;
    for (const row of eligible) {
      try {
        if (await saveRowToInbox(row)) added++;
        else existing++;
      } catch (err) {
        failed++;
        console.warn("[Pay] bulk save-to-inbox failed", err);
      }
    }
    setSavingInbox(false);
    setInboxResult(
      [
        `${added} saved`,
        existing ? `${existing} already there` : "",
        failed ? `${failed} skipped` : "",
      ]
        .filter(Boolean)
        .join(", "),
    );
  }, [record.recipients, saveRowToInbox]);

  const onMarkSentRow = useCallback(
    async (row: RecipientRow) => {
      if (!row.email) return;
      setBusy("row");
      try {
        await markSent({ rowIndex: row.rowIndex, channel: EMAIL, toAddress: row.email });
      } finally {
        setBusy(null);
      }
      setOpenMenu(null);
    },
    [markSent, setBusy, setOpenMenu],
  );

  /** Inline gasless claim. Decodes the row's encoded `ClaimPackage`
   *  and pushes the claim through the run's bundled relayer URL.
   *  The claim reconciler effect picks the claimed-flag up via
   *  `markClaimed` once the tx mines, so the row badge flips
   *  Available → Claimed without an extra refresh. */
  const onClaimRow = useCallback(
    async (row: RecipientRow) => {
      setClaimError(null);
      if (!row.claimPackage) {
        setClaimError("This row predates the claim flow — no encoded package to claim.");
        return;
      }
      if (!readProvider) {
        setClaimError("Read provider not ready — connect to a network first.");
        return;
      }
      setClaimingRow(row.rowIndex);
      setClaimPhase("validating");
      setLastClaimTx(null);
      setOpenMenu(null);
      try {
        const pkg = decodeClaimPackage(row.claimPackage);
        // Defense-in-depth: refuse if the encoded package's recipient
        // doesn't match the row's recorded address. A drift here would
        // mean a corrupted run record could redirect an operator's
        // gasless claim to an address they didn't intend.
        if (pkg.recipient.toLowerCase() !== row.address.toLowerCase()) {
          throw new Error(
            `Encoded claim package addresses ${pkg.recipient}, but the row records ${row.address}. Refusing to submit — the run record may be corrupted.`,
          );
        }
        if (!pkg.relayerUrl) {
          throw new Error(
            "This run wasn't bundled with a relayer URL, so the operator can't claim on behalf — the recipient must self-pay from their own wallet.",
          );
        }
        const { txHash } = await submitClaim({
          pkg,
          readProvider,
          onPhase: setClaimPhase,
        });
        setLastClaimTx({ rowIndex: row.rowIndex, txHash });
        // submitClaim returns when the relayer accepts the tx, but the
        // claim reconciler only flips the row to Claimed once the
        // PrivateClaim event lands and is matched on-chain. Wait for
        // the receipt (so the event has been emitted) then poll the
        // run record until the badge updates — without this the
        // operator sees a stuck "Available" badge for several seconds
        // after a successful submit.
        // Wait for the tx to mine, then stamp the row claimed
        // locally so the badge flips immediately. ClaimReconciler
        // will idempotently catch up if its event subscription
        // delivers the same `PrivateClaim` later.
        //
        // Bound the wait — without a timeout, a stalled RPC would
        // wedge the claiming-banner indefinitely. 30 s covers a
        // mainnet block + receipt-poll lag without blocking the UI
        // forever; if the tx hasn't mined by then we still flip
        // local state (relayer accepted; chain state will reflect
        // it shortly) and let the reconciler reconcile authoritatively.
        // Try to extract the mined block's timestamp so the locally-
        // stamped `claimedAt` matches what the on-chain reconciler
        // would record. Falls back to wall-clock Date.now()/1000
        // when the receipt isn't observable (RPC drop, timeout) —
        // close enough for the badge UX, and the reconciler is
        // idempotent so a subsequent more-accurate pass would skip
        // already-claimed rows.
        let claimedAt = Math.floor(Date.now() / 1000);
        try {
          const receipt = (await Promise.race([
            readProvider.waitForTransaction(txHash),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("waitForTransaction timeout")), 30_000),
            ),
          ])) as ethers.TransactionReceipt | null;
          if (receipt) {
            const block = await readProvider.getBlock(receipt.blockNumber);
            if (block?.timestamp) claimedAt = Number(block.timestamp);
          }
        } catch {
          // RPC drop / timeout / cancellation — keep the wall-clock
          // fallback for `claimedAt`.
        }
        try {
          await markClaimed([{ rowIndex: row.rowIndex, claimedAt }]);
        } catch (err) {
          console.warn("[detail] markClaimed after gasless claim failed:", err);
          await refresh();
        }
      } catch (e) {
        setClaimError(e instanceof Error ? e.message : "Claim failed");
      } finally {
        setClaimingRow(null);
        setClaimPhase(null);
      }
    },
    [readProvider, refresh, markClaimed, setOpenMenu],
  );

  return (
    <div className="space-y-8">
      <PayoutHeader record={record} />
      <SummaryStats record={record} logsByRow={logsByRow} />
      <MemoSection record={record} refresh={refresh} />
      <NotificationsBar record={record} logsByRow={logsByRow} />
      <ClaimProgressBanner
        record={record}
        claimingRow={claimingRow}
        claimPhase={claimPhase}
        lastClaimTx={lastClaimTx}
        onDismissSuccess={() => setLastClaimTx(null)}
      />
      <RepairClaimsBanner record={record} refresh={refresh} />
      <RecipientTable
        record={record}
        logsByRow={logsByRow}
        openMenuRow={openMenu}
        setOpenMenu={setOpenMenu}
        closeMenu={closeMenu}
        busy={busy}
        onMarkSent={onMarkSentRow}
        onClaim={onClaimRow}
        onSaveToInbox={onSaveToInbox}
        onSaveAllToInbox={onSaveAllToInbox}
        savingInbox={savingInbox}
        inboxResult={inboxResult}
        claimingRow={claimingRow}
      />
      {claimError && (
        <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
          {claimError}
          <button
            onClick={() => setClaimError(null)}
            className="ml-3 rounded border border-[var(--color-warning)] px-2 py-0.5 text-[10px] hover:bg-[var(--color-warning)] hover:text-white"
          >
            Dismiss
          </button>
        </div>
      )}
      {error && (
        <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
          {error}
        </div>
      )}
      <p className="text-xs text-[var(--color-text-muted)]">
        Pay opens each claim email in your OS mail client (Gmail, Apple Mail, Outlook…). After you
        press send there, confirm to mark the row as Sent — Pay only records the local timestamp.
        Delivery / opened / clicked webhook fields are reserved for a future ESP integration.
      </p>
      <PrintOnlyClaimLinks record={record} />
    </div>
  );
}

/** Hidden on screen, surfaced in print: a per-recipient claim-link
 *  appendix so an operator who saves the detail page as PDF still
 *  walks away with every link they'd need to deliver offline. Keeping
 *  it off-screen avoids the shoulder-surfing risk of having dozens of
 *  private links permanently visible on the operator's monitor. */
function PrintOnlyClaimLinks({ record }: { record: RunRecord }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  // Force landscape orientation for the detail page's print output:
  // claim URLs and ephemeral pubkeys are long, and portrait wraps
  // them awkwardly. Other routes (per-recipient payslip) keep
  // portrait by not mounting this effect. Cleanup on unmount so a
  // subsequent navigation-back to a portrait-style page restores the
  // browser default.
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = "@media print { @page { size: A4 landscape; } }";
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);
  return (
    <section data-print="only" className="break-before-page pt-6">
      <h2 className="border-b border-black pb-1 text-sm font-semibold uppercase tracking-wide">
        Claim links per recipient
      </h2>
      <p className="mt-1 text-[10px] text-gray-600">
        Each link below is private to that recipient — handle this PDF as confidential.
      </p>
      <table className="mt-3 w-full text-[10px]">
        <thead>
          <tr className="border-b border-gray-400 text-left">
            <th className="py-1 pr-3">#</th>
            <th className="py-1 pr-3">Recipient</th>
            <th className="py-1 pr-3">Email</th>
            <th className="py-1">Claim link</th>
          </tr>
        </thead>
        <tbody>
          {record.recipients.map((r) => {
            const url = buildClaimUrl(origin, record.id, r);
            return (
              <tr key={r.rowIndex} className="border-b border-gray-200 align-top">
                <td className="py-1 pr-3 font-mono">{r.rowIndex + 1}</td>
                <td className="py-1 pr-3">{r.name || "—"}</td>
                <td className="py-1 pr-3 break-all">{r.email ?? "—"}</td>
                <td className="break-all py-1 font-mono">
                  {url ? (
                    <a href={url} className="text-blue-700 underline">
                      {url}
                    </a>
                  ) : (
                    "— (claim package not yet issued)"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function PayoutHeader({ record }: { record: RunRecord }) {
  // ISO `YYYY-MM-DD HH:mm UTC` to avoid SSR / client locale mismatch
  // (operators app uses the same pattern in `app/lib/format.ts`).
  const submitted = formatUtcStamp(record.createdAt);
  const { partial, unsettled } = partialRunStats(record);
  return (
    <header className="flex items-end justify-between">
      <div>
        <h1 className="text-2xl font-semibold">{record.label}</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Submitted {submitted} · One on-chain tx · Per-recipient claim links · No expiry
        </p>
      </div>
      <div data-print="hide" className="flex gap-2">
        {partial && (
          <Link
            href={`/payouts/new?resume=${record.id}`}
            className="rounded-md border border-[var(--color-primary)] bg-[var(--color-primary-soft)] px-3 py-2 text-sm font-medium text-[var(--color-primary)]"
          >
            Resume settlement ({unsettled.length} pending) →
          </Link>
        )}
        <ExportMenu record={record} />
      </div>
    </header>
  );
}

/** Recovery affordance for a run whose persisted claim links point at a
 *  claimsRoot that never settled on-chain (the relayer-delay stranding
 *  bug). Rebuilds the links from the local claims backup for whichever
 *  root actually settled and overwrites the run record. No-op when the
 *  record already matches the chain. */
function RepairClaimsBanner({
  record,
  refresh,
}: {
  record: RunRecord;
  refresh: () => Promise<void>;
}) {
  const { readProvider } = useWallet();
  const folder = useFolderStorage();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "info" | "success" | "warn"; text: string } | null>(
    null,
  );

  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      // Guard the folder inside the callback, not just via UI gating: with
      // no workspace folder, listClaimsBackups() returns [] and the user
      // would see a misleading "no backup found" instead of the real cause.
      if (!folder.ready) {
        setMsg({ tone: "warn", text: "Open a workspace folder first — the claims backup lives there." });
        return;
      }
      if (!readProvider) {
        setMsg({ tone: "warn", text: "Connect your wallet to check the on-chain settlement." });
        return;
      }
      const settlementAddress = getNetworkConfig().contracts.privateSettlement;
      const backups = await listClaimsBackups();
      const res = await repairRunClaims({
        record,
        backups,
        isRootSettled: makeIsRootSettled(readProvider, settlementAddress),
      });
      switch (res.status) {
        case "ok":
          setMsg({ tone: "success", text: "Claim links already match the on-chain settlement — nothing to repair." });
          break;
        case "no-backup":
          setMsg({ tone: "warn", text: "No claims backup for this run was found in the current workspace folder." });
          break;
        case "no-settled-root":
          setMsg({ tone: "warn", text: "Found a backup for this run, but its settlement isn't on-chain. If the settle is still pending, try again once it confirms." });
          break;
        case "repaired":
          await saveRun(res.record);
          await refresh();
          setMsg({
            tone: "success",
            text: `Recovered ${res.recoveredCount} claim link(s) for the settled root ${res.settledRoot.slice(0, 10)}…. Recipients can claim now.`,
          });
          break;
      }
    } catch (e) {
      setMsg({ tone: "warn", text: e instanceof Error ? e.message : "Repair failed." });
    } finally {
      setBusy(false);
    }
  };

  const toneClass =
    msg?.tone === "success"
      ? "text-[var(--color-success)]"
      : msg?.tone === "warn"
        ? "text-[var(--color-warning)]"
        : "text-[var(--color-text-muted)]";

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[var(--color-text-muted)]">
          Recipients seeing “claims group missing”? Rebuild this run’s claim links from the
          local backup for whichever root actually settled on-chain.
        </span>
        <button
          onClick={run}
          disabled={busy}
          className="shrink-0 rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 hover:bg-[var(--color-primary-soft)] disabled:opacity-50"
        >
          {busy ? "Checking…" : "Repair claim links"}
        </button>
      </div>
      {msg && <div className={`mt-2 ${toneClass}`}>{msg.text}</div>}
      {msg?.tone === "warn" && (
        <div className="mt-2">
          <Link href="/payouts/recover" className="text-[var(--color-primary)] hover:underline">
            Can&apos;t repair here? Deep recover from your wallet →
          </Link>
        </div>
      )}
    </div>
  );
}

function ExportMenu({ record }: { record: RunRecord }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick({ enabled: open, ref, onClose: () => setOpen(false) });
  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-md border border-[var(--color-border-strong)] px-3 py-2 text-sm hover:bg-[var(--color-primary-soft)]"
      >
        Export ▾
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-52 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 text-left text-sm shadow-lg">
          <button
            onClick={() => {
              downloadRunCsv(record);
              setOpen(false);
            }}
            className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-primary-soft)]"
          >
            Download CSV
          </button>
          <button
            onClick={() => {
              setOpen(false);
              window.print();
            }}
            className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-primary-soft)]"
            title="Use the browser's Save as PDF option in the print dialog."
          >
            Print / Save as PDF
          </button>
          <a
            href={`/payouts/payslip?id=${record.id}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-primary-soft)]"
            title="Open every recipient's payslip in one bundled PDF (page-break between each)."
          >
            Print all payslips (PDF)
          </a>
        </div>
      )}
    </div>
  );
}

/** Plain-text memo edited from the detail page. Stored on
 *  `RunRecord.notes` and persisted via the same `saveRun` write path
 *  used by the wizard. The collapsed view shows the saved text (or
 *  an "Add a note" affordance when empty); clicking Edit swaps in a
 *  textarea so operators can update without leaving the page. */
function MemoSection({
  record,
  refresh,
}: {
  record: RunRecord;
  refresh: () => Promise<void>;
}) {
  // `saved` collapses absent / empty for the display side; `savedRaw`
  // preserves the distinction so onSave can clean up a present-but-
  // empty `notes: ""` field that escaped a prior save.
  const savedRaw = record.notes;
  const saved = savedRaw ?? "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Re-sync the draft if the record changes underfoot (e.g. another
  // tab updated the notes, or a refresh fired). Only resyncs when the
  // editor is closed so we don't clobber an in-progress edit.
  useEffect(() => {
    if (!editing) setDraft(saved);
  }, [saved, editing]);

  const onSave = async () => {
    const next = draft.trim() === "" ? undefined : draft;
    // Skip the write only when the on-disk shape would be identical:
    // both undefined (no `notes` key on either side) or matching
    // strings. A present-but-empty `notes: ""` still needs cleaning.
    if (next === savedRaw) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const updated: RunRecord = next === undefined
        ? (() => {
            // Drop the field entirely on clear so the on-disk JSON
            // doesn't carry an empty `notes: ""`.
            const { notes: _omit, ...rest } = record;
            void _omit;
            return rest;
          })()
        : { ...record, notes: next };
      await saveRun(updated);
      await refresh();
      setEditing(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save note");
    } finally {
      setSaving(false);
    }
  };

  const onCancel = () => {
    setDraft(saved);
    setSaveError(null);
    setEditing(false);
  };

  return (
    <section
      data-print={saved ? undefined : "hide"}
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--color-text-muted)]">📝 Note</h2>
        {!editing && (
          <button
            data-print="hide"
            onClick={() => setEditing(true)}
            className="rounded border border-[var(--color-border-strong)] px-2 py-1 text-xs hover:bg-[var(--color-primary-soft)]"
          >
            {saved ? "Edit" : "Add a note"}
          </button>
        )}
      </div>
      {editing ? (
        <div className="mt-3 space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            aria-label="Run note"
            placeholder="Approved by CFO · ref INV-2026-04-* · etc."
            className="w-full rounded-md border border-[var(--color-border-strong)] bg-white p-3 text-sm"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={onCancel}
              disabled={saving}
              className="rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-xs disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={onSave}
              disabled={saving}
              className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save note"}
            </button>
          </div>
          {saveError && (
            <p className="text-xs text-[var(--color-warning)]">{saveError}</p>
          )}
        </div>
      ) : saved ? (
        <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--color-text)]">
          {saved}
        </p>
      ) : (
        <p data-print="hide" className="mt-2 text-xs text-[var(--color-text-muted)]">
          Add an internal note for this run — e.g. an approval reference or a finance memo.
          Notes stay in your folder; recipients never see them.
        </p>
      )}
    </section>
  );
}

function SummaryStats({
  record,
  logsByRow,
}: {
  record: RunRecord;
  logsByRow: Map<number, NotificationLog>;
}) {
  const total = record.recipients.length;
  let claimed = 0;
  let available = 0;
  let locked = 0;
  let notified = 0;
  const nowSec = Math.floor(Date.now() / 1000);
  for (const r of record.recipients) {
    const eff = effectiveStatus(r, nowSec);
    if (eff === "claimed") claimed++;
    else if (eff === "available") available++;
    else locked++;
    if (logsByRow.get(r.rowIndex)?.sentAt) notified++;
  }
  return (
    <section className="grid grid-cols-6 gap-4">
      <Stat label="Total" value={`${record.totalAmount} ${formatTokenLabel(record.tokenSymbol)}`} />
      <Stat
        label="Relayer fee"
        value={record.relayerFee ? `${record.relayerFee} ${formatTokenLabel(record.tokenSymbol)}` : "—"}
        sub="paid"
      />
      <Stat label="Claimed" value={`${claimed} / ${total}`} />
      <Stat label="Available now" value={`${available}`} sub="not yet claimed" />
      <Stat label="Locked" value={`${locked}`} sub="claim-from in future" />
      <Stat label="Notified" value={`${notified} / ${total}`} />
    </section>
  );
}

function NotificationsBar({
  record,
  logsByRow,
}: {
  record: RunRecord;
  logsByRow: Map<number, NotificationLog>;
}) {
  const total = record.recipients.length;
  let sentCount = 0;
  let unclaimed = 0;
  for (const r of record.recipients) {
    if (logsByRow.get(r.rowIndex)?.sentAt) sentCount++;
    if (r.status !== "claimed" && r.email) unclaimed++;
  }
  const isFirstSend = sentCount === 0;

  return (
    <section
      data-print="hide"
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 text-sm"
    >
      <div className="flex items-center gap-2 font-semibold">
        📧 Claim emails
        <span
          title="Bulk send isn't wired — automated SMTP is on the roadmap (SPEC.md §Notifications). Use the row Actions menu to open each recipient's claim email in your mail client."
          className="rounded-full border border-[var(--color-border-strong)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]"
        >
          Per-row only
        </span>
      </div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">
        {isFirstSend
          ? `Use the row Actions menu to open each recipient's claim email in your mail client. ${total} total — rows without an email on file are skipped.`
          : `${sentCount}/${total} sent. ${unclaimed} unclaimed have an email on file.`}
      </div>
    </section>
  );
}

function RecipientTable({
  record,
  logsByRow,
  openMenuRow,
  setOpenMenu,
  closeMenu,
  busy,
  onMarkSent,
  onClaim,
  onSaveToInbox,
  onSaveAllToInbox,
  savingInbox,
  inboxResult,
  claimingRow,
}: {
  record: RunRecord;
  logsByRow: Map<number, NotificationLog>;
  openMenuRow: number | null;
  setOpenMenu: Dispatch<SetStateAction<number | null>>;
  closeMenu: () => void;
  busy: BusyKind;
  onMarkSent: (row: RecipientRow) => Promise<void>;
  /** Run the gasless claim for `row` against this run's bundled
   *  relayer. Resolves once the relayer's submit returns or throws —
   *  the parent's claim reconciler effect handles the badge flip. */
  onClaim: (row: RecipientRow) => Promise<void>;
  /** Stash this row's claim link in the operator's local Claims
   *  inbox so they can re-open it from /inbox later. */
  onSaveToInbox: (row: RecipientRow) => Promise<void>;
  /** Save every eligible recipient's claim link to the inbox at once.
   *  Idempotent (dedupes on claimsRoot+leafIndex). */
  onSaveAllToInbox: () => Promise<void>;
  /** True while the bulk save is running — disables the button. */
  savingInbox: boolean;
  /** Short result summary shown next to the button, or null. */
  inboxResult: string | null;
  /** `rowIndex` of the row whose claim is currently in flight, or
   *  `null` when nothing is claiming. Drives the per-row "Claiming…"
   *  label and disables the menu while the proof is generating. */
  claimingRow: number | null;
}) {
  const savableCount = record.recipients.filter((r) => r.claimPackage).length;
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--color-text-muted)]">Recipients</h2>
        {savableCount > 0 && (
          <div data-print="hide" className="flex items-center gap-2">
            {inboxResult && (
              <span className="text-xs text-[var(--color-text-muted)]">{inboxResult}</span>
            )}
            <button
              onClick={onSaveAllToInbox}
              disabled={savingInbox}
              title="Save every recipient's claim link to your local Claims inbox. Safe to re-run — recipients already saved are skipped (no duplicates)."
              className="rounded-lg border border-[var(--color-border-strong)] px-3 py-1.5 text-sm hover:bg-[var(--color-primary-soft)] disabled:opacity-40"
            >
              {savingInbox ? "Saving…" : `Save all to Claims inbox (${savableCount})`}
            </button>
          </div>
        )}
      </div>
      <div className="overflow-visible rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
            <tr>
              <th className="px-5 py-3 text-left">Name</th>
              <th className="px-5 py-3 text-left">Recipient address</th>
              <th className="px-5 py-3 text-right">Amount</th>
              <th className="px-5 py-3 text-left">Claim status</th>
              <th className="px-5 py-3 text-left">Notification</th>
              <th data-print="hide" className="px-5 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {record.recipients.map((r) => {
              const log = logsByRow.get(r.rowIndex);
              return (
                <tr key={r.rowIndex} className="border-t border-[var(--color-border)]">
                  <td className="px-5 py-3">{r.name}</td>
                  <td className="px-5 py-3 font-mono text-xs">
                    <AddressCell address={r.address} />
                  </td>
                  <td className="px-5 py-3 text-right font-mono">
                    {r.amount} {formatTokenLabel(record.tokenSymbol)}
                  </td>
                  <td className="px-5 py-3">
                    <ClaimStatusBadge row={r} />
                  </td>
                  <td className="px-5 py-3">
                    <NotificationStatus log={log} hasEmail={!!r.email} />
                  </td>
                  <td data-print="hide" className="px-5 py-3 text-right">
                    <RowMenu
                      open={openMenuRow === r.rowIndex}
                      onOpen={() =>
                        setOpenMenu((cur) => (cur === r.rowIndex ? null : r.rowIndex))
                      }
                      onClose={closeMenu}
                      onCopy={() => copyClaimLink(record, r)}
                      onSaveToInbox={() => onSaveToInbox(r)}
                      onSend={() => openClaimMailDraftAndConfirm(record, r, onMarkSent)}
                      hasClaimPackage={!!r.claimPackage}
                      hasEmail={!!r.email}
                      alreadySent={!!log?.sentAt}
                      busy={busy !== null}
                      payslipHref={`/payouts/payslip?id=${record.id}&row=${r.rowIndex}`}
                      onClaim={() => onClaim(r)}
                      isClaiming={claimingRow === r.rowIndex}
                      anyClaiming={claimingRow !== null}
                      alreadyClaimed={r.status === "claimed"}
                      isLocked={
                        effectiveStatus(r, Math.floor(Date.now() / 1000)) === "locked"
                      }
                      claimFrom={r.claimFrom}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-[var(--color-text-muted)]">
        Each recipient sees only their own amount when they claim. The on-chain transaction
        reveals only the recipient addresses, not the mapping to names or per-recipient amounts.
        Claim links never expire.
      </p>
    </section>
  );
}

/** Status persisted at run time can lag the wall clock — a row stamped
 *  `locked` becomes claimable the moment its `claimFrom` passes. The
 *  detail-page badge and stat counters re-derive against `now` so users
 *  don't see a stale "Locked" badge after the unlock time. */
function effectiveStatus(
  row: RecipientRow,
  nowSec: number,
): "claimed" | "available" | "locked" {
  if (row.status === "claimed") return "claimed";
  if (row.status === "available") return "available";
  if (row.claimFrom && row.claimFrom <= nowSec) return "available";
  return "locked";
}

function ClaimStatusBadge({ row }: { row: RecipientRow }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const status = effectiveStatus(row, nowSec);
  if (status === "claimed") {
    return (
      <span className="rounded-full bg-[var(--color-success-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-success)]">
        Claimed
      </span>
    );
  }
  if (status === "available") {
    return (
      <span className="rounded-full bg-[var(--color-primary-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-primary)]">
        Available
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-warning-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-warning)]">
      <span>Locked</span>
      {row.claimFrom && (
        <span className="font-normal opacity-80">
          · opens {formatLocalStamp(row.claimFrom)}
        </span>
      )}
    </span>
  );
}

// Stages later in the array win when populated. Bounce is a separate
// error state and takes precedence over any in-flight delivery stage.
const STATUS_STAGES: Array<{ key: keyof NotificationLog; label: ReactNode }> = [
  { key: "sentAt",      label: <span className="text-xs text-[var(--color-primary)]">✉ Sent</span> },
  { key: "deliveredAt", label: <span className="text-xs">📬 Delivered</span> },
  { key: "openedAt",    label: <span className="text-xs">👁 Opened</span> },
  { key: "clickedAt",   label: <span className="text-xs">🖱 Clicked</span> },
  { key: "claimedAt",   label: <span className="text-xs text-[var(--color-success)]">✓ Claimed</span> },
];

function NotificationStatus({
  log,
  hasEmail,
}: {
  log: NotificationLog | undefined;
  hasEmail: boolean;
}) {
  // `formatRelative` reads `Date.now()`, so it would render different
  // strings on SSR vs first client paint. Gate behind `mounted` and
  // fall back to the absolute UTC stamp until hydration completes.
  const mounted = useMounted();
  if (!hasEmail) {
    return <span className="text-xs text-[var(--color-text-subtle)]">No email on file</span>;
  }
  if (!log?.sentAt) {
    return <span className="text-xs text-[var(--color-text-muted)]">⏳ Not sent</span>;
  }
  if (log.bounceKind) {
    return <span className="text-xs text-[var(--color-warning)]">⚠ Bounced</span>;
  }
  let stage = STATUS_STAGES[0]!;
  for (const s of STATUS_STAGES) {
    if (log[s.key]) stage = s;
  }
  if (stage.key === "sentAt") {
    return (
      <span className="text-xs text-[var(--color-primary)]">
        ✉ Sent {mounted ? formatRelative(log.sentAt) : formatUtcStamp(log.sentAt)}
      </span>
    );
  }
  return <>{stage.label}</>;
}

/** Progress banner for the inline gasless claim. Replaces the silent
 *  "menu auto-closes and nothing happens for 15s" experience with a
 *  step-by-step indicator (validating → proving → submitting) plus a
 *  green success row that names the tx hash and links to the explorer
 *  when one is configured. Shown above the recipients table so the
 *  operator's eye lands on it without scrolling. */
function ClaimProgressBanner({
  record,
  claimingRow,
  claimPhase,
  lastClaimTx,
  onDismissSuccess,
}: {
  record: RunRecord;
  claimingRow: number | null;
  claimPhase: "validating" | "proving" | "submitting" | null;
  lastClaimTx: { rowIndex: number; txHash: string } | null;
  onDismissSuccess: () => void;
}) {
  const explorerBase = getNetworkConfig().explorerBase;
  if (claimingRow !== null && claimPhase) {
    const row = record.recipients.find((r) => r.rowIndex === claimingRow);
    const label = row?.name ?? `row ${claimingRow + 1}`;
    const amountText = row
      ? `${row.amount} ${formatTokenLabel(record.tokenSymbol)}`
      : "";
    const addr = row ? shortAddr(row.address) : "";
    const phases: Array<{
      key: "validating" | "proving" | "submitting";
      label: string;
      detail: string;
    }> = [
      {
        key: "validating",
        label: "Validating",
        detail: "Probing the on-chain claims group + warming the prover.",
      },
      {
        key: "proving",
        label: "Generating proof",
        detail: "ZK proof of ownership — runs locally, ~10–20s.",
      },
      {
        key: "submitting",
        label: "Submitting",
        detail: "Sending proof to the run's relayer for gasless inclusion.",
      },
    ];
    const cur = phases.findIndex((p) => p.key === claimPhase);
    return (
      <div className="space-y-2 rounded-xl border border-[var(--color-primary)] bg-[var(--color-primary-soft)] p-3 text-xs">
        <div className="flex items-center gap-2 text-[var(--color-primary)]">
          <span
            className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent"
            aria-hidden
          />
          <span className="font-medium">
            Claiming {amountText} for {label}{addr ? ` (${addr})` : ""}: {phases[cur]?.label ?? claimPhase}…
          </span>
        </div>
        <p className="text-[var(--color-text-muted)]">{phases[cur]?.detail}</p>
        <ol className="space-y-0.5 pl-1">
          {phases.map((p, i) => {
            const state = i < cur ? "done" : i === cur ? "current" : "pending";
            return (
              <li
                key={p.key}
                className={`flex items-center gap-2 ${
                  state === "done"
                    ? "text-[var(--color-text-muted)]"
                    : state === "current"
                      ? "text-[var(--color-primary)]"
                      : "text-[var(--color-text-subtle)]"
                }`}
              >
                <span aria-hidden className="w-3 text-center">
                  {state === "done" ? "✓" : state === "current" ? "●" : "○"}
                </span>
                <span>{p.label}</span>
              </li>
            );
          })}
        </ol>
      </div>
    );
  }
  if (lastClaimTx) {
    const row = record.recipients.find((r) => r.rowIndex === lastClaimTx.rowIndex);
    const label = row?.name ?? `row ${lastClaimTx.rowIndex + 1}`;
    const amountText = row ? `${row.amount} ${formatTokenLabel(record.tokenSymbol)}` : "";
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--color-success)] bg-[var(--color-success-soft)] p-3 text-xs text-[var(--color-success)]">
        <div className="flex flex-wrap items-center gap-1.5">
          <span>
            ✓ Claimed {amountText} for <strong>{label}</strong>. Tx
          </span>
          <TxHashChip txHash={lastClaimTx.txHash} explorerBase={explorerBase} />
        </div>
        <button
          onClick={onDismissSuccess}
          className="rounded border border-[var(--color-success)] px-2 py-0.5 text-[10px] hover:bg-[var(--color-success)] hover:text-white"
        >
          Dismiss
        </button>
      </div>
    );
  }
  return null;
}

/** Compact tx-hash widget used by status banners: the truncated hash
 *  + a copy button + an optional explorer link. Keeping the three
 *  controls visually adjacent (and the hash itself a plain span, not
 *  a link) avoids the "I just wanted to copy but it opened a tab"
 *  collision the previous single-element design had. */
function TxHashChip({
  txHash,
  explorerBase,
}: {
  txHash: string;
  explorerBase?: string;
}) {
  const [copied, setCopied] = useState(false);
  const short = shortTxHash(txHash);
  return (
    <span className="inline-flex items-center gap-1">
      <span title={txHash} className="font-mono">
        {short}
      </span>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard
            .writeText(txHash)
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
            .catch((err) => {
              console.warn("[detail] clipboard write failed", err);
            });
        }}
        title="Copy tx hash"
        aria-label="Copy tx hash"
        className="rounded border border-current px-1 py-0.5 text-[10px] hover:bg-[var(--color-surface)]"
      >
        {copied ? "✓" : "Copy"}
      </button>
      {(() => {
        const url = buildExplorerTxUrl(explorerBase, txHash);
        if (!url) return null;
        return (
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            title="Open in explorer"
            aria-label="Open in explorer"
            className="rounded border border-current px-1 py-0.5 text-[10px] hover:bg-[var(--color-surface)]"
          >
            ↗
          </a>
        );
      })()}
    </span>
  );
}

/** Inline cell: short address + copy button + optional explorer link.
 *  Operators routinely need to spot-check a recipient against their
 *  wallet/explorer; making the truncated text actionable saves the
 *  "select-then-Cmd-C" dance. Copy uses the clipboard API and a
 *  brief check-mark so the click registers visibly. */
function AddressCell({ address }: { address: string }) {
  const explorerBase = getNetworkConfig().explorerBase;
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span title={address}>{shortAddr(address)}</span>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard
            .writeText(address)
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
            .catch((err) => {
              console.warn("[detail] clipboard write failed", err);
            });
        }}
        title="Copy address"
        aria-label="Copy address"
        className="rounded border border-[var(--color-border-strong)] px-1 py-0.5 text-[10px] hover:bg-[var(--color-primary-soft)]"
      >
        {copied ? "✓" : "Copy"}
      </button>
      {(() => {
        const url = buildExplorerAddressUrl(explorerBase, address);
        if (!url) return null;
        return (
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            title="Open in explorer"
            aria-label="Open in explorer"
            className="rounded border border-[var(--color-border-strong)] px-1 py-0.5 text-[10px] hover:bg-[var(--color-primary-soft)]"
          >
            ↗
          </a>
        );
      })()}
    </span>
  );
}

interface RowMenuProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onCopy: () => void;
  /** Stash THIS recipient's claim link in the operator's local
   *  Claims inbox. Useful when the operator is also the recipient,
   *  or when they want to pre-stage the claim for later. */
  onSaveToInbox: () => void;
  onSend: () => void;
  hasClaimPackage: boolean;
  hasEmail: boolean;
  alreadySent: boolean;
  busy: boolean;
  payslipHref: string;
  /** Trigger the inline gasless claim. */
  onClaim: () => void;
  /** True for the row currently mid-claim. Disables the button +
   *  swaps the label to "Claiming…". */
  isClaiming: boolean;
  /** True when *any* row is mid-claim. Other rows lock to keep the
   *  proving worker single-tasked. */
  anyClaiming: boolean;
  /** Hides the Claim-now affordance once the claim has landed so
   *  operators don't double-submit a finalized row. */
  alreadyClaimed: boolean;
  /** Disable Claim-now while the row's `claimFrom` hasn't passed.
   *  The on-chain contract enforces this with `NotYetReleasable`,
   *  so a click would burn ~10 s of proving + a wallet signature
   *  only to revert. Surface the lock as the disabled state with a
   *  tooltip explaining when the row opens. */
  isLocked: boolean;
  /** Unix-seconds release time. Used in the disabled tooltip so the
   *  operator sees the unlock moment without leaving the menu. */
  claimFrom?: number;
}

function RowMenu({
  open,
  onOpen,
  onClose,
  onCopy,
  onSaveToInbox,
  onSend,
  hasClaimPackage,
  hasEmail,
  alreadySent,
  busy,
  payslipHref,
  onClaim,
  isClaiming,
  anyClaiming,
  alreadyClaimed,
  isLocked,
  claimFrom,
}: RowMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick({ enabled: open, ref, onClose });
  return (
    <div ref={ref} className="relative inline-block text-left">
      <button
        onClick={onOpen}
        className="rounded border border-[var(--color-border-strong)] px-2 py-1 text-xs hover:bg-[var(--color-primary-soft)]"
      >
        Actions ▾
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-56 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 text-left text-xs shadow-lg">
          <button
            onClick={onCopy}
            disabled={!hasClaimPackage}
            title={
              hasClaimPackage
                ? undefined
                : "This run was settled before the claim flow shipped — no encoded package."
            }
            className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-primary-soft)] disabled:opacity-40"
          >
            Copy claim link
          </button>
          <button
            onClick={onSaveToInbox}
            disabled={!hasClaimPackage}
            title={
              hasClaimPackage
                ? "Save this recipient's claim link to your local Claims inbox so you can open it from /inbox later."
                : "This row predates the claim flow — no encoded package."
            }
            className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-primary-soft)] disabled:opacity-40"
          >
            Save to Claims inbox
          </button>
          <button
            disabled={!hasEmail || busy}
            onClick={onSend}
            className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-primary-soft)] disabled:opacity-40"
            title={!hasEmail ? "No email on file for this recipient" : undefined}
          >
            {alreadySent ? "Resend via Gmail" : "Send via Gmail"}
          </button>
          {hasClaimPackage && !alreadyClaimed && (
            <button
              onClick={onClaim}
              disabled={anyClaiming || isLocked}
              title={
                isLocked
                  ? `Locked until ${
                      claimFrom ? formatLocalStampSec(claimFrom) : "release time"
                    } — the on-chain contract rejects claims before then.`
                  : "Generate the claim proof and submit through the run's relayer (gasless). Works for any recipient — the proof binds to the package's claim secret, not the recipient's privkey."
              }
              className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-primary-soft)] disabled:opacity-40"
            >
              {isLocked
                ? "Claim now (locked)"
                : isClaiming
                  ? "Claiming…"
                  : "Claim now (gasless)"}
            </button>
          )}
          <Link
            href={payslipHref}
            target="_blank"
            className="block w-full px-3 py-1.5 hover:bg-[var(--color-primary-soft)]"
          >
            Print payslip (PDF)
          </Link>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
      {sub && <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">{sub}</div>}
    </div>
  );
}

function UnsupportedBanner() {
  return (
    <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-4 text-sm text-[var(--color-warning)]">
      <strong className="block">Browser doesn&apos;t support folder storage.</strong>
      Pay&apos;s run records use the File System Access API. Chrome / Edge / Opera 86+ work; Firefox
      and Safari don&apos;t expose it yet. <Link href="/" className="underline">Back home</Link>.
    </div>
  );
}

function CorruptBanner({ message, filename }: { message: string; filename: string }) {
  return (
    <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-4 text-sm text-[var(--color-warning)]">
      <strong className="block">Run record file is corrupt</strong>
      <p className="mt-1">{message}</p>
      <p className="mt-2 text-xs">
        Open <span className="font-mono">{filename}</span> in a text editor to repair, or rename
        it and re-seed the run.
      </p>
    </div>
  );
}

function copyClaimLink(record: RunRecord, row: RecipientRow): void {
  // Caller gates the button on `row.claimPackage`; bail out as a
  // belt-and-braces guard if it slips through and the URL builder
  // returns an empty string.
  const url = buildClaimUrl(window.location.origin, record.id, row);
  if (!url) return;
  void navigator.clipboard.writeText(url);
}

/** Open Gmail's web-compose URL with the row's claim email pre-filled
 *  and ask the operator to confirm they actually pressed Send in
 *  Gmail before we stamp the row. The Gmail-direct URL works
 *  regardless of the OS's mailto-handler registration — operators
 *  who keep Gmail open in a browser tab (the common case here) used
 *  to lose the draft to Apple Mail or a stale handler when this used
 *  the mailto: scheme. Anchor-click in a new tab so the synchronous
 *  confirm() doesn't race the markSent IndexedDB write on this page. */
function openClaimMailDraftAndConfirm(
  record: RunRecord,
  row: RecipientRow,
  onMarkSent: (row: RecipientRow) => Promise<void>,
): void {
  if (!row.email) return;
  const url = buildClaimUrl(window.location.origin, record.id, row);
  const subject = `Your payment from ${record.label}`;
  // Recipients hit one of three states when the operator emails them:
  // already claimed (link still valid but spent), locked-until-future
  // (clicking now shows the locked banner; useful to warn upfront),
  // or available right now. Surface the state in the mail so the
  // recipient doesn't open the link only to be told to wait.
  const tokenLabel = formatTokenLabel(record.tokenSymbol);
  let statusLine: string;
  if (row.status === "claimed") {
    const when = row.claimedAt ? formatLocalStampSec(row.claimedAt) : "";
    statusLine =
      `This payment of ${row.amount} ${tokenLabel} has already been claimed${when ? ` on ${when}` : ""}.`;
  } else if (row.status === "locked" && row.claimFrom) {
    statusLine =
      `Your payment of ${row.amount} ${tokenLabel} will be claimable from ${formatLocalStampSec(row.claimFrom)}.`;
  } else {
    statusLine = `Your payment of ${row.amount} ${tokenLabel} is ready to claim now.`;
  }
  const body = [
    `Hi ${row.name || ""},`,
    ``,
    statusLine,
    ``,
    `Claim it here:`,
    url,
    ``,
    `The link is private to you and never expires.`,
  ].join("\r\n");
  const gmailUrl =
    `https://mail.google.com/mail/?view=cm&fs=1` +
    `&to=${encodeURIComponent(row.email)}` +
    `&su=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`;
  const anchor = document.createElement("a");
  anchor.href = gmailUrl;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.click();
  const ok = window.confirm(
    `Gmail compose opened for ${row.name || row.email}.\n\n` +
      `Click OK after you've sent the email in Gmail to mark this recipient as Sent.\n` +
      `Click Cancel if you didn't send it.`,
  );
  if (!ok) return;
  onMarkSent(row).catch((err) =>
    console.error("Failed to mark recipient as sent", err),
  );
}

function formatRelative(unixSec: number | undefined): string {
  if (!unixSec) return "";
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Stable `YYYY-MM-DD HH:mm UTC` — used everywhere the markup is
 *  pre-rendered on the server, where `toLocaleString` would disagree
 *  with the client and trip Next's hydration warning. */
function buildSampleRun(): RunRecord {
  const now = Math.floor(Date.now() / 1000);
  const settled = now - 3 * 86400;
  return {
    id: SAMPLE_RUN_ID,
    label: "April payroll",
    operatorAddress: "0x0000000000000000000000000000000000000001",
    category: "payroll",
    createdAt: settled,
    settledAt: settled,
    chainId: 1,
    txHash: "0x" + "0".repeat(64),
    tokenSymbol: "USDC",
    tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    totalAmount: "24,200",
    recipients: [
      { rowIndex: 0, name: "Alice", address: "0xab1200000000000000000000000000000000abcd", amount: "3,500", status: "claimed", claimedAt: settled + 7200, email: "alice@example.com" },
      { rowIndex: 1, name: "Bob",   address: "0xcd3400000000000000000000000000000000ef12", amount: "4,200", status: "claimed", claimedAt: settled + 7800, email: "bob@example.com" },
      { rowIndex: 2, name: "Carol", address: "0xef5600000000000000000000000000000000003456", amount: "3,800", status: "claimed", claimedAt: settled + 12060, email: "carol@example.com" },
      { rowIndex: 3, name: "Dan",   address: "0x789000000000000000000000000000000000007890", amount: "5,000", status: "available", email: "dan@example.com" },
      { rowIndex: 4, name: "Eve",   address: "0x123400000000000000000000000000000000005678", amount: "4,500", status: "available", email: "eve@example.com" },
      { rowIndex: 5, name: "Frank", address: "0x246800000000000000000000000000000000001357", amount: "3,200", status: "locked", claimFrom: settled + 30 * 86400, email: "frank@example.com" },
    ],
    notifications: [],
  };
}
