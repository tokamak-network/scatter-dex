"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Field, Modal } from "@zkscatter/ui";
import { shortAddr } from "@zkscatter/sdk/react";
import { type WalletEntry } from "@zkscatter/sdk/storage";
import { WorkspaceBar } from "../_components/WorkspaceBar";
import { IdentityBadge } from "../_components/IdentityBadge";
import { useFolderStorage } from "../_lib/folderStorage";
import { useWalletBook } from "../_lib/walletBook";
import { csvEscape, downloadCsv } from "../_lib/csv";

/** Lightweight email shape check — RFC-5322 in full would be
 *  overkill; we just want "has an at-sign with something on either
 *  side" so the user doesn't ship `email: "alice"` to the SDK. */
const EMAIL_RE = /^\S+@\S+\.\S+$/;

type EditingState = { mode: "new" } | { mode: "edit"; entry: WalletEntry };

/** Address book — list / add / edit / remove. Backed by
 *  `zkscatter-wallets.json` in the user-picked folder
 *  (`@zkscatter/sdk/storage/walletBook`). Folder-gated: when no
 *  folder is selected we render a banner that prompts the user to
 *  pick one before any CRUD UI shows. */
export default function RecipientsPage() {
  const folder = useFolderStorage();
  const book = useWalletBook();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<WalletEntry | null>(null);

  const filtered = useMemo(() => {
    if (!search.trim()) return book.entries;
    const q = search.toLowerCase();
    return book.entries.filter(
      (e) =>
        e.label.toLowerCase().includes(q) ||
        (e.address?.includes(q) ?? false) ||
        (e.memo?.toLowerCase().includes(q) ?? false) ||
        (e.email?.toLowerCase().includes(q) ?? false) ||
        (e.telegramHandle?.toLowerCase().includes(q) ?? false) ||
        (e.kakaoId?.toLowerCase().includes(q) ?? false),
    );
  }, [book.entries, search]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Address book</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Reusable list of payees. Pick entries here from the New-payout wizard's <span className="font-medium">Recipients</span> step. Stored as <span className="font-mono">zkscatter-wallets.json</span> in your notes folder so finance ops can back it up alongside everything else.
          </p>
        </div>
        {folder.ready && !book.corrupt && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => downloadAsCsv(book.entries)}
              disabled={book.entries.length === 0}
              title={
                book.entries.length === 0
                  ? "No contacts to export yet"
                  : `Download all ${book.entries.length} contacts as CSV`
              }
              className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm hover:bg-[var(--color-primary-soft)] disabled:opacity-40"
            >
              ⬇ Export CSV
            </button>
            <button
              onClick={() => setEditing({ mode: "new" })}
              className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
            >
              + Add address
            </button>
          </div>
        )}
      </div>

      <WorkspaceBar />

      {folder.available === false && <UnsupportedBanner />}
      {folder.ready && book.corrupt && <CorruptBanner message={book.corrupt.message} />}

      {folder.ready && !book.corrupt && (
        <>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, address, email, telegram, kakao, or memo…"
            className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
          />

          {!book.loaded ? (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-10 text-center text-sm text-[var(--color-text-muted)]">
              Reading your address book…
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-10 text-center text-sm text-[var(--color-text-muted)]">
              {book.entries.length === 0
                ? "No addresses yet. Click \"Add address\" to get started."
                : "No matches."}
            </div>
          ) : (
            <RecipientTable
              entries={filtered}
              onEdit={(e) => setEditing({ mode: "edit", entry: e })}
              onRemove={setConfirmRemove}
            />
          )}

          {book.error && (
            <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
              {book.error}
            </div>
          )}
        </>
      )}

      {editing && (
        <RecipientForm
          // Identity-keyed so the form remounts (and clears its
          // local input state) when the user switches between
          // editing different entries without closing the modal.
          key={editing.mode === "new" ? "new" : editing.entry.id}
          state={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {confirmRemove && (
        <ConfirmRemove
          entry={confirmRemove}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={async () => {
            await book.remove(confirmRemove.id);
            setConfirmRemove(null);
          }}
        />
      )}
    </div>
  );
}

function RecipientTable({
  entries,
  onEdit,
  onRemove,
}: {
  entries: WalletEntry[];
  onEdit: (e: WalletEntry) => void;
  onRemove: (e: WalletEntry) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full text-sm">
        <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
          <tr>
            <th className="px-5 py-3 text-left">Label</th>
            <th className="px-5 py-3 text-left">Address</th>
            <th className="px-5 py-3 text-left">Email</th>
            <th className="px-5 py-3 text-left">Memo</th>
            <th className="px-5 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            return (
              <tr key={e.id} className="border-t border-[var(--color-border)]">
                <td className="px-5 py-3 font-medium">
                  {e.label}
                </td>
                <td className="px-5 py-3 font-mono text-xs">
                  {e.address ? (
                    <span className="inline-flex items-center gap-1.5">
                      {shortAddr(e.address)}
                      <IdentityBadge address={e.address} />
                    </span>
                  ) : (
                    <span className="text-[var(--color-text-muted)]">—</span>
                  )}
                </td>
                <td className="px-5 py-3 text-[var(--color-text-muted)]">
                  {e.email ?? "—"}
                </td>
                <td className="px-5 py-3 text-[var(--color-text-muted)]">
                  {e.memo ?? "—"}
                </td>
                <td className="px-5 py-3 text-right text-xs">
                  <button
                    onClick={() => onEdit(e)}
                    className="mr-2 rounded border border-[var(--color-border-strong)] px-2 py-1 hover:bg-[var(--color-primary-soft)]"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => onRemove(e)}
                    className="rounded border border-[var(--color-border-strong)] px-2 py-1 hover:bg-[var(--color-danger-soft,var(--color-warning-soft))]"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RecipientForm({
  state,
  onClose,
}: {
  state: EditingState;
  onClose: () => void;
}) {
  const book = useWalletBook();
  const isNew = state.mode === "new";
  const initial = state.mode === "edit" ? state.entry : null;
  const [label, setLabel] = useState(initial?.label ?? "");
  const [address, setAddress] = useState(initial?.address ?? "");
  const [memo, setMemo] = useState(initial?.memo ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [telegramHandle, setTelegramHandle] = useState(initial?.telegramHandle ?? "");
  const [kakaoId, setKakaoId] = useState(initial?.kakaoId ?? "");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    try {
      const trimmedLabel = label.trim();
      const trimmedMemo = memo.trim();
      const trimmedEmail = email.trim();
      const trimmedTelegram = telegramHandle.trim();
      const trimmedKakao = kakaoId.trim();
      const trimmedAddress = address.trim();
      const ok = isNew
        ? Boolean(
            await book.add({
              label: trimmedLabel,
              // Pass empty strings through verbatim — the SDK
              // (`addWallet`) throws "Address is required" on empty
              // values, and the wrapper's catch in walletBook.tsx
              // surfaces that as a form error. Collapsing "" to
              // `undefined` would make TS happy under the loosened
              // wrapper signature but silently hide the validation
              // error from the user.
              address: trimmedAddress,
              memo: trimmedMemo || undefined,
              email: trimmedEmail || undefined,
              telegramHandle: trimmedTelegram || undefined,
              kakaoId: trimmedKakao || undefined,
            }),
          )
        : await book.update(initial!.id, {
            label: trimmedLabel,
            // Pass the raw trimmed string (including "") through to
            // the SDK rather than `|| undefined`-ing it. SDK
            // `updateWallet` treats `undefined` as "leave on-disk
            // value untouched" and `""` as "clear", so collapsing
            // empty strings to undefined would prevent the user
            // from clearing memo / email / handles through the
            // form.
            memo: trimmedMemo,
            email: trimmedEmail,
            telegramHandle: trimmedTelegram,
            kakaoId: trimmedKakao,
          });
      if (ok) onClose();
    } finally {
      setSubmitting(false);
    }
  }

  const emailInvalid = email.trim().length > 0 && !EMAIL_RE.test(email.trim());
  const missingTarget = isNew && !address.trim();

  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? "Add address" : "Edit address"}
      maxWidthCls="max-w-2xl"
    >
      {isNew && (
        <p className="-mt-1 mb-4 text-xs text-[var(--color-text-muted)]">
          <span className="font-mono text-[var(--color-warning)]">*</span> required
        </p>
      )}
      <div className="grid items-start gap-x-6 gap-y-5 text-sm md:grid-cols-2">
        <FormSection title="Identity">
          <Field label={"Label *"}>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Alice (engineering)"
              className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
            />
          </Field>
          <Field
            label={
              <>
                {isNew ? "Default wallet address *" : "Default wallet address"}
                <InfoTip
                  text={
                    isNew
                      ? "Address used for every payout run to this recipient."
                      : initial?.addressByChain && Object.keys(initial.addressByChain).length > 0
                        ? "Address is immutable. Remove and re-add to change it. This entry also carries per-chain overrides from an older app version (legacy field — not editable here)."
                        : "Address is immutable. Remove and re-add to change it."
                  }
                />
              </>
            }
          >
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              disabled={!isNew}
              placeholder="0x…"
              className={`w-full rounded-md border bg-white px-3 py-2 font-mono text-xs disabled:bg-[var(--color-bg)] ${
                missingTarget
                  ? "border-[var(--color-warning)]"
                  : "border-[var(--color-border-strong)]"
              }`}
            />
            {address.trim().length > 0 && (
              <div className="mt-1.5">
                <IdentityBadge address={address.trim()} />
              </div>
            )}
          </Field>
        </FormSection>

        <FormSection title="Contact">
          <Field
            label={
              <>
                Email (optional)
                <InfoTip text="Pay copies this into the run record at send time so claim emails reach the right inbox." />
              </>
            }
          >
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="alice@example.com"
              type="email"
              className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
            />
            {emailInvalid && (
              <p className="mt-1 text-xs text-[var(--color-warning)]">
                Doesn&apos;t look like a valid email — clear it or fix the
                format before saving.
              </p>
            )}
          </Field>
          <Field
            label={
              <>
                Telegram handle (optional)
                <InfoTip text="Reserved for the Telegram delivery channel; mirrors the email field today." />
              </>
            }
          >
            <input
              value={telegramHandle}
              onChange={(e) => setTelegramHandle(e.target.value)}
              placeholder="@alice"
              className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
            />
          </Field>
          <Field
            label={
              <>
                Kakao account (optional)
                <InfoTip text="Email tied to the recipient's Kakao account (the same address Kakao uses for login). Reserved for the KakaoTalk delivery channel; mirrors the email field today." />
              </>
            }
          >
            <input
              value={kakaoId}
              onChange={(e) => setKakaoId(e.target.value)}
              placeholder="alice@kakao.com"
              type="email"
              className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
            />
          </Field>
        </FormSection>

        <FormSection title="Notes">
          <Field label="Memo (optional)">
            <input
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Internal note"
              className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
            />
          </Field>
        </FormSection>

        {book.error && (
          <div className="rounded border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-2 text-xs text-[var(--color-warning)] md:col-span-2">
            {book.error}
          </div>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-md border border-[var(--color-border-strong)] px-4 py-2 text-sm"
        >
          Cancel
        </button>
        <button
          onClick={() => void submit()}
          disabled={submitting || !label.trim() || missingTarget || emailInvalid}
          className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
        >
          {submitting ? "Saving…" : isNew ? "Add" : "Save"}
        </button>
      </div>
    </Modal>
  );
}

function ConfirmRemove({
  entry,
  onCancel,
  onConfirm,
}: {
  entry: WalletEntry;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [removing, setRemoving] = useState(false);
  return (
    <Modal open onClose={onCancel} title="Remove recipient" maxWidthCls="max-w-sm">
      <p className="text-sm text-[var(--color-text-muted)]">
        Remove <strong>{entry.label}</strong> from the address book? Past
        payouts to this address remain on-chain — only the local entry is
        deleted.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-md border border-[var(--color-border-strong)] px-4 py-2 text-sm"
        >
          Cancel
        </button>
        <button
          onClick={async () => {
            setRemoving(true);
            try {
              await onConfirm();
            } finally {
              setRemoving(false);
            }
          }}
          disabled={removing}
          className="rounded-md bg-[var(--color-warning)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {removing ? "Removing…" : "Remove"}
        </button>
      </div>
    </Modal>
  );
}


function UnsupportedBanner() {
  return (
    <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-4 text-sm text-[var(--color-warning)]">
      <strong className="block">Browser doesn&apos;t support folder storage.</strong>
      Pay&apos;s address book uses the File System Access API. Chrome / Edge / Opera 86+ work; Firefox and Safari don&apos;t expose it yet. <Link href="/" className="underline">Back home</Link>.
    </div>
  );
}

function CorruptBanner({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-4 text-sm text-[var(--color-warning)]">
      <strong className="block">Address book file is corrupt</strong>
      <p className="mt-1">{message}</p>
      <p className="mt-2 text-xs">
        Open <span className="font-mono">zkscatter-wallets.json</span> in a
        text editor to repair, or rename it and the next add will create a
        fresh book.
      </p>
    </div>
  );
}


function InfoTip({ text }: { text: string }) {
  return (
    <span className="group relative ml-1 inline-flex">
      <span
        aria-label={text}
        tabIndex={0}
        className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-[var(--color-border-strong)] text-[10px] font-semibold normal-case text-[var(--color-text-muted)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] focus:outline-none focus:border-[var(--color-primary)] focus:text-[var(--color-primary)]"
      >
        ?
      </span>
      <span
        role="tooltip"
        className="pointer-events-none invisible absolute bottom-full left-1/2 z-10 mb-2 w-64 -translate-x-1/2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left text-[11px] font-normal normal-case leading-snug tracking-normal text-[var(--color-text)] opacity-0 shadow-lg transition-opacity duration-100 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

function FormSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
        <span>{title}</span>
        {hint && <InfoTip text={hint} />}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/** Header row + column order produced by the export. The
 *  forthcoming bulk-import path will accept the same shape so a
 *  round-trip (export → edit in a spreadsheet → re-import) lands
 *  byte-equivalent entries on disk. `addressByChain` is intentionally
 *  excluded — the form no longer surfaces per-chain overrides, and
 *  exporting a column the user can't edit just creates round-trip
 *  drift. Legacy entries that still carry the field on disk keep it
 *  there; only the export view drops it. */
const CSV_COLUMNS = [
  "label",
  "address",
  "email",
  "telegramHandle",
  "kakaoId",
  "memo",
] as const;

function entryToCsvRow(e: WalletEntry): string {
  const cells = [
    e.label,
    e.address ?? "",
    e.email ?? "",
    e.telegramHandle ?? "",
    e.kakaoId ?? "",
    e.memo ?? "",
  ];
  return cells.map(csvEscape).join(",");
}

function downloadAsCsv(entries: WalletEntry[]): void {
  const lines = [CSV_COLUMNS.join(","), ...entries.map(entryToCsvRow)];
  const stamp = new Date().toISOString().slice(0, 10);
  downloadCsv(lines.join("\n") + "\n", `zkscatter-wallets-${stamp}.csv`);
}
