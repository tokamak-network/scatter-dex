# ScatterDEX Mobile — Implementation Guide (Current State)

> **Companion to** [`design.md`](./design.md) (2026-04-10 design memo).
> **Source of truth** for what actually ships on `main`. When the two disagree, this file wins.
> **Last updated**: 2026-04-21

---

## 1. Where the design memo diverged

The 2026-04-10 memo was written during the Capacitor → Expo/RN pivot and before implementation started. The following assumptions in that memo are obsolete:

| Memo assumed | Current reality |
|---|---|
| **WalletConnect-only** wallet access | Built-in wallet is primary (ethers.Wallet + expo-secure-store); WalletConnect is secondary |
| `src/services/{wallet,contract,relayerApi,noteStorage}.ts` (4 files) | 18 services + one context (inventory in §3) |
| `src/zk/` directory | Renamed to `src/zk-engine/` with per-circuit provers |
| Single wallet, one `account` string | Multi-wallet index (`WalletMeta[]`) + `activeWalletId` + per-address data namespaces |
| `shared/` workspace for cross-platform code | Not adopted — mobile duplicates the ZK primitives it needs locally; `packages/types/` stays as the only shared package |
| Stealth addresses: not mentioned | Full EIP-5564 stealth identity + claim flow shipped |
| Escrow hidden notes / commitment list: not mentioned | Shipped as part of Phase 4 |

The high-level technology choices in the memo (**Expo/RN + WebView ZK hybrid + EAS Build**) held up. Everything else should be read as a snapshot of the starting assumptions, not the current system.

---

## 2. Platform security stack (how the app integrates with the OS secure level)

This is the bit the web frontend does not have an analogue for. The mobile app leans on three OS-backed primitives, each wired through Expo.

### 2.1 Hardware-backed key storage

| Layer | API | What goes in it |
|---|---|---|
| **iOS Keychain / Android Keystore** | `expo-secure-store` | Seed phrases, private keys, EdDSA keys, stealth spending/viewing keys, claim secrets, encrypted backups |
| **AsyncStorage** | `@react-native-async-storage/async-storage` | Non-sensitive indexes, per-wallet note metadata (no secrets), network configuration, pending claim metadata (secret extracted into SecureStore) |

- Every sensitive SecureStore write pins `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY`. That flag means:
  - the blob is **bound to this physical device** — a device backup restore to a different device will not carry it forward, and
  - the blob is only readable while the device is unlocked (the Keychain is locked during the first-boot pre-passcode window).
- On Android `expo-secure-store` sits on top of the AndroidKeyStore-backed `EncryptedSharedPreferences` — the same backing store that react-native-keychain would use, so a future migration to SE-backed P-256 (see Phase-2 plan in `design.md §7.2`) stays straightforward.
- SecureStore values have a ~2 KB size cap per entry. Anything larger (e.g. `allLeaves` arrays in pending claims) is **split**: the secret lives in SecureStore, the oversized metadata lives in AsyncStorage.

### 2.2 Biometric gate (app-level, on top of OS unlock)

Wired through `expo-local-authentication`, centralised in `KeySecurityService`:

- `isBiometricAvailable()` — checks `hasHardwareAsync()` + `isEnrolledAsync()` so we fail gracefully on devices without Face ID / Touch ID / Android biometric.
- `isBiometricEnabled()` / `setBiometricEnabled()` — user-controlled toggle in Settings (`scatterdex_biometric_enabled` SecureStore key). When off, biometric gates no-op and transactions go through with only the OS unlock already having happened.
- `_biometricGate(reason)` — shared helper: returns `true` immediately if the toggle is off, otherwise prompts via `LocalAuthentication.authenticateAsync({ promptMessage: reason, fallbackLabel: 'Use passcode', disableDeviceFallback: false })`. Passcode fallback is kept so users without enrolled biometrics can still proceed.
- Gated operations: private-key reveal, mnemonic reveal, `getSigner*` paths, and `authorizeTransaction(description)` which is called from every write-path service (Order / Market / Cancel / Deposit / Claim / Stealth).

Biometric prompts are **always parameterised with a human-readable `reason`** so the OS sheet tells the user which operation they are approving (e.g. `Approve: Submit order`).

### 2.3 Storage schema by service

Every address-sensitive storage key is namespaced `<prefix>_<addr>` (lowercased) so two wallets on the same device cannot read each other's data. A one-shot migration copies pre-multi-wallet blobs into the per-address namespace **only when the caller matches the legacy owner** (verified against `scatterdex_wallet_address` SecureStore value written by the pre-multi-wallet `KeySecurityService`). If the first caller is not the legacy owner (e.g. a WalletConnect session on a different address), the blob is left in place and a later matching call claims it. See §5.

| Service | Keys | Security level |
|---|---|---|
| `KeySecurityService` | `scatterdex_wallets_index` (AsyncStorage JSON of `WalletMeta[]`), `scatterdex_wallets_active_id`, `scatterdex_wallet_secret_<id>` (SecureStore, biometric-gated), legacy mirror (`scatterdex_wallet_pk/_mnemonic/_address`) | SecureStore + biometric |
| `EdDSAKeyService` | `scatterdex_eddsa_<addr>` | SecureStore |
| `StealthIdentityService` | `scatterdex_stealth_identity_v1_<addr>`, `scatterdex_stealth_migrated_v2` | SecureStore, spending+viewing keys are the most sensitive blobs in the app |
| `PendingClaimsStorage` | `scatterdex_pending_claim_ids_<addr>` (Async), `scatterdex_pending_claim_meta_<addr>_<id>` (Async), `scatterdex_pending_claim_secret_<addr>_<id>` (SecureStore), v0/v1/v2 migration markers | Split: secret → SecureStore, metadata → AsyncStorage |
| `NoteStorageService` | `scatterdex_note_index_<addr>` (Async), `scatterdex_note_<addr>_<id>` (SecureStore — notes carry secret + salt) | SecureStore |
| `AddressBookService` | `scatterdex_wallet_book_v1_<addr>` (Async) | AsyncStorage (public labels + addresses) |
| `EscrowHiddenStorage` | `scatterdex_escrow_hidden_<addr>` (Async) | AsyncStorage |
| `NetworkService` | `scatterdex_networks_custom` (Async), `scatterdex_networks_selected` (Async) | AsyncStorage (public RPC config) |

---

## 3. Service inventory

All under `mobile/src/services/` unless noted. Count: **18 services + 1 context**.

### 3.1 Wallet + key-material

- **`KeySecurityService`** — multi-wallet storage layer. Owns the `wallets_index` / `wallets_active_id` / `wallet_secret_<id>` schema plus the biometric gate. Provides `listWallets / getActiveWalletId / setActiveWalletId / getActiveAddress / getSignerForWallet / createWallet / importFromMnemonic / importFromPrivateKey / deleteWallet` as well as legacy single-wallet compatibility getters (`getAddress / getPrivateKey / getSigner / getMnemonic / hasWallet`).
- **`WalletContext`** (`src/contexts/WalletContext.tsx`) — the only React entry point. Exposes `wallets / activeWalletId / connectionMode / account / signer / readProvider`, plus the `switchWallet / addWalletFromCreate / addWalletFromMnemonic / addWalletFromPrivateKey / removeWallet / refreshWallets / disconnect / connectBuiltin` methods. Also emits `notifyWalletSwitch(newAddr)` for per-address caches to resubscribe.
- **`EdDSAKeyService`** — derives and persists the BabyJub EdDSA key used for circuit signatures. Keyed per wallet address. `deriveKey` is stateless and derives from a `Signer`; `getOrDeriveKey` reads SecureStore or falls back to derive-and-save.
- **`StealthIdentityService`** — EIP-5564 style meta-address generation, stored per wallet address. Holds the spending + viewing keys (the most sensitive blobs in the app — anyone with both can drain every stealth address the meta-address will ever receive).

### 3.2 Storage / data

- **`NoteStorageService`** — per-wallet note index + per-note SecureStore blob. Notes carry `secret + salt`, so cross-wallet leakage would be a spend authorisation leak.
- **`PendingClaimsStorage`** — per-wallet pending-claim index, split storage (metadata in Async, secret in SecureStore), two-tier migration (v0 unencrypted blob → v1 split → v2 per-wallet namespace), concurrent-call latch.
- **`AddressBookService`** — labelled recipients per wallet, stored in AsyncStorage (non-sensitive). Supports both EOA and stealth meta-address entries.
- **`EscrowHiddenStorage`** — per-wallet list of escrow commitments the user has marked as hidden on the DepositScreen.
- **`BackupService`** — bundles SecureStore + AsyncStorage slices for export/restore. Export is encrypted with a user password (PBKDF2 → AES-GCM).

### 3.3 Transaction flows

- **`OrderService`** — private limit-order flow: builds the authorize proof, submits to a relayer, writes per-claim secrets to `PendingClaimsStorage.append` before marking the escrow note spent.
- **`MarketOrderService`** — market-mode flow: authorize proof + on-chain `settleWithDex` call. Sources every proof-verified field from public signals (`ps[]`) with hex-address conversion to avoid local-drift between what we signed and what we submit.
- **`CancelService`** — cancel an escrow note by publishing a cancel proof. Rotates the commitment.
- **`ClaimService`** — post-settlement claim path. Resolves the per-claim secret from `PendingClaimsStorage` and builds the claim proof.
- **`DepositService`** — deposit flow (wraps ETH if needed, generates commitment, deposits to the pool).

### 3.4 Infrastructure

- **`NetworkService`** — built-in + custom network registry. Custom network registration UI in Settings (name/RPC/chainId/symbol/explorer) calls `addCustomNetwork / removeCustomNetwork / testConnection`.
- **`TokenService`** — token list + on-chain `decimals()` lookup with Promise-based cache (dedupes concurrent callers). Cache is wiped on `ProviderService.subscribeReset` so a network switch cannot serve stale decimals.
- **`ConfigService`** — env-derived configuration (contract addresses, RPC endpoints, WETH address). Acts as the single surface over `NetworkService` so services do not re-read env vars.
- **`ProviderService`** — `ethers.JsonRpcProvider` pool keyed by RPC URL; publishes a reset event that downstream caches subscribe to (e.g. `TokenService.decimalsCache`).
- **`RelayerApiService`** — relayer discovery + capability polling + order submission HTTP client.

### 3.5 Offloaded ZK

- **`ZKBridgeService`** — the bridge between Hermes (React Native) and the hidden WebView that runs the ZK WASM engine. Exposes `waitReady(timeoutMs)` returning `ZKReadyStatus` (ready / failed / timeout) plus `deriveEdDSAKey / sign_eddsa / groth16_fullProve / verify` etc. All circuit provers (`authorize-prover / claim-prover / deposit-prover / cancel-prover`) call into this.

---

## 4. Multi-wallet architecture

### 4.1 Data model

```
SecureStore (device-bound, biometric-gateable):
  scatterdex_wallets_index        → JSON WalletMeta[]
  scatterdex_wallets_active_id    → active wallet id (uuid)
  scatterdex_wallet_secret_<id>   → JSON { privateKey, mnemonic? }
  scatterdex_biometric_enabled    → 'true' | 'false'

  -- legacy mirror (kept for rollback + for legacy-owner detection during
  -- per-address migrations in other services):
  scatterdex_wallet_pk / _mnemonic / _address
```

```ts
type WalletSource = 'mnemonic' | 'privateKey' | 'created';
interface WalletMeta {
  id: string;           // uuid
  address: string;      // checksummed 0x…
  nickname?: string;    // default 'Wallet N'
  source: WalletSource;
  createdAt: number;    // unix ms
}
interface WalletSecret { privateKey: string; mnemonic?: string; }
```

### 4.2 Invariants

1. **Checksum on the way in, lowercase on the way into storage keys.** `address` in `WalletMeta` is always checksummed (`ethers.getAddress`). Storage key suffixes use `address.toLowerCase()`. The helper `lib/address.ts → eqAddr(a, b)` centralises case-insensitive equality checks so every comparison goes through the same path.
2. **Single-mnemonic invariant.** A device that already manages a mnemonic cannot import a *different* mnemonic — `importFromMnemonic` derives subsequent accounts from the existing seed via BIP-44 paths and reports `reusedSeed: true`. Importing a different mnemonic rejects; the user has to delete every seed-backed wallet first.
3. **Legacy mirror reflects the active wallet.** Every `setActiveWalletId` / delete-with-promotion writes the active wallet's `{ pk, mnemonic?, address }` into the legacy `scatterdex_wallet_*` keys so per-address migration guards in other services keep working uniformly.
4. **Destructive no-arg guard.** `deleteWallet()` with no id and no active id refuses when `wallets_index` is non-empty (only wipes legacy keys otherwise). This prevents a corrupted `ACTIVE_WALLET_ID_KEY` from being interpreted as "wipe every wallet".

### 4.3 Wallet switch pipeline

```
User taps wallet row
  ├─ SettingsScreen.handleSwitchWallet(id)
  │    └─ guards: same id ? / walletLoading ? → bail
  ├─ WalletContext.switchWallet(id)
  │    ├─ KeySecurityService.setActiveWalletId(id)
  │    │    ├─ read meta + secret
  │    │    ├─ write ACTIVE_WALLET_ID_KEY
  │    │    └─ mirrorLegacyFromSecret(secret, meta.address)
  │    ├─ rehydrate React state (account, signer, wallets array)
  │    └─ notifySubscribers(newAddr)   ← `subscribeWalletSwitch` hook
  └─ Screens listening to the subscribe hook invalidate / refetch:
       NoteStorage, Stealth, AddressBook, PendingClaims, EscrowHidden,
       EdDSA-cache-in-React-state (Settings / History)
```

---

## 5. Per-address namespacing and legacy migration

Pattern shared by `NoteStorageService`, `PendingClaimsStorage`, `StealthIdentityService`, `AddressBookService`, `EscrowHiddenStorage`.

**Storage shape:**
- v2 (current): `<prefix>_<lowercased-addr>[_<id>]`
- v1 (legacy, pre-multi-wallet): `<prefix>[_<id>]` — one blob for the single built-in wallet
- Migration marker (AsyncStorage): `<prefix>_migrated_v2` — set **only** once a successful rekey (or "nothing to migrate") has run, so deferred cases retry.

**Migration algorithm (runs lazily on first access per install):**
1. If the marker is set → return.
2. If there is no v1 blob → set the marker (so subsequent calls short-circuit) and return.
3. Read `scatterdex_wallet_address` (legacy built-in owner written by pre-multi-wallet `KeySecurityService`).
4. If that address does not `eqAddr(legacyAddr, caller.address)` → leave the v1 blob alone and **do not set the marker**. A later call whose address matches the legacy owner will claim it.
5. Otherwise, rekey: copy the v1 payload into the v2 per-address namespace, set the marker **before** deleting v1 (crash-safety: a failure after the marker leaves a harmless orphan rather than re-running the migration), then best-effort delete the v1 blob.

The `NoteStorageService` variant parallelises the rekey in chunks (`REKEY_CONCURRENCY=32`) because SecureStore serialises under the hood and a large pre-upgrade note set would otherwise block the first user-facing call for seconds. A module-level promise latch prevents two concurrent first-calls from each walking the rekey loop.

---

## 6. Stealth address flow (EIP-5564)

Entirely on the recipient device; senders still use the on-chain stealth announcer contract.

1. **Identity** — `StealthIdentityService.generate(addr)` creates `{ spendingKey, viewingKey, metaAddress }` via BabyJub + secp256k1 derivations and stores all three in `scatterdex_stealth_identity_v1_<addr>` (SecureStore).
2. **Publication** — `metaAddress` is publishable. The Settings screen surfaces a Share sheet over it.
3. **Incoming claim** — a sender generates a one-time stealth address for our meta-address and posts a claim; `ClaimService` combines the stored spending key with the scan output to derive the per-stealth-address private key, builds a claim proof, and settles.
4. **Compromise mode** — `regenerate` replaces the keys. **Regeneration is destructive**: every stealth address derived from the old keys becomes unspendable from this device unless the old keys were backed up via Reveal Keys first. The UI emphasises this in a second confirmation.

Switch-safety: keys are per wallet address, so switching the active wallet points the stealth subsystem at a different meta-address transparently.

---

## 7. ZK hybrid architecture (confirmed)

No change from the design memo's plan, but the implementation has landed:

```
Hermes (RN)                        WebView (hidden)
  ethers 6                            snarkjs (Groth16 WASM)
  WalletConnect / built-in            circomlibjs (Poseidon)
  UI + state                          BabyJub EdDSA
      │                                   │
      └───── postMessage bridge ──────────┘
               (ZKBridgeService)
```

- **Bridge load**: the hidden `WebView` loads `zk-webview.html` (~4.6 MB) via `expo-asset` local-file URI (not inlined — inlined HTML of that size triggers OOM on Android).
- **Listener registration**: the WebView bridge registers message handlers on **both** `window` and `document`. Android's react-native-webview delivers to `document`; iOS to `window`. Registering only one leaves the bridge silently broken on the other platform.
- **Worker fallback** is in place; heavy circuits (authorize ~22K constraints) run single-threaded and the UI surfaces progress in-flight. Phase-2 follow-up: investigate real-Worker support or native `rapidsnark`.

---

## 8. Recent feature inventory (by shipped PR)

Non-exhaustive, focused on features the 2026-04-10 memo does not describe.

| Shipped | Feature | Details |
|---|---|---|
| #356 | Multi-wallet storage (Phase 1) | `KeySecurityService` schema + API |
| #357 | Shared `WalletMeta` type | `mobile/src/types/wallet.ts` |
| #360 | NoteStorage per-wallet namespace + subscribe hook | `notifyWalletSwitch` consumer path |
| #362 | WalletContext multi-wallet integration (Phase 2) | `switchWallet / addWalletFrom* / removeWallet`, accountsChanged wiring |
| #355/#358/#359 | Per-address namespacing for Stealth / PendingClaims+Backup / AddressBook (Phase 2.5) | Split secret/meta storage + BackupService scope fixes |
| #365/#368/#371/#376 | `eqAddr` helper rollout across mobile/frontend/backend | Case-insensitive address equality helper + call-site sweep |
| #361 | Custom network registration UI | Settings → Add Custom Network modal |
| #363 | Hidden Settings tab slot fix | `tabBarItemStyle: display:'none'` + `tabBarButton: () => null` |
| #366 | Phase 3 Settings multi-wallet UI | Wallet list, switch, delete, create, import, W1 auto-activation |
| #369/#370 | HomeScreen "all wallets" aggregation + wallet-switch subscribe wiring | Phase 4a |
| #372 | Deposit → Escrow tab rename | Plus icon + position swap |
| #373/#374 | Local-RPC preset + per-platform host resolution | Anvil fork preset |
| #375 | WalletConnect accountsChanged / chainChanged keep session | Avoids session churn on network switches |

---

## 9. Open questions (current)

| ID | Question | Status |
|---|---|---|
| OQ-1 | Real Worker thread inside the WebView for big circuits | Deferred — measure first, rapidsnark path is the backup |
| OQ-2 | Cloud sync / cross-device portability for notes | `BackupService` does local password-encrypted export; cloud sync is **out of scope** |
| OQ-3 | SE-backed P-256 master encrypting the BabyJub/EdDSA keys | Not shipped; plan is still the wrapping scheme in `design.md §7.2` |
| OQ-4 | HD-wallet UX: warn clearly when a second import would reject | Partially done (the `{ reusedSeed }` flag + UI copy). Revisit if users report confusion. |
| OQ-5 | App-store compliance (Apple crypto guidelines, Google Play gambling-adjacent rules) | Not yet submitted; pre-submission review pending |

---

## Appendix A — File-map (abridged)

```
mobile/
├── App.tsx
├── src/
│   ├── screens/
│   │   HomeScreen / TradeScreen / DepositScreen / ClaimScreen
│   │   HistoryScreen / SettingsScreen
│   ├── components/
│   │   ScreenHeader / BaseModal / BackupModal / AddressBookModal
│   │   SecretRevealModal / HiddenWebView / RelayerLogo / …
│   ├── contexts/
│   │   WalletContext.tsx
│   ├── services/          ← inventory in §3
│   ├── zk-engine/         ← per-circuit provers (authorize / claim / deposit / cancel)
│   ├── hooks/
│   │   useBalances / useClaimStatuses / useTerminateWorkerOnUnmount / …
│   ├── lib/
│   │   address.ts (eqAddr) / format.ts / error-messages.ts / stealth.ts
│   │   merkleTree.ts / proofFormat.ts / contracts.ts (ABIs)
│   ├── navigation/
│   │   TabNavigator.tsx (hidden Settings slot)
│   ├── shims/
│   │   polyfills loaded before the bridge
│   └── types/
│       wallet.ts (WalletMeta / WalletSource / WalletSecret)
└── scripts/
    build-zk-webview.mjs  ← ZK engine bundler
```

## Appendix B — Security rules-of-thumb for contributors

- **Never `JSON.stringify` a `WalletSecret` into AsyncStorage** — secrets only go to SecureStore. `PendingClaimsStorage` is the canonical example of the split pattern.
- **Never compare addresses with `===`** — use `eqAddr(a, b)` from `lib/address.ts`. Lower-casing both sides inline is the same footgun that `eqAddr` exists to prevent.
- **Every biometric prompt gets a human `reason`** — the OS sheet is a last line of defence; a "Authenticate" prompt with no context trains users to tap through.
- **Per-address namespace every piece of user data** — add new storage in `<prefix>_<addr>` form, and write the migration guard (§5 pattern) if there is legacy data to pick up.
- **Subscribe to `notifyWalletSwitch` for any in-memory cache keyed on `account`** — otherwise the cache serves the previous wallet's data for a render after switch.
