# Frontend Feature Inventory (`frontend/`)

Snapshot taken 2026-04-26 to inform the multi-frontend split. This is
raw catalog — see `../PRO_REPOSITION.md` for what to do with it.

## Stack

- **Framework**: Next.js 16.2.1 with React 19.2.4, TypeScript 5
- **Styling**: Tailwind CSS 4 with Material 3 design tokens
- **Icons**: lucide-react 1.7.0
- **Crypto / ZK**: ethers 6.16.0, snarkjs 0.7.6, circomlibjs 0.1.7,
  @noble/curves 2.0.1, @noble/hashes 2.0.1
- **State**: React Context/Hooks (no Redux/Zustand)
- **Storage**: Browser File System Access API for local Vault, plus
  localStorage caching

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Landing — privacy trilemma framing, "Start Secret Trade" CTA |
| `/trade/private-escrow` | Deposit & manage private ZK commitments. Vault folder, wrap/approve, deposit proofs, leafIndex tracking |
| `/trade/private-order` | Create limit orders from escrow commitments. EdDSA signing, ~30s proof gen |
| `/trade/dex-trade` | Market swap via DEX aggregator. Non-private fallback |
| `/trade/orderbook` | Cross-relayer shared orderbook browse & take |
| `/trade/private-claim` | Withdraw via ZK proof. Gasless (relayer) or wallet-paid. Multi-claim batch |
| `/trade/private-history` | Per-user order list + cancel + on-chain refresh |
| `/trade/settlements` | Read-only settlement ledger (P2P + DEX) |
| `/identity` | Dual-CA identity verification status |
| `/relayer` | Relayer discovery & dashboard |
| `/relayer/leaderboard` | Relayer stats / rankings |
| `/relayer/register` | Relayer registration |
| `/relayer/profile` | Relayer detail |
| `/relayer/ops` | Relayer operations / management |
| `/relayer/treasury` | Relayer fee vault & bond tracking |
| `/wallets` | Wallet connection modes & accounts |
| `/faucet` | Testnet token faucet |
| `/faq` | FAQ |

## Core features

### Trading
- Limit orders (off-chain signing, on-chain matching via relayer)
- Market swaps (DEX aggregator, Uniswap v2/v3)
- Shared orderbook (cross-relayer; relayer publishes summaries
  without exposing wallet addresses)
- Order cancellation (rotate escrow to fresh commitment)
- No AMM; fixed-price limit orders eliminate MEV

### Privacy / ZK
- Deposits: Poseidon commitment + 16-leaf merkle, ~1–5s proof gen,
  ~$0.01 L2 cost
- Transfers: EdDSA-signed orders, nullifier double-spend protection
- Withdrawals (claims): one ZK proof per recipient, gasless or
  self-funded, batch up to 20 claims/tx
- Change notes auto-tracked as pending → resolved post-settlement
- Stealth addresses (optional per claim)

### Wallet
- MetaMask + EIP-1193
- EIP-5792 atomic batch (wrap / approve / deposit) with sequential
  fallback
- EdDSA trading key — AES-GCM encrypted in Vault, derived from
  wallet signature
- Account isolation on wallet switch
- **No recovery mechanism** — Vault loss = funds lost

### Activity / History
- Private History: order list + change notes + on-chain refresh
- Settlements: P2P + DEX audit log
- On-chain state sync via nullifiers + claim completion + leafIndex

### Settings
- Network config via `NEXT_PUBLIC_*` env vars
- Token list from env (native + ERC-20 with decimals)
- Configurable explorer URL
- Vault folder = browser file picker (File System Access API)

### Identity
- zk-X509 one-time user verification (private)
- Dual-CA: users private, relayers public registry

## UX patterns

- **Onboarding**: hero → "Start Secret Trade" → `/trade/private-escrow`
  → Vault folder picker → first EdDSA key derivation
- **Empty states**: "No private deposits yet", "No online relayers",
  "Waiting for Settlement"
- **Errors**: friendly messages, EIP-5792 graceful fallback, RPC
  retry on transient errors
- **Theming**: dark mode only, Material 3 color system,
  glass-morphism cards
- **Proof status**: spinner + ETA for ~30s order proofs, "Proof X
  of Y (batch Z/N)" for multi-claim

## Power users vs newcomers

**Power user surfaces**:
- Relayer ops dashboard, leaderboard, treasury
- Batch claim (up to 20 / tx)
- Cross-relayer order matching with relayer pick
- Scatter mode (direct distribution, no matching)
- Stealth address claims
- Manual leafIndex / merkle inspection

**Newcomer-friendly bits**:
- "Start Secret Trade" CTA on landing
- Single-click escrow deposit
- Single-recipient default in order form
- Gasless claim path

**Density**: high. Heavy ZK terminology, advanced fee/expiry
controls, manual JSON upload for some flows. Targets users already
familiar with ZK / DEX concepts.

## Unfinished / edge

- Market order claims separate from relayer P2P claims
- Shared orderbook gated on `NEXT_PUBLIC_SHARED_ORDERBOOK_URL` env
- Stealth address has two claim modes (client-side or relayer)
- `/relayer/register` and `/relayer/ops` skeleton pages
- Vault folder requires Chrome / Edge — no fallback for mobile or
  Firefox

## Key file references

- `app/page.tsx` — landing
- `app/trade/private-escrow/page.tsx` — 1072 lines
- `app/trade/private-order/page.tsx` — 1316 lines
- `app/trade/private-claim/page.tsx` — 797 lines
- `app/lib/wallet.ts` — `useWallet()` hook
- `app/lib/zk/commitment.ts`, `eddsa.ts`, `note-storage.ts`
- `app/lib/zk/{deposit,authorize,claim}-worker-client.ts` — Web
  Workers for proof gen
- `app/lib/config.ts`, `app/lib/contracts.ts`
