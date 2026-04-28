"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Field, Modal } from "@zkscatter/ui";
import { shortAddr } from "@zkscatter/sdk/react";
import {
  isCanonicalChainKey,
  type WalletEntry,
} from "@zkscatter/sdk/storage";
import { useFolderStorage } from "../_lib/folderStorage";
import { useWalletBook } from "../_lib/walletBook";

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
        e.address.includes(q) ||
        (e.memo?.toLowerCase().includes(q) ?? false) ||
        (e.email?.toLowerCase().includes(q) ?? false) ||
        (e.discordHandle?.toLowerCase().includes(q) ?? false),
    );
  }, [book.entries, search]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Recipients</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Reusable list of payees. Stored as <span className="font-mono">zkscatter-wallets.json</span> in your notes folder so finance ops can back it up alongside everything else.
          </p>
        </div>
        {folder.ready && !book.corrupt && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => downloadAsCsv(book.entries)}
              disabled={book.entries.length === 0}
              title={
                book.entries.length === 0
                  ? "No recipients to export yet"
                  : `Download all ${book.entries.length} recipients as CSV`
              }
              className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm hover:bg-[var(--color-primary-soft)] disabled:opacity-40"
            >
              ⬇ Export CSV
            </button>
            <button
              onClick={() => setEditing({ mode: "new" })}
              className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
            >
              + Add recipient
            </button>
          </div>
        )}
      </div>

      {folder.available === false && <UnsupportedBanner />}
      {folder.available === true && !folder.ready && !folder.restoring && (
        <PickFolderBanner onPick={() => void folder.select()} />
      )}
      {folder.ready && book.corrupt && <CorruptBanner message={book.corrupt.message} />}

      {folder.ready && !book.corrupt && (
        <>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, address, email, discord, or memo…"
            className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
          />

          {!book.loaded ? (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-10 text-center text-sm text-[var(--color-text-muted)]">
              Reading your address book…
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-10 text-center text-sm text-[var(--color-text-muted)]">
              {book.entries.length === 0
                ? "No recipients yet. Click \"Add recipient\" to get started."
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
            <th className="px-5 py-3 text-left">Chains</th>
            <th className="px-5 py-3 text-left">Memo</th>
            <th className="px-5 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const overrideCount = e.addressByChain
              ? Object.keys(e.addressByChain).length
              : 0;
            return (
              <tr key={e.id} className="border-t border-[var(--color-border)]">
                <td className="px-5 py-3 font-medium">{e.label}</td>
                <td className="px-5 py-3 font-mono text-xs">
                  {shortAddr(e.address)}
                </td>
                <td className="px-5 py-3 text-[var(--color-text-muted)]">
                  {e.email ?? "—"}
                </td>
                <td className="px-5 py-3 text-xs text-[var(--color-text-muted)]">
                  {overrideCount === 0
                    ? "default only"
                    : `${overrideCount} override${overrideCount === 1 ? "" : "s"}`}
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

/** Per-chain address override row. The form keeps these as a flat
 *  array of `{chainId, address}` pairs because objects in React state
 *  are awkward to edit row-by-row; the array gets folded into a
 *  `Record<number, string>` at submit time. */
type ChainOverride = { chainId: string; address: string };

function chainOverridesToArray(
  m: Record<number, string> | undefined,
): ChainOverride[] {
  if (!m) return [];
  return Object.entries(m).map(([chainId, address]) => ({ chainId, address }));
}

function chainOverridesToRecord(
  arr: ChainOverride[],
): Record<number, string> | undefined {
  // Loose: skip anything the SDK would reject so the user can leave
  // half-filled trailing rows during editing without the save failing.
  // Validation surfacing on those rows is deliberately deferred to the
  // SDK error banner above the submit button — see the issue tracker
  // for a per-row inline-error follow-up.
  const out: Record<number, string> = {};
  for (const { chainId, address } of arr) {
    const id = chainId.trim();
    const addr = address.trim();
    if (!id || !addr) continue;
    if (!isCanonicalChainKey(id)) continue;
    out[Number(id)] = addr.toLowerCase();
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
  const [discordHandle, setDiscordHandle] = useState(initial?.discordHandle ?? "");
  const [chainOverrides, setChainOverrides] = useState<ChainOverride[]>(
    chainOverridesToArray(initial?.addressByChain),
  );
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    try {
      const trimmedLabel = label.trim();
      const trimmedMemo = memo.trim();
      const trimmedEmail = email.trim();
      const trimmedDiscord = discordHandle.trim();
      const overrides = chainOverridesToRecord(chainOverrides);
      // The form is the source of truth for `addressByChain`: every
      // save sends whatever the form has now, replacing the on-disk
      // value. If the user emptied every row, an empty record is
      // sent — `updateWallet` then writes `addressByChain: undefined`
      // (its `Object.keys(out).length > 0` check). There is no
      // "leave untouched" path because the form always re-renders
      // every override row from disk on open.
      const ok = isNew
        ? Boolean(
            await book.add({
              label: trimmedLabel,
              address,
              memo: trimmedMemo || undefined,
              email: trimmedEmail || undefined,
              discordHandle: trimmedDiscord || undefined,
              addressByChain: overrides,
            }),
          )
        : await book.update(initial!.id, {
            label: trimmedLabel,
            memo: trimmedMemo || undefined,
            email: trimmedEmail || undefined,
            discordHandle: trimmedDiscord || undefined,
            addressByChain: overrides ?? {},
          });
      if (ok) onClose();
    } finally {
      setSubmitting(false);
    }
  }

  const emailInvalid = email.trim().length > 0 && !EMAIL_RE.test(email.trim());

  function addOverrideRow() {
    setChainOverrides((prev) => [...prev, { chainId: "", address: "" }]);
  }

  function updateOverrideRow(idx: number, patch: Partial<ChainOverride>) {
    setChainOverrides((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    );
  }

  function removeOverrideRow(idx: number) {
    setChainOverrides((prev) => prev.filter((_, i) => i !== idx));
  }

  return (
    <Modal open onClose={onClose} title={isNew ? "Add recipient" : "Edit recipient"}>
      <div className="space-y-5 text-sm">
        <FormSection title="Identity">
          <Field label="Label">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Alice (engineering)"
              className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
            />
          </Field>
          <Field
            label="Default wallet address"
            hint={
              !isNew
                ? "Address is immutable. Remove and re-add to change it."
                : "Used when the run's chain is not in the per-chain overrides below."
            }
          >
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              disabled={!isNew}
              placeholder="0x…"
              className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono text-xs disabled:bg-[var(--color-bg)]"
            />
          </Field>
        </FormSection>

        <FormSection title="Contact">
          <Field
            label="Email (optional)"
            hint="Pay copies this into the run record at send time so claim emails reach the right inbox."
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
            label="Discord handle (optional)"
            hint="Reserved for the Discord delivery channel; mirrors the email field today."
          >
            <input
              value={discordHandle}
              onChange={(e) => setDiscordHandle(e.target.value)}
              placeholder="alice#1234"
              className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
            />
          </Field>
        </FormSection>

        <FormSection
          title="Per-chain addresses"
          hint="Use when the same person has different addresses on different chains (e.g., Ethereum vs an L2). Empty out every row to clear all overrides."
        >
          <div className="space-y-2">
            {chainOverrides.map((row, idx) => (
              <div key={idx} className="flex gap-2">
                <input
                  value={row.chainId}
                  onChange={(e) =>
                    updateOverrideRow(idx, { chainId: e.target.value })
                  }
                  placeholder="Chain id"
                  inputMode="numeric"
                  className="w-28 rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-xs"
                />
                <input
                  value={row.address}
                  onChange={(e) =>
                    updateOverrideRow(idx, { address: e.target.value })
                  }
                  placeholder="0x…"
                  className="flex-1 rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono text-xs"
                />
                <button
                  onClick={() => removeOverrideRow(idx)}
                  title="Remove this row"
                  className="rounded border border-[var(--color-border-strong)] px-2 text-xs text-[var(--color-text-subtle)] hover:text-[var(--color-warning)]"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              onClick={addOverrideRow}
              className="rounded border border-[var(--color-border-strong)] px-2 py-1 text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-primary-soft)]"
            >
              ＋ Add chain override
            </button>
          </div>
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
          <div className="rounded border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-2 text-xs text-[var(--color-warning)]">
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
          disabled={
            submitting ||
            !label.trim() ||
            (isNew && !address.trim()) ||
            emailInvalid
          }
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

function PickFolderBanner({ onPick }: { onPick: () => void }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
      <h3 className="text-sm font-semibold">Pick a notes folder</h3>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
        Pay stores your address book + commitment notes as files in a folder
        you choose. Pick once — the browser remembers it across sessions. The
        same folder can be used by other zkScatter apps for shared access.
      </p>
      <button
        onClick={onPick}
        className="mt-3 rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
      >
        Pick folder
      </button>
    </div>
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
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
        {title}
      </div>
      {hint && (
        <p className="mb-2 text-xs text-[var(--color-text-muted)]">{hint}</p>
      )}
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/** Header row + column order produced by the export. The
 *  forthcoming bulk-import path will accept the same shape so a
 *  round-trip (export → edit in a spreadsheet → re-import) lands
 *  byte-equivalent entries on disk. `addressByChain` is serialised
 *  as `chain:addr|chain:addr` because spreadsheets don't grow extra
 *  columns gracefully and JSON-in-a-cell trips on stray commas. */
const CSV_COLUMNS = [
  "label",
  "address",
  "email",
  "discordHandle",
  "memo",
  "addressByChain",
] as const;

function csvEscape(value: string): string {
  // Quote when the value contains the delimiter, a quote, or a
  // newline — Excel / Numbers / Sheets all parse the doubled-quote
  // escape (`"foo ""bar""`).
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function entryToCsvRow(e: WalletEntry): string {
  const overrides = e.addressByChain
    ? Object.entries(e.addressByChain)
        .map(([chainId, addr]) => `${chainId}:${addr}`)
        .join("|")
    : "";
  const cells = [
    e.label,
    e.address,
    e.email ?? "",
    e.discordHandle ?? "",
    e.memo ?? "",
    overrides,
  ];
  return cells.map(csvEscape).join(",");
}

function downloadAsCsv(entries: WalletEntry[]): void {
  const lines = [CSV_COLUMNS.join(","), ...entries.map(entryToCsvRow)];
  // Prepend a UTF-8 BOM so Excel on Windows reads non-ASCII labels
  // (e.g. Korean recipient names) as Unicode instead of cp1252.
  const blob = new Blob(["﻿" + lines.join("\n") + "\n"], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `zkscatter-recipients-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Defer the revoke so Safari has time to start the download
    // (matches the workspace export pattern in FolderPill).
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
