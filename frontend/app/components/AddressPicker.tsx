"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BookUser } from "lucide-react";
import { hasDefaultAddress, loadWalletBook, type WalletEntry } from "../lib/wallet-book";
import { hasFolderSelected } from "../lib/zk/note-storage";
import { shortenAddress } from "../lib/utils";

/**
 * Address book picker button. Lazily loads the wallet book on first
 * open; calls `onPick` with the selected address. Renders nothing if
 * the notes folder isn't selected (so existing recipient inputs stay
 * functional without a folder).
 */
export function AddressPicker({ onPick }: { onPick: (address: string) => void }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<WalletEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await loadWalletBook());
    } finally {
      setLoading(false);
    }
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!hasFolderSelected()) return null;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && entries === null) load();
        }}
        title="Pick from address book"
        className="p-2 rounded-md text-on-surface-variant hover:bg-white/10 hover:text-primary transition-colors"
      >
        <BookUser className="w-4 h-4" />
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-64 max-h-64 overflow-y-auto z-20 rounded-lg border border-outline-variant/20 bg-surface-container shadow-lg">
          {loading && (
            <div className="px-3 py-2 text-xs text-on-surface-variant">Loading…</div>
          )}
          {!loading && entries?.length === 0 && (
            <div className="px-3 py-3 text-xs text-on-surface-variant">
              No saved addresses.{" "}
              <a href="/wallets" className="text-primary hover:underline">
                Add some
              </a>
              .
            </div>
          )}
          {!loading &&
            entries?.filter(hasDefaultAddress).map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => {
                  onPick(e.address);
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-2 hover:bg-white/5 transition-colors border-b border-outline-variant/10 last:border-b-0"
              >
                <div className="text-xs font-semibold text-on-surface">{e.label}</div>
                <div className="text-[10px] font-mono text-on-surface-variant">
                  {shortenAddress(e.address)}
                </div>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
