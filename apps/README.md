# apps/

Persona-specific frontends built on the shared zkScatter core
(contracts + ZK engine + relayer network + shared orderbook).

| App | Target | Status | Port |
| --- | --- | --- | --- |
| [`pro/`](./pro) | Semi-pro / OTC traders — private limit orders | scaffold | 4003 |
| [`pay/`](./pay) | Small companies & DAOs — payroll & vendor payouts | scaffold | 4001 |
| [`drop/`](./drop) | Token launch teams — sybil-resistant private airdrops | scaffold | 4002 |
| [`operators/`](./operators) | Relayer operators — register, monitor, withdraw | scaffold | 4004 |

`pro/` is a fresh light-theme reimagining of the trader experience.
The existing dark `frontend/` and the `mobile/` consumer wallet stay
at the repo root for now. They will be reconciled with `apps/pro/`
and moved under `apps/` once these scaffolds stabilize.

## Why split?

One core, four personas:

- **Pro** — semi-pro traders. MEV-free private limit orders.
- **Pay** — finance ops at small crypto-native companies. Private bulk payouts.
- **Drop** — projects shipping a token. Anti-sybil + private airdrops.
- **Operators** — relayer operators. Console for register, profile, dashboard, treasury, leaderboard.

Each frontend gets its own domain, copy, pricing, and growth channel.
They share the underlying contracts and `packages/sdk` + `packages/ui`.

## Run

```bash
cd apps/pro       && npm install && npm run dev   # http://localhost:4003
cd apps/pay       && npm install && npm run dev   # http://localhost:4001
cd apps/drop      && npm install && npm run dev   # http://localhost:4002
cd apps/operators && npm install && npm run dev   # http://localhost:4004
```

Each app is currently a clickable wireframe with mock data — no chain
or relayer calls yet. The goal of this scaffold is to validate IA,
flow, and copy with stakeholders before wiring the SDK.
