# Mobile Feature Inventory (`mobile/`)

Snapshot taken 2026-04-26 to inform the multi-frontend split.

## Stack

- **Framework**: Expo ~54.0.33 (React Native 0.81.5), React 19.1.0
- **Navigation**: React Navigation v7 (bottom tabs + stack)
- **Wallet**: WalletConnect v2 + built-in mnemonic
- **ZK proving**: WebView bridge to snarkjs + circomlibjs (hidden
  off-screen WebView)
- **Storage**: expo-secure-store (Keychain/Keystore), expo-sqlite,
  AsyncStorage
- **Build**: Expo managed
- **Platforms**: iOS (Face ID), Android (adaptive icons), Web build
  exists but secondary

## Screens & navigation

Bottom-tab navigator (5 visible + 1 hidden):

1. **Home** — primary entry, balance overview, wallet switcher
2. **Deposit (Escrow)** — private deposits + commitment escrow list
3. **Trade** — limit & market orders
4. **Claim** — release encrypted funds (standard & stealth)
5. **History (Activity)** — pending/confirmed trades, deposits, claims
6. **Settings** (hidden, accessed from Home nav)

App boot:
- ZK engine loads via HiddenWebView (30s timeout)
- WalletProvider gates UI until ZK bridge ready
- LockedScreen overlays after 30s background inactivity (built-in
  wallets only)
- HomeScreen doubles as splash + onboarding gate

## Core features

### Trading
- **Limit orders** (relayer-matched, 1h default lock on claims)
- **Market orders** (Uniswap V3 / aggregator)
- **Scatter mode** (same-token distribution, no swap)
- Configurable release delay (minutes / hours / days)
- Max 10 claim rows per order (UX cap; circuit allows 16)
- Files: `screens/TradeScreen.tsx`, `services/OrderService.ts`,
  `services/MarketOrderService.ts`

### Privacy / ZK
- Deposit, transfer, withdraw, claim (parity with web)
- Stealth-address claim
- Files: `screens/DepositScreen.tsx`, `screens/ClaimScreen.tsx`,
  `services/{Deposit,Claim,ZKBridge}Service.ts`

### Wallet
- **Built-in**: BIP-39 + BIP-44 multi-account
  - Biometric-gated SecureStore (Face ID / fingerprint)
  - 30s background auto-lock
  - Multi-wallet (add / switch / delete)
- **WalletConnect**: external sessions (MetaMask etc.), single account
- **Mnemonic backup verification** enforced on first wallet creation
  (PR #408)
- Files: `contexts/WalletContext.tsx`, `services/KeySecurityService.ts`,
  `components/MnemonicVerifyModal.tsx`

### Activity / History
- Tabs: Active escrow / Spent / Pending orders
- Per-note status tracking (Active → Pending → Spent / Cancelled)
- Order status (Matching → Matched → Settled / Cancelled)
- Persisted locally (TradeHistoryStorage) + on-chain event scan
- Files: `screens/HistoryScreen.tsx`,
  `services/{TradeHistoryStorage,PendingOrders,PendingClaimsStorage}.ts`

### Settings
- 6 network presets (Thanos Sepolia / Mainnet / Ethereum / Sepolia /
  Localhost / Anvil) + custom networks (with RPC reachability test)
- Token list (ETH + WETH auto, extras per chain)
- Biometric toggle
- Address book
- EdDSA key view / export
- Stealth identity (spending / viewing keys per wallet)
- Backup / restore (seed export)

### Diagnostics
- ZK boot spinner (30s timeout, retry on failure)
- Per-step logs (deriving key → proof gen → submit → save)
- Network test in custom-network modal
- Dev-only HiddenWebView debug JS in __DEV__
- Global ErrorBoundary + per-screen error states

## WebView vs native

**WebView-bridged (ZK only)**:
- snarkjs + circomlibjs inlined into single bundled HTML asset
- file:// URI navigation locked to bundled path
- `allowFileAccessFromFileURLs` disabled
- Promise-based request/response over JS injection + postMessage
- Init timeout 30s; per-proof varies (deposit ~10–20s, authorize <5s)

**Native everything else**:
- UI (balance cards, forms, tabs)
- Wallet key management via SecureStore
- Network requests via ethers
- Storage (SQLite, AsyncStorage, SecureStore)
- Biometrics via expo-local-authentication

## Mobile-specific UX

- Biometric unlock with one-tap re-unlock from LockedScreen
- Keychain `WHEN_UNLOCKED_THIS_DEVICE_ONLY` policy
- Pull-to-refresh on Home + Deposit
- Portrait-only
- Safe-area aware
- App scheme `scatterdex://` declared (no deep-link handling yet)
- No haptics, share sheet, or push notifications yet

## Onboarding flow

1. App boot (2–3s) — HiddenWebView + snarkjs init (30s spinner)
2. HomeScreen rendered — if no wallet, show "Connect Wallet" card
3. Modal choice: Create new / Import / WalletConnect
4. Create path → BIP-39 generation → MnemonicVerifyModal (mandatory)
5. First deposit → DepositScreen → token + amount → proof + commit
6. First trade → TradeScreen → choose escrow note → claims → submit
   → relayer match → claim after lock

No dedicated splash or onboarding walkthrough — HomeScreen carries
both jobs.

## Polish vs PoC

**Polished**:
- Tabs, balance cards, multi-wallet UX
- Error boundaries + friendly messages
- Biometric integration + 30s lock cycle + LockedScreen
- ZK boot spinner + retry
- Accessibility (screen reader guards, importantForAccessibility)
- Consistent theme tokens, shadows, padding

**PoC / in-progress**:
- EdDSA key export / reveal modals (diagnostic feel)
- Custom network RPC tester (functional, minimal UX)
- Stealth identity UI (settable but warns when wallet not connected)
- 1inch market order path (newer, less tested than Uniswap V3 path)
- Pending claims clock (ticks only on-screen, not in background)
- Deep-link scheme declared but unused

## Stats

| Metric | Count |
| --- | --- |
| Screens (visible) | 5 + 1 hidden |
| Services | 20 |
| Built-in networks | 6 |
| Order types | 2 (limit + market) |
| Wallet modes | 2 (built-in + WalletConnect) |
| Max claims/order | 10 |
| Background lock timeout | 30s |
| ZK init timeout | 30s |

## Key file references

- `App.tsx` — ZK boot orchestration
- `src/contexts/WalletContext.tsx` — wallet state + multi-account
- `src/screens/*.tsx` — 6 screens (all core flows)
- `src/services/*.ts` — 20 service modules
- `src/components/HiddenWebView.tsx`, `MnemonicVerifyModal.tsx`,
  `ErrorBoundary.tsx`
- `src/lib/` — crypto, merkle trees, DEX aggregation, proof
  formatting, stealth math
- `src/zk-engine/` — circuit assets & loader
