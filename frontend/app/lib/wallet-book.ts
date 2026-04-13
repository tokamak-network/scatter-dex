/**
 * Address book persisted in the notes folder (same File System Access
 * API directory that holds deposit notes, order bundles, and EdDSA keys).
 *
 * Stored as a single JSON file `zkscatter-wallets.json`; entries are
 * keyed by a stable random `id` so labels can be renamed without
 * orphaning references.
 */

import { ethers } from "ethers";
import {
  hasFolderSelected,
  loadFileFromFolder,
  saveFileToFolder,
} from "./zk/note-storage";

const WALLET_BOOK_FILENAME = "zkscatter-wallets.json";

export interface WalletEntry {
  id: string;
  label: string;
  address: string;     // lowercase 0x-prefixed
  memo?: string;
  createdAt: number;   // unix seconds
}

interface WalletBookFile {
  version: 1;
  entries: WalletEntry[];
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isValidEntry(e: unknown): e is WalletEntry {
  if (!e || typeof e !== "object") return false;
  const v = e as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.label === "string" &&
    typeof v.address === "string" &&
    ethers.isAddress(v.address) &&
    typeof v.createdAt === "number"
  );
}

export async function loadWalletBook(): Promise<WalletEntry[]> {
  if (!hasFolderSelected()) return [];
  const text = await loadFileFromFolder(WALLET_BOOK_FILENAME);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as WalletBookFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(isValidEntry);
  } catch (e) {
    console.warn("[wallet-book] parse failed:", e);
    return [];
  }
}

async function writeBook(entries: WalletEntry[]): Promise<void> {
  const payload: WalletBookFile = { version: 1, entries };
  await saveFileToFolder(WALLET_BOOK_FILENAME, JSON.stringify(payload, null, 2));
}

export async function addWallet(input: {
  label: string;
  address: string;
  memo?: string;
}): Promise<WalletEntry> {
  if (!ethers.isAddress(input.address)) throw new Error("Invalid address");
  const label = input.label.trim();
  if (!label) throw new Error("Label is required");
  const address = input.address.toLowerCase();

  const entries = await loadWalletBook();
  if (entries.some((e) => e.address === address)) {
    throw new Error("Address already in book");
  }
  const entry: WalletEntry = {
    id: newId(),
    label,
    address,
    memo: input.memo?.trim() || undefined,
    createdAt: Math.floor(Date.now() / 1000),
  };
  await writeBook([...entries, entry]);
  return entry;
}

export async function updateWallet(
  id: string,
  patch: Partial<Pick<WalletEntry, "label" | "memo">>,
): Promise<void> {
  if (patch.label !== undefined && !patch.label.trim()) {
    throw new Error("Label is required");
  }
  const entries = await loadWalletBook();
  const next = entries.map((e) =>
    e.id === id
      ? {
          ...e,
          label: patch.label !== undefined ? patch.label.trim() : e.label,
          memo: patch.memo !== undefined ? patch.memo.trim() || undefined : e.memo,
        }
      : e,
  );
  await writeBook(next);
}

export async function removeWallet(id: string): Promise<void> {
  const entries = await loadWalletBook();
  await writeBook(entries.filter((e) => e.id !== id));
}
