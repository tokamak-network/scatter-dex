/**
 * Address book persisted in the notes folder. The implementation
 * lives in `@zkscatter/sdk/storage` so frontend and Pay (and any
 * future zkScatter app) read and write the same
 * `zkscatter-wallets.json` schema.
 *
 * Frontend's `note-storage.ts` mirrors its `dirHandle` into the SDK
 * via `adoptHandle` whenever the user picks or restores a folder, so
 * SDK file I/O sees the same folder this app does.
 *
 * This file kept its old import path (`../lib/wallet-book`) so
 * existing callers (`AddressPicker.tsx`, `wallets/page.tsx`) don't
 * have to change. Once frontend pages migrate to importing from
 * `@zkscatter/sdk/storage` directly, this shim can drop.
 */

export {
  WalletBookCorruptError,
  type WalletEntry,
  hasDefaultAddress,
  loadWalletBook,
  addWallet,
  updateWallet,
  removeWallet,
} from "@zkscatter/sdk/storage";
