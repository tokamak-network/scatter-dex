"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Field, Modal } from "@zkscatter/ui";
import type { WalletEntry } from "@zkscatter/sdk/storage";
import { useFolderStorage } from "../_lib/folderStorage";
import { useWalletBook } from "../_lib/walletBook";

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
        (e.memo?.toLowerCase().includes(q) ?? false),
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
          <button
            onClick={() => setEditing({ mode: "new" })}
            className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            + Add recipient
          </button>
        )}
      </div>

      {!folder.available && <UnsupportedBanner />}
      {folder.available && !folder.ready && !folder.restoring && (
        <PickFolderBanner onPick={() => void folder.select()} />
      )}
      {folder.ready && book.corrupt && <CorruptBanner message={book.corrupt.message} />}

      {folder.ready && !book.corrupt && (
        <>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, address, or memo…"
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
            <th className="px-5 py-3 text-left">Memo</th>
            <th className="px-5 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-t border-[var(--color-border)]">
              <td className="px-5 py-3 font-medium">{e.label}</td>
              <td className="px-5 py-3 font-mono text-xs">
                {e.address.slice(0, 10)}…{e.address.slice(-4)}
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
          ))}
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
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    try {
      const ok = isNew
        ? Boolean(await book.add({ label, address, memo: memo || undefined }))
        : await book.update(initial!.id, { label, memo: memo || undefined });
      if (ok) onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={isNew ? "Add recipient" : "Edit recipient"}>
      <div className="space-y-3 text-sm">
        <Field label="Label">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Alice (engineering)"
            className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
          />
        </Field>
        <Field
          label="Wallet address"
          hint={!isNew ? "Address is immutable. Remove and re-add to change it." : undefined}
        >
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            disabled={!isNew}
            placeholder="0x…"
            className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono text-xs disabled:bg-[var(--color-bg)]"
          />
        </Field>
        <Field label="Memo (optional)">
          <input
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="Internal note"
            className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
          />
        </Field>
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
          disabled={submitting || !label.trim() || (isNew && !address.trim())}
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

