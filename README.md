# zkScatter

**A privacy-preserving settlement protocol with compliant identity gating.** One
ZK stack powers private **OTC trading** (Pro) and **bulk payouts** (Pay).
Settlement happens on-chain via Groth16 proofs over commitment pools, with
relayers coordinating off-chain (matching orders for Pro, batching payouts for
Pay) and relaying claims gaslessly — so identities and claim structure stay hidden
on-chain, while zk-X509 identity gating keeps the protocol regulatory-compliant.

---

## 📖 Read the series first (Medium)

New here? Read the Medium series for the *why* and the *how*, then dive into the
code below. Each piece stands on its own.

1. **Product Introduction** — the problem → Pay & Pro → what's hidden and what's shown
   · Read in [English](https://medium.com/@zena_tokamak/8c074a5bfeb6) · [한국어](https://medium.com/@zena_tokamak/fc0bd3d6037a)
2. **Economics & Investors** — why build another, how it sustains itself without a token
   · Read in [English](https://medium.com/@zena_tokamak/8682fb64978b) · [한국어](https://medium.com/@zena_tokamak/5acd65c2df63)
3. **Developers** — under the hood: how ZK notes, half-proofs, and relayers fit together
   · Read in [English](https://medium.com/@zena_tokamak/1959a62ae0ff) · [한국어](https://medium.com/@zena_tokamak/56fba35dd63c)
4. **Protocol Internals** (deep-dive) — how commitments, nullifiers, circuits, and settlement fit together
   · Read in [English](https://medium.com/@zena_tokamak/94466fcdc9be) · [한국어](https://medium.com/@zena_tokamak/7fab0f806aa0)
   · *Companion:* **zk-X509** — bringing billions of existing IDs on-chain, with zero personal data (the identity gate)

All pieces on **[@zena_tokamak](https://medium.com/@zena_tokamak)**.

---

## The apps — why you'd use each

| App | Why you'd use it | Status |
|-----|------------------|--------|
| **Pay** | Send payroll / grants / bonuses to many people in **one signature**, without publishing who got how much. Recipients claim **gaslessly** and can't see each other's amounts. | wireframe |
| **Pro** | Place a **private limit order** — **no MEV**, no desk spread, no balance leak. Matched off-chain, settled on-chain, proceeds claimed gaslessly. | live |
| **Operators** | **Run a relayer** and earn deterministic on-chain fees settling private order flow. Permissionless bond, no vendor lock-in, can't see order amounts/sides. | live |
| **Admin** | Govern the deployment — CA issuance, sanctions, protocol params, treasury (internal console). | live |

> 📘 **Full user guide → [docs/user-guide.md](docs/user-guide.md)** — what each app is
> for, the benefits, and step-by-step **how to use it**, all in one place.

---

## Try it on Sepolia (no build — just a wallet)

The fastest way to see it working. You run the frontends locally against the
**shared Sepolia deployment**, so the whole team hits the same contracts,
relayer, and orderbook. Every address comes from the committed ledger
(`contracts/deployments/11155111.json`) — **you configure nothing**. All you need
is **MetaMask on Sepolia with a little test ETH**.

```bash
./scripts/run-scatter-web.sh <app> sepolia   # app = hub | pay | pro | operators | admin
```

| app       | dev URL                 | what it is                        |
|-----------|-------------------------|-----------------------------------|
| pay       | http://localhost:4001   | private bulk payouts              |
| pro       | http://localhost:4003   | private OTC trading               |
| operators | http://localhost:4004   | operator / KYC onboarding console |
| admin     | http://localhost:4005   | protocol + KYC review console     |
| hub       | http://localhost:4006   | navigation hub                    |

Get test tokens (TON / USDC / USDT) from the
[Tokamak faucet](https://docs.tokamak.network/home/service-guide/faucet-testnet),
then trade. The identity website (zk-X509) lives in a
[separate repo](https://github.com/tokamak-network/zk-X509).

> 📖 **Team testing guide → [docs/operations/sepolia-team-setup.md](docs/operations/sepolia-team-setup.md)**
> — step-by-step setup, getting test tokens, the relayer model, shared-infra URLs,
> and **how to report bugs / file issues**. Start here.
>
> 🗺️ **System architecture & diagram → [docs/operations/sepolia-architecture.md](docs/operations/sepolia-architecture.md)**
> — how the Sepolia deployment is wired (frontends, VM services, on-chain contracts, external infra).

---

## How it works

```
Frontend (Next.js)  →  ZK Relayer (Node.js)   →  Contracts (Solidity / Foundry)
     ↕                      ↕                            ↕
  MetaMask            Order matching             PrivateSettlement (ZK)
  EdDSA keys          ZK proof generation        CommitmentPool (incremental Merkle tree)
                      Gasless claims             RelayerRegistry · IdentityGate (multi-CA)
```

- **Private settlement** — Groth16 proofs + commitment pools hide who traded and
  the claim structure on-chain.
- **Compliant by design** — zk-X509 identity gating (Dual-CA: User CA + Relayer
  CA) gates participation without doxxing traders.
- **Off-chain matching, gasless claims** — relayers match orders and relay
  claims so users don't pay gas to collect.

<details>
<summary>ZK circuits (Circom)</summary>

| circuit             | constraints | role                                            |
|---------------------|-------------|-------------------------------------------------|
| `authorize.circom`  | ~15K        | Half-proof per-side settlement authorization    |
| `cancel.circom`     | ~8K         | private order cancel                            |
| `claim.circom`      | ~1.5K       | claim with Merkle inclusion proof               |
| `withdraw.circom`   | ~6K         | withdrawal from commitment pool                 |
| `deposit.circom`    | ~4K         | private deposit into commitment pool            |

</details>

---

## Run locally (development)

### Quick start (mock mode — no zk-X509)

Fastest local loop; identity verification is bypassed.

```bash
./scripts/dev.sh --mock
```

Starts its own anvil with `MockIdentityRegistry`, deploys contracts, launches the
zk-relayer + frontend. Open http://localhost:3000.

> First run builds the ZK circuit artifacts (Powers-of-Tau, a few minutes); later
> runs reuse the cached `.ptau`. Needs [Foundry](https://book.getfoundry.sh/getting-started/installation),
> Node.js ≥ 20, and [circom](https://docs.circom.io/getting-started/installation/) 2.x
> (`cd circuits && npm install` once). See
> [docs/operations/local-setup.md](docs/operations/local-setup.md).

### Full local stack (with zk-X509)

zkScatter requires a zk-X509 Identity Registry for user verification. For the full
setup with both systems on a shared anvil, see
[docs/operations/local-setup.md](docs/operations/local-setup.md):

```bash
IDENTITY_REGISTRY=0x... RELAYER_IDENTITY_REGISTRY=0x... ./scripts/dev.sh
```

### Run tests

```bash
(cd contracts && forge test)                         # contract tests
(cd zk-relayer && npm test)                          # relayer unit tests
(cd zk-relayer && npx tsx test/e2e-private-flow.ts)  # full E2E (needs ./scripts/dev.sh --mock)
```

---

## Repository structure

```
contracts/    Solidity contracts + Foundry tests (RelayerRegistry, IdentityGate,
              CommitmentPool, PrivateSettlement, IncrementalMerkleTree)
circuits/     Circom ZK circuits + build scripts
apps/         Next.js frontends — pro, pay, operators, admin, hub
zk-relayer/   ZK order matching + gasless claim relay (orderbook, matcher, DB)
scripts/      Dev, deploy, and E2E scripts
docs/         Guides, design docs, operations runbooks
```

---

## Documentation

| Topic | Doc |
|-------|-----|
| **User guide — what each app is for & how to use it** | [user-guide.md](docs/user-guide.md) |
| **Team testing on Sepolia** | [operations/sepolia-team-setup.md](docs/operations/sepolia-team-setup.md) |
| Sepolia system architecture & diagram | [operations/sepolia-architecture.md](docs/operations/sepolia-architecture.md) |
| Local development setup | [operations/local-setup.md](docs/operations/local-setup.md) |
| Running a relayer | [operations/running-a-relayer.md](docs/operations/running-a-relayer.md) |
| Registering a relayer (KYC) | [operations/registering-a-relayer.md](docs/operations/registering-a-relayer.md) |
| ZK artifacts on deployed networks | [operations/zk-artifacts.md](docs/operations/zk-artifacts.md) |
| Security & audit | [security/AUDIT.md](docs/security/AUDIT.md) · [security/HARDENING.md](docs/security/HARDENING.md) |

---

## Security

External auditors: start at [`docs/security/AUDIT.md`](docs/security/AUDIT.md) for
scope, in/out boundaries, and copy-pasteable reproduction commands. The deeper
*why* behind each safety-net layer lives in
[`docs/security/HARDENING.md`](docs/security/HARDENING.md).

Found a security-sensitive issue? **Do not open a public issue** — email
**security@tokamak.network** privately.

## License

zkScatterDEX is provided under the [Business Source License 1.1](LICENSE):
non-production use (research, auditing, contributions) is permitted; production
use requires a separate commercial license. For any licensing questions, contact
**Tokamak Network** (legal@tokamak.network).
