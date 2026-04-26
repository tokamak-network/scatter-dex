# Pro Reposition

The existing `frontend/` is a feature-complete ZK DEX console. Its
gap is **positioning**, not capability. This doc captures the
reposition plan.

## Current state (from inventory)

- 12 top-level routes — equally weighted in nav
- Landing page leads with "Privacy Trilemma" (educates ZK insiders,
  loses everyone else)
- Vocabulary in UI: leafIndex, EdDSA, nullifier, scatter mode,
  claim JSON
- Vault folder = single point of failure (no backup mechanism)
- Dark mode only — codes "underground" instead of the
  regulator-friendly fintech look we want (see `BRAND_DIRECTION.md`)

See `inventory/FRONTEND_FEATURES.md` for the raw catalog.

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

## Out of scope for this reposition

- Liquidity pools (we're not an AMM, never will be)
- Limit-order books for non-ZK assets (mission drift)
- Telegram bot trading (interesting but post-PMF)

## Sequence

1. Landing copy + hero rewrite (1 day, no engineering blocker)
2. **Light theme conversion + trust signals** (2 days — swap tokens
   per `BRAND_DIRECTION.md`, add zk-X509 badge + footer)
3. Route consolidation: build `/app` workbench (1 week)
4. vs-Uniswap quote integration (3 days, needs Uniswap SOR call)
5. Vocabulary swap pass (2 days, mostly find-and-replace + review)
6. Vault cloud backup (1 week, careful crypto + UX)
7. Mobile Quick Sign pairing (parallel mobile work, 1 week)

Total: ~3 weeks if 1 person, 1.5 weeks with mobile parallel.

## Success metrics (90-day)

- Time to first trade for new user: < 8 minutes
- Returning users WoW: +15%
- Median position size: ≥ $30K (proves we're hitting P1, not retail)
- "vs Uniswap" tooltip click rate: ≥ 30% (proxy for the metric being
  read)
