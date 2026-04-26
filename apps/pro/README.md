# ScatterDEX Pro

Private limit orders for serious traders.
MEV-free, balance-private, regulator-ready.

## Target

Semi-pro / OTC traders, $20K–$1M positions, 5–30 trades/month.
Today they juggle Uniswap, 1inch, CowSwap, and Hyperliquid. They
want better fills than AMMs without the regulatory taint of mixers.

## MVP scope (this scaffold)

- `/` — landing with persona / how-it-works / vs-Uniswap pitch
- `/app` — workbench (vault + order form + orderbook in one screen)
- `/orders` — order history (matched / pending / settled)

All routes use mock data. No SDK calls yet.

## Run

```bash
npm install
npm run dev   # http://localhost:3003
```

## Domain (planned)

`pro.scatterdex.xyz`

## Pricing (planned)

- 0.05% per trade (relayer fee included)
- 0.03% for monthly volume ≥ $1M
- White-label available for OTC desks

## Differentiators vs Uniswap / CowSwap / Hyperliquid

- Wallet balance not exposed after a trade (private vault)
- Provable MEV-free (limit-order matching, not AMM)
- Regulator-ready (Dual-CA, zk-X509 — not a mixer)
- Same balance accessible from web Pro and mobile companion
