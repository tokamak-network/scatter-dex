"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { BookUser, Plus, Trash2, Copy, Check, X } from "lucide-react";
import { useWallet } from "../lib/wallet";
import { useNotesFolder } from "../lib/zk/useNotesFolder";
import { FolderGate } from "../components/FolderGate";
import { shortenAddress } from "../lib/utils";
import {
  addWallet,
  loadWalletBook,
  removeWallet,
  updateWallet,
  type WalletEntry,
} from "../lib/wallet-book";

export default function WalletsPage() {
  const { account } = useWallet();
  const { folderReady, folderName } = useNotesFolder();

  const [entries, setEntries] = useState<WalletEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const [newLabel, setNewLabel] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [newMemo, setNewMemo] = useState("");
  const [adding, setAdding] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editMemo, setEditMemo] = useState("");

  const refresh = useCallback(async () => {
    if (!folderReady) return;
    setLoading(true);
    try {
      setEntries(await loadWalletBook());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load wallet book");
    } finally {
      setLoading(false);
    }
  }, [folderReady]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleAdd() {
    setError(null);
    if (!ethers.isAddress(newAddress)) {
      setError("Enter a valid Ethereum address.");
      return;
    }
    setAdding(true);
    try {
      await addWallet({ label: newLabel, address: newAddress, memo: newMemo });
      setNewLabel("");
      setNewAddress("");
      setNewMemo("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add wallet");
    } finally {
      setAdding(false);
    }
  }

  function handleAddConnected() {
    if (!account) return;
    setNewLabel((l) => l || "My wallet");
    setNewAddress(account);
  }

  async function handleDelete(id: string) {
    await removeWallet(id);
    await refresh();
  }

  function startEdit(e: WalletEntry) {
    setEditingId(e.id);
    setEditLabel(e.label);
    setEditMemo(e.memo ?? "");
  }

  async function saveEdit() {
    if (!editingId) return;
    await updateWallet(editingId, { label: editLabel, memo: editMemo });
    setEditingId(null);
    await refresh();
  }

  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  async function copyAddress(addr: string) {
    try {
      await navigator.clipboard.writeText(addr);
      setCopied(addr);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(null), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Clipboard copy failed");
    }
  }

  return (
    <div className="pt-28 pb-32 px-6 max-w-[820px] mx-auto">
      <div className="text-center mb-10">
        <BookUser className="w-12 h-12 text-primary mx-auto mb-4" />
        <h1 className="text-3xl font-headline font-bold text-on-surface mb-3">Address Book</h1>
        <p className="text-on-surface-variant">
          Manage recipient addresses for private orders. Stored alongside your commitment notes
          in the selected folder (<code className="text-xs">zkscatter-wallets.json</code>).
        </p>
      </div>

      <FolderGate>
        <>
          <div className="text-xs font-mono text-on-surface-variant mb-6">
            Folder: {folderName ?? "—"}
          </div>

          {/* Add form */}
          <div className="rounded-2xl border border-outline-variant/10 bg-surface-container p-6 space-y-4 mb-8">
            <h2 className="font-headline font-bold text-lg flex items-center gap-2">
              <Plus className="w-5 h-5 text-primary" />
              Add address
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Label (e.g. Cold wallet, Alice)"
                className="bg-surface border border-outline-variant/20 rounded-md px-4 py-3 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary"
              />
              <input
                value={newAddress}
                onChange={(e) => setNewAddress(e.target.value.trim())}
                placeholder="0x…"
                className="bg-surface border border-outline-variant/20 rounded-md px-4 py-3 font-mono text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary"
              />
            </div>
            <input
              value={newMemo}
              onChange={(e) => setNewMemo(e.target.value)}
              placeholder="Memo (optional)"
              className="w-full bg-surface border border-outline-variant/20 rounded-md px-4 py-3 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary"
            />
            <div className="flex items-center gap-3">
              <button
                onClick={handleAdd}
                disabled={adding || !newAddress || !newLabel}
                className="gradient-btn text-on-primary-fixed px-5 py-2.5 rounded-md font-semibold text-sm disabled:opacity-50"
              >
                {adding ? "Saving…" : "Add"}
              </button>
              {account && (
                <button
                  onClick={handleAddConnected}
                  className="text-xs text-primary hover:underline"
                >
                  Use connected wallet ({shortenAddress(account)})
                </button>
              )}
            </div>
            {error && <div className="text-sm text-error">{error}</div>}
          </div>

          {/* List */}
          <div className="space-y-3">
            {loading && <div className="text-sm text-on-surface-variant">Loading…</div>}
            {!loading && entries.length === 0 && (
              <div className="text-sm text-on-surface-variant text-center py-8">
                No addresses yet. Add one above to get started.
              </div>
            )}
            {entries.map((e) => {
              const isEditing = editingId === e.id;
              return (
                <div
                  key={e.id}
                  className="rounded-xl border border-outline-variant/10 bg-surface-container-low p-4 flex items-start gap-4"
                >
                  <div className="flex-1 min-w-0 space-y-1">
                    {isEditing ? (
                      <>
                        <input
                          value={editLabel}
                          onChange={(ev) => setEditLabel(ev.target.value)}
                          className="w-full bg-surface border border-outline-variant/20 rounded-md px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary"
                        />
                        <input
                          value={editMemo}
                          onChange={(ev) => setEditMemo(ev.target.value)}
                          placeholder="Memo (optional)"
                          className="w-full bg-surface border border-outline-variant/20 rounded-md px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary"
                        />
                      </>
                    ) : (
                      <>
                        <div className="font-semibold text-sm text-on-surface">{e.label}</div>
                        <div className="font-mono text-xs text-on-surface-variant break-all">{e.address}</div>
                        {e.memo && (
                          <div className="text-xs text-on-surface-variant/80">{e.memo}</div>
                        )}
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {isEditing ? (
                      <>
                        <button
                          onClick={saveEdit}
                          className="p-2 rounded-md hover:bg-surface text-tertiary"
                          title="Save"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="p-2 rounded-md hover:bg-surface text-on-surface-variant"
                          title="Cancel"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => copyAddress(e.address)}
                          className="p-2 rounded-md hover:bg-surface text-on-surface-variant"
                          title="Copy address"
                        >
                          {copied === e.address ? (
                            <Check className="w-4 h-4 text-tertiary" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </button>
                        <button
                          onClick={() => startEdit(e)}
                          className="text-xs px-2 py-1 rounded-md text-on-surface-variant hover:bg-surface"
                          title="Edit"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(e.id)}
                          className="p-2 rounded-md hover:bg-error/10 text-error"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      </FolderGate>
    </div>
  );
}
