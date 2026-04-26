# apps/

Persona-specific frontends built on the shared ScatterDEX core
(contracts + ZK engine + relayer network + shared orderbook).

| App | Target | Status | Port |
| --- | --- | --- | --- |
| [`pro/`](./pro) | Semi-pro / OTC traders — private limit orders | scaffold | 3003 |
| [`pay/`](./pay) | Small companies & DAOs — payroll & vendor payouts | scaffold | 3001 |
| [`drop/`](./drop) | Token launch teams — sybil-resistant private airdrops | scaffold | 3002 |

`pro/` is a fresh light-theme reimagining of the trader experience.
The existing dark `frontend/` and the `mobile/` consumer wallet stay
at the repo root for now. They will be reconciled with `apps/pro/`
and moved under `apps/` once these scaffolds stabilize.

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
cd apps/pro  && npm install && npm run dev   # http://localhost:3003
cd apps/pay  && npm install && npm run dev   # http://localhost:3001
cd apps/drop && npm install && npm run dev   # http://localhost:3002
```

Each app is currently a clickable wireframe with mock data — no chain
or relayer calls yet. The goal of this scaffold is to validate IA,
flow, and copy with stakeholders before wiring the SDK.
