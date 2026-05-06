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
import { useOutsideClick } from "@zkscatter/ui";
import { shortAddr, useMounted } from "@zkscatter/sdk/react";
import {
  indexLatestNotifications,
  saveRun,
  type NotificationChannel,
  type NotificationLog,
  type RecipientRow,
  type RunRecord,
} from "@zkscatter/sdk/storage";
import { WorkspaceBar } from "../../_components/WorkspaceBar";
import { useFolderStorage } from "../../_lib/folderStorage";
import { useRunRecord } from "../../_lib/runRecord";
import { ClaimReconciler } from "../../_lib/claimReconciler";
import { getNetworkConfig } from "../../_lib/network";
import { partialRunStats } from "../../_lib/resumeRun";
import { downloadRunCsv } from "../../_lib/exportRun";
import { buildClaimUrl } from "../../_lib/claimUrl";
import { formatLocalStamp, formatUtcStamp } from "../../_lib/format";

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
  refresh: () => Promise<void>;
  error: string | null;
}) {
  const logsByRow = useMemo(() => indexLatestNotifications(record), [record]);

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

  return (
    <div className="space-y-8">
      <PayoutHeader record={record} />
      <SummaryStats record={record} logsByRow={logsByRow} />
      <MemoSection record={record} refresh={refresh} />
      <NotificationsBar record={record} logsByRow={logsByRow} />
      <RecipientTable
        record={record}
        logsByRow={logsByRow}
        openMenuRow={openMenu}
        setOpenMenu={setOpenMenu}
        closeMenu={closeMenu}
        busy={busy}
        onMarkSent={onMarkSentRow}
      />
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
    </div>
  );
}

function PayoutHeader({ record }: { record: RunRecord }) {
  // ISO `YYYY-MM-DD HH:mm UTC` to avoid SSR / client locale mismatch
  // (operators app uses the same pattern in `app/lib/format.ts`).
  const submitted = formatUtcStamp(record.createdAt);
  // Resume button replaces "Run again" for partial runs — cloning
  // would orphan the claim packages already issued on the original.
  const { partial, unsettled } = partialRunStats(record);
  return (
    <header className="flex items-end justify-between">
      <div>
        <h1 className="text-2xl font-semibold">{record.label}</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Submitted {submitted} · One on-chain tx · Stealth claim links · No expiry
        </p>
      </div>
      <div data-print="hide" className="flex gap-2">
        {partial ? (
          <Link
            href={`/payouts/new?resume=${record.id}`}
            className="rounded-md border border-[var(--color-primary)] bg-[var(--color-primary-soft)] px-3 py-2 text-sm font-medium text-[var(--color-primary)]"
          >
            Resume settlement ({unsettled.length} pending) →
          </Link>
        ) : (
          <Link
            href={`/payouts/new?clone=${record.id}`}
            className="rounded-md border border-[var(--color-border-strong)] px-3 py-2 text-sm"
          >
            Run again →
          </Link>
        )}
        <ExportMenu record={record} />
      </div>
    </header>
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
      <Stat label="Total" value={`${record.totalAmount} ${record.tokenSymbol}`} />
      <Stat
        label="Relayer fee"
        value={record.relayerFee ? `${record.relayerFee} ${record.tokenSymbol}` : "—"}
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
      <div className="font-semibold">📧 Claim emails</div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">
        {isFirstSend
          ? `Use the row Actions menu to open each recipient's claim email in your mail client. ${total} total.`
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
}: {
  record: RunRecord;
  logsByRow: Map<number, NotificationLog>;
  openMenuRow: number | null;
  setOpenMenu: Dispatch<SetStateAction<number | null>>;
  closeMenu: () => void;
  busy: BusyKind;
  onMarkSent: (row: RecipientRow) => Promise<void>;
}) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold text-[var(--color-text-muted)]">Recipients</h2>
      <div className="overflow-visible rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
            <tr>
              <th className="px-5 py-3 text-left">Name</th>
              <th className="px-5 py-3 text-left">Stealth address</th>
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
                  <td className="px-5 py-3 font-mono text-xs">{shortAddr(r.address)}</td>
                  <td className="px-5 py-3 text-right font-mono">
                    {r.amount} {record.tokenSymbol}
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
                      onSend={() => {
                        if (!r.email) return;
                        const url = buildClaimUrl(window.location.origin, record.id, r);
                        const subject = `Your payment from ${record.label}`;
                        const body = [
                          `Hi ${r.name || ""},`,
                          ``,
                          `Your payment of ${r.amount} ${record.tokenSymbol} is ready.`,
                          ``,
                          `Claim it here:`,
                          url,
                          ``,
                          `The link is private to you and never expires.`,
                        ].join("\n");
                        // mailto: hands the draft to the OS-registered mail
                        // client (Gmail desktop, Apple Mail, Outlook…). The
                        // user still has to press send there, so we ask
                        // before stamping the row as sent.
                        const mailto = `mailto:${encodeURIComponent(
                          r.email,
                        )}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
                        window.location.href = mailto;
                        const ok = window.confirm(
                          `Mail client opened for ${r.name || r.email}.\n\n` +
                            `Click OK after you've sent the email to mark this recipient as Sent.\n` +
                            `Click Cancel if you didn't send it.`,
                        );
                        if (!ok) return;
                        onMarkSent(r).catch((err) =>
                          console.error("Failed to mark recipient as sent", err),
                        );
                      }}
                      hasClaimPackage={!!r.claimPackage}
                      hasEmail={!!r.email}
                      alreadySent={!!log?.sentAt}
                      busy={busy !== null}
                      payslipHref={`/payouts/payslip?id=${record.id}&row=${r.rowIndex}`}
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
        reveals only the stealth addresses, not the mapping to names or per-recipient amounts.
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

interface RowMenuProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onCopy: () => void;
  onSend: () => void;
  hasClaimPackage: boolean;
  hasEmail: boolean;
  alreadySent: boolean;
  busy: boolean;
  payslipHref: string;
}

function RowMenu({
  open,
  onOpen,
  onClose,
  onCopy,
  onSend,
  hasClaimPackage,
  hasEmail,
  alreadySent,
  busy,
  payslipHref,
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
            disabled={!hasEmail || busy}
            onClick={onSend}
            className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-primary-soft)] disabled:opacity-40"
            title={!hasEmail ? "No email on file for this recipient" : undefined}
          >
            {alreadySent ? "Resend via mail client" : "Send via mail client"}
          </button>
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
