# Scatter Pro

Private limit orders for serious traders.
MEV-free, balance-private, regulator-ready.

## Target

Semi-pro / OTC traders, $20K–$1M positions, 5–30 trades/month.
Today they juggle Uniswap, 1inch, CowSwap, and Hyperliquid. They
want better fills than AMMs without the regulatory taint of mixers.

## Scope

This is the **production Pro app**, not a demo. Real ZK proofs,
real on-chain dispatch, real persistent state — all consumed
through `@zkscatter/sdk`. The current state is the segment-targeted
UX shell on top of the SDK skeleton; the launch-blocker checklist
lives in `docs/product/PRO_REPOSITION.md` §7–§8.

**Routes shipped:**
- `/` — landing with persona / how-it-works / vs-Uniswap pitch
- `/app` — workbench (vault + order form + orderbook in one screen)
- `/orders` — order history (matched / pending / settled)

**Routes / surfaces planned (launch-blockers):**
- `/inbox` — stealth-receive scan + claim
- `/settings` — network, RPC, default relayer, expiry, theme
- `WithdrawModal`, `CancelOrderModal`
- Pair selector + network switcher in workbench header
- Order detail drawer + receipt
- Toast notifications + status badges + unified pre-sign preview

`frontend/` is the reference implementation we migrate from.

## Run

```bash
npm install
npm run dev   # http://localhost:3003
```

## Domain (planned)

`pro.zkscatter.xyz`

## Pricing (planned)

- 0.05% per trade (relayer fee included)
- 0.03% for monthly volume ≥ $1M
- White-label available for OTC desks

## Differentiators vs Uniswap / CowSwap / Hyperliquid

- Wallet balance not exposed after a trade (private vault)
- Provable MEV-free (limit-order matching, not AMM)
- Regulator-ready (Dual-CA, zk-X509 — not a mixer)
- Same balance accessible from web Pro and mobile companion
