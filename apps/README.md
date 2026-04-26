# apps/

Persona-specific frontends built on the shared ScatterDEX core
(contracts + ZK engine + relayer network + shared orderbook).

| App | Target | Status | Port |
| --- | --- | --- | --- |
| [`pay/`](./pay) | Small companies & DAOs — payroll & vendor payouts | scaffold | 3001 |
| [`drop/`](./drop) | Token launch teams — sybil-resistant private airdrops | scaffold | 3002 |

The existing `frontend/` (Pro — traders) and `mobile/` (consumer wallet)
remain at the repo root for now. They will move under `apps/` in a later
workspace pass once these two new apps stabilize.

## Why split?

One core, three personas:

- **Pro** — semi-pro traders. MEV-free private limit orders.
- **Pay** — finance ops at small crypto-native companies. Private bulk payouts.
- **Drop** — projects shipping a token. Anti-sybil + private airdrops.

Each frontend gets its own domain, copy, pricing, and growth channel.
They share the underlying contracts and (eventually) `packages/sdk` +
`packages/ui`, which will be extracted in a follow-up.

## Run

```bash
cd apps/pay  && npm install && npm run dev   # http://localhost:3001
cd apps/drop && npm install && npm run dev   # http://localhost:3002
```

Each app is currently a clickable wireframe with mock data — no chain
or relayer calls yet. The goal of this scaffold is to validate IA,
flow, and copy with stakeholders before wiring the SDK.
