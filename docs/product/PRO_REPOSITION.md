# Pro Reposition

`apps/pro/` is the **shipping Pro product** — a production-grade,
segment-targeted ZK trading workbench for semi-pro / OTC traders.

The existing `frontend/` is a **feature-complete reference
implementation** whose real ZK + on-chain logic gets migrated into
`@zkscatter/sdk` so all three apps (`apps/pro`, `pay`, `drop`)
consume the same proven core. Once `apps/pro` reaches feature
parity (real provers, real dispatch, persistent vault, withdraw,
cancel), `frontend/` is archived.

This doc captures the reposition plan AND the production gap list.

## Reference state (from `frontend/` inventory)

- 12 top-level routes — equally weighted in nav
- Landing page leads with "Privacy Trilemma" (educates ZK insiders,
  loses everyone else)
- Vocabulary in UI: leafIndex, EdDSA, nullifier, scatter mode,
  claim JSON
- Vault folder = single point of failure (no backup mechanism)
- Dark mode only — codes "underground" instead of the
  regulator-friendly fintech look we want (see `BRAND_DIRECTION.md`)

See `inventory/FRONTEND_FEATURES.md` for the raw catalog of what
the reference implementation already does (used as the migration
checklist when porting real logic into SDK + apps/pro).

## Target after reposition

- One persona: P1 "Jihwan" (semi-pro / OTC trader, $20K–$1M
  positions)
- Landing page leads with: **"큰 거래를 조용히. 프론트런 없이, 잔고
  노출 없이, 합법적으로."** (EN: "Big trades, quietly. No
  front-running, no balance exposure, fully legal.")
- Primary route: `/app` — single-page workbench (vault + order +
  orderbook)
- Relayer ops moved out of main nav into footer link
- vs-Uniswap comparison metric visible at all times in the order
  form (this is the conversion trigger)

## Concrete changes

### 1. Route consolidation

| Today | After |
| --- | --- |
| `/trade/private-escrow` | merged into `/app` (left panel) |
| `/trade/private-order` | merged into `/app` (center panel) |
| `/trade/orderbook` | merged into `/app` (right panel) |
| `/trade/private-claim` | promoted as toast/modal on `/app` |
| `/trade/private-history` | `/orders` |
| `/trade/settlements` | kept, but de-emphasized in nav |
| `/trade/dex-trade` | dropped from main nav (advanced sub-page) |
| `/relayer/*` | moved to footer link "For relayer operators" |
| `/identity` | reduced to a header badge ("zk-X509 ✓") |

### 2. Vocabulary swap

| Old (UI surface) | New |
| --- | --- |
| Escrow | "Vault balance" |
| leafIndex | hidden (internal only) |
| Note #5 | "Lot 5" or just hide |
| Claim JSON | "Receipt" (auto-handled) |
| Scatter mode | "Multi-recipient" toggle |
| Stealth address | "Private receive" toggle |
| EdDSA key | "Trading key" (auto-derived, hidden) |
| Nullifier | hidden |

### 3. New comparison metric (the conversion trigger)

In the order form, always show:

```
Estimated fill: $4,205.30 / ETH
vs Uniswap:     $4,176.10 / ETH   ← −0.7% slippage saved
```

Uniswap quote = real-time call to Uniswap v3 SOR with same input
size. This single metric does more for conversion than any landing
copy.

### 4. Vault backup options

Today: Vault folder lost = funds lost. Add:

- Encrypted iCloud / Google Drive backup (opt-in, password-encrypted,
  client-side only)
- "Print recovery sheet" — QR + 12-word recovery for cold storage
- Recovery flow on first login from new device

This single change is the difference between "ZK power user only"
and "I can recommend this to my trader friends."

### 5. Light theme + compliance-bright look

Switch the default theme from dark Material 3 to the light token
palette defined in `BRAND_DIRECTION.md` (off-white background, blue
primary, Inter typography, Lucide outline icons).

Why this matters for Pro specifically: the trader persona (P1) needs
to feel safe recommending the product to peers. Dark + neon codes
"sanctions risk"; light + clean codes "fintech tool."

Dark mode can stay as a user-toggled option, but the landing page
and first-run experience must be light.

### 6. Mobile pairing — Quick Sign

Add a paired-device flow:
1. On `/app`, prepare order → click "Sign on mobile"
2. QR code shown (encodes order hash + relay channel)
3. Mobile app scans → biometric → signs
4. Web shows "Signed by mobile · submitting"

This is the demo that earns press for the multi-frontend strategy.

### 7. Production UX essentials (gap list vs `frontend/` parity)

These are the user-facing capabilities `frontend/` already covers
that `apps/pro` must absorb before launch. Tracked as
launch-blockers.

**Critical (cannot launch without):**

| # | Capability | Today in apps/pro | Needed |
| --- | --- | --- | --- |
| 1 | Withdraw funds from vault | ❌ no modal | `WithdrawModal` — pick note, choose destination (same wallet / stealth / arbitrary), ZK proof, dispatch |
| 2 | Cancel open order | ❌ missing | `CancelOrderModal` — sign cancel, post nonce nullifier; Cancel button on each Open Order row |
| 3 | Pair selector | ❌ ETH/USDC hardcoded | Searchable pair switcher in workbench header, recent + favorite pairs |
| 4 | Network switcher | ❌ DEMO_NETWORK fixed | Header network pill, supports L2 testnet + L2 mainnet, custom RPC override in Settings |
| 5 | Order detail / receipt | ❌ no detail view | Click an order row → side drawer with tx links, fill price, claim status, raw signed payload |
| 6 | Stealth-receive inbox | ❌ no view | New `/inbox` page — scan progress, received notes, claim CTA |
| 7 | Empty / error states with next-step CTAs | ⚠️ partial | Every empty state has a primary action; every error states what to retry |

**High (needed for trader trust):**

- Vault note consolidate / split
- Quick-fill buttons (25/50/75/Max) on order form
- Click on orderbook row → autofill price + size
- Unified pre-sign preview (fee + slippage + gas in real numbers)
  shared across Deposit / Order / Claim / Withdraw / Cancel
- Toast notification system (filled / claim ready / failed → retry)
- Status badges + progress bar (Pending → Matching → Filled →
  Claimed) on every order card
- `/settings` page (RPC, default relayer, default expiry, auto-lock,
  data export)
- Help drawer with glossary + short videos

**Mid (long-term trust):**

- Activity feed (chronological all-events)
- Tax-friendly CSV / JSON export
- KISA identity gate entry (compliance gate)
- Multi-wallet switcher
- Keyboard shortcuts (B/S, Esc, Enter)
- Mobile responsive (current `grid-cols-12` doesn't break down)

### 8. Workbench left column — "My Position" panel

Current left column shows raw notes only. Replace with:

```
┌─────────────────────────┐
│ Total private balance   │
│ $12,840.50  [+ Deposit] │
├─────────────────────────┤
│ Open orders         [3] │
│ • ord-7  buy  …  Cancel │
│ • ord-9  sell …  Cancel │
├─────────────────────────┤
│ Ready to claim      [2] │
│ • $4,200  Claim all →   │
├─────────────────────────┤
│ Notes               [4] │
│ ETH 1.2  USDC 4,200 …   │
│            Withdraw →   │
└─────────────────────────┘
```

Why: a Pro trader's first glance must answer "where is my money?
what's open? what can I claim?" — not "list of internal note
records."

## Out of scope for this reposition

- Liquidity pools (we're not an AMM, never will be)
- Limit-order books for non-ZK assets (mission drift)
- Telegram bot trading (interesting but post-PMF)

## Sequence

**Done (apps/pro foundation, Phases 0–5c):**
- ✅ Light theme + trust signals (BRAND_DIRECTION tokens applied)
- ✅ `/app` workbench layout (vault + order form + orderbook)
- ✅ `/orders` history page
- ✅ Wallet connect, EdDSA derivation, vault context
- ✅ DepositModal / OrderModal / ClaimModal scaffolds (mock prover)
- ✅ Relayer registry pill, shared orderbook hook

**Up next (Pro production push):**

1. **UX essentials wave** (this PR set):
   - Workbench "My Position" panel + status badges + toast system
   - WithdrawModal + CancelOrderModal
   - Orderbook click-to-fill + quick-fill buttons
   - Unified pre-sign preview component
2. **Pair + network switcher** (1 week)
3. **Order detail drawer** + receipt view (3 days)
4. **Stealth inbox `/inbox`** (1 week)
5. **`/settings` page** (3 days)
6. **vs-Uniswap quote integration** (3 days, needs Uniswap SOR call)
7. **Vocabulary swap pass** (2 days, find-and-replace + review)
8. **Vault cloud backup** (1 week, careful crypto + UX)
9. **Mobile Quick Sign pairing** (parallel mobile work, 1 week)

**SDK migration (parallel track, see `SHARED_FOUNDATION.md`):**
- Real ZK workers from `frontend/app/lib/zk/*` → `@zkscatter/sdk/zk`
- Note storage adapter (IndexedDB browser) → SDK
- Incremental Merkle tree → SDK
- Real on-chain dispatch wiring (already partial via `src/contracts/`)

When the SDK migration lands, every UX component above starts
producing real proofs and real transactions without UI changes.

## Success metrics (90-day)

- Time to first trade for new user: < 8 minutes
- Returning users WoW: +15%
- Median position size: ≥ $30K (proves we're hitting P1, not retail)
- "vs Uniswap" tooltip click rate: ≥ 30% (proxy for the metric being
  read)
