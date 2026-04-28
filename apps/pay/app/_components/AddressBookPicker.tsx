"use client";

import { useMemo, useState } from "react";
import { Modal } from "@zkscatter/ui";
import type { WalletEntry } from "@zkscatter/sdk/storage";

/** Multi-select picker over the address book. The wizard's
 *  Recipients step calls this; future surfaces (claim-link
 *  recipient, dashboard quick-send) will hit it too — that's why it
 *  lives in `_components/` rather than co-located with the wizard. */
export function AddressBookPicker({
  entries,
  onCancel,
  onPick,
}: {
  entries: WalletEntry[];
  onCancel: () => void;
  onPick: (picked: WalletEntry[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const filtered = useMemo(() => {
    if (!search.trim()) return entries;
    const q = search.toLowerCase();
    return entries.filter(
      (e) =>
        e.label.toLowerCase().includes(q) ||
        e.address.includes(q) ||
        (e.memo?.toLowerCase().includes(q) ?? false),
    );
  }, [entries, search]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Modal open onClose={onCancel} title="Add from address book" maxWidthCls="max-w-lg">
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by name, address, or memo…"
        className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
      />
      <div className="mt-4 max-h-[40vh] overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="text-center text-sm text-[var(--color-text-muted)]">
            {entries.length === 0 ? "No recipients yet." : "No matches."}
          </div>
        ) : (
          <ul className="space-y-1">
            {filtered.map((e) => (
              <li key={e.id}>
                <label className="flex cursor-pointer items-center gap-3 rounded-md border border-transparent px-2 py-1.5 hover:border-[var(--color-border)]">
                  <input
                    type="checkbox"
                    checked={selected.has(e.id)}
                    onChange={() => toggle(e.id)}
                  />
                  <div className="flex-1 text-sm">
                    <div className="font-medium">{e.label}</div>
                    <div className="font-mono text-xs text-[var(--color-text-muted)]">
                      {e.address.slice(0, 10)}…{e.address.slice(-4)}
                      {e.memo ? ` · ${e.memo}` : ""}
                    </div>
                  </div>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-5 flex items-center justify-between">
        <span className="text-xs text-[var(--color-text-muted)]">
          {selected.size} selected
        </span>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-[var(--color-border-strong)] px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            onClick={() => onPick(entries.filter((e) => selected.has(e.id)))}
            disabled={selected.size === 0}
            className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
          >
            Add to recipients
          </button>
        </div>
      </div>
    </Modal>
  );
}
