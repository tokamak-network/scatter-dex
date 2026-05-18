"use client";

import { useMemo, useState } from "react";
import { Modal } from "@zkscatter/ui";
import type { WalletEntry } from "@zkscatter/sdk/storage";

/** Multi-select picker over the address book. Used by both Pay's
 *  payout wizard and Pro's order form — that's why it lives in the
 *  shared package instead of either app's component tree.
 *
 *  `getVerification` is optional so callers without an identity
 *  source still work (legacy behaviour). When provided, unverified
 *  rows are visibly tagged and unselectable — recipients who can't
 *  claim shouldn't be queued up only to fail after the proof burn. */
export function AddressBookPicker({
  entries,
  onCancel,
  onPick,
  getVerification,
}: {
  entries: WalletEntry[];
  onCancel: () => void;
  onPick: (picked: WalletEntry[]) => void;
  getVerification?: (address: string) => "verified" | "unverified" | null;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Drop entries without a default 0x address up front. The recipient
  // editor only consumes plain EOAs, so surfacing meta-only legacy
  // entries here would let users select rows that the editor then
  // silently skips on insert — no rows added, no feedback shown.
  const addressable = useMemo(
    () => entries.filter((e) => !!e.address),
    [entries],
  );
  const filtered = useMemo(() => {
    if (!search.trim()) return addressable;
    const q = search.toLowerCase();
    return addressable.filter(
      (e) =>
        e.label.toLowerCase().includes(q) ||
        (e.address?.includes(q) ?? false) ||
        (e.email?.toLowerCase().includes(q) ?? false) ||
        (e.telegramHandle?.toLowerCase().includes(q) ?? false) ||
        (e.kakaoId?.toLowerCase().includes(q) ?? false) ||
        (e.memo?.toLowerCase().includes(q) ?? false),
    );
  }, [addressable, search]);

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
        placeholder="Search by name, address, email, telegram, kakao, or memo…"
        className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
      />
      <div className="mt-4 max-h-[40vh] overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="text-center text-sm text-[var(--color-text-muted)]">
            {addressable.length === 0
              ? entries.length === 0
                ? "No recipients yet."
                : "No address-book entries have a default wallet address. Edit an entry on the address book page to add one."
              : "No matches."}
          </div>
        ) : (
          <ul className="space-y-1">
            {filtered.map((e) => {
              const status = getVerification?.(e.address!) ?? null;
              const isUnverified = status === "unverified";
              return (
                <li key={e.id}>
                  <label
                    className={`flex items-center gap-3 rounded-md border border-transparent px-2 py-1.5 ${
                      isUnverified
                        ? "cursor-not-allowed opacity-60"
                        : "cursor-pointer hover:border-[var(--color-border)]"
                    }`}
                    title={
                      isUnverified
                        ? "Recipient hasn't completed zk-X509 verification — they can't claim."
                        : undefined
                    }
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(e.id)}
                      onChange={() => toggle(e.id)}
                      disabled={isUnverified}
                    />
                    <div className="flex-1 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{e.label}</span>
                        {isUnverified && (
                          <span className="inline-flex items-center rounded-full bg-[var(--color-warning-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-warning)]">
                            ⚠ Unverified
                          </span>
                        )}
                        {status === "verified" && (
                          <span className="inline-flex items-center rounded-full bg-[var(--color-success-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-success)]">
                            ✓ Verified
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-xs text-[var(--color-text-muted)]">
                        {e.address!.slice(0, 10)}…{e.address!.slice(-4)}
                        {e.memo ? ` · ${e.memo}` : ""}
                      </div>
                      {e.email && (
                        <div className="text-xs text-[var(--color-text-muted)]">
                          {e.email}
                        </div>
                      )}
                    </div>
                  </label>
                </li>
              );
            })}
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
