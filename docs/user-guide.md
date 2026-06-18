# zkScatter user guide — what each app is for and how to use it

One ZK stack, several front-ends. Each app targets a different job, but they all
share the same private commitment pool, zk-X509 identity gating, and gasless
claims. This page explains **why you'd use each app, what you get, and how to
use it** — in one place.

New to the project and just want to see it run? Start with the
[Sepolia team testing guide](operations/sepolia-team-setup.md) — it gets you a
wallet, test tokens, and a running front-end. This page is the "why / how" layer
on top of that.

| App | Use it when you want to… | Status |
|-----|--------------------------|--------|
| [Pay](#pay) | Send payroll / grants / bonuses to many people **without publishing who got how much** | Wireframe (mock data) |
| [Pro](#pro) | Place a **private limit order** with no MEV and no balance leak | Live (real ZK + on-chain) |
| [Drop](#drop) | Run a **sybil-resistant airdrop** to real humans, gaslessly | Wireframe (mock data) |
| [Operators](#operators) | **Run a relayer** and earn fees settling private order flow | Live |
| [Admin](#admin) | Govern the deployment (CA issuance, sanctions, params, treasury) | Live (internal) |

---

## Pay

**Private bulk payouts.** Send payroll, grants, and bonuses without leaking who
got what.

**Why use it**
- Recipients **can't see each other's amounts** — per-recipient private claim links.
- **One signature, one on-chain transaction** funds escrow into a private vault and splits into per-recipient payouts.
- Recipients **claim gaslessly** — they don't pay to collect.
- Audit-grade signed accounting export for your records.

**Good for:** running payroll for 5–50 people, paying grant recipients from a
Snapshot result, settling a wave of freelancers without leaking per-contractor
rates.

**How to use**
1. Open Pay (`./scripts/run-scatter-web.sh pay sepolia`, http://localhost:4001).
2. Connect MetaMask (Sepolia) and pass the zk-X509 identity gate.
3. New payout → pick token (driven by the on-chain whitelist), add recipients (manual or CSV/Excel upload).
4. Fund the vault, sign once → relayer batches the settlement on-chain.
5. Share each recipient's private claim link; they claim gaslessly.

**Learn more:** in-app landing page · [product spec](product/SCATTERPAY_SPEC.md)

---

## Pro

**Private OTC / limit-order trading.** Get the price you see — no MEV, no desk
spread, no RFQ leak.

**Why use it**
- **MEV-free by construction** — limit orders matched off-chain skip the AMM curve and the front-runner entirely (a $50K Uniswap trade can lose 1–3% to sandwiches).
- **Balance-private** — your wallet balance stays hidden after the trade.
- **Regulator-ready** — Dual-CA zk-X509 identity gating, not a mixer.
- **Batched on-chain settlement**, gasless claim of proceeds.

**Good for:** OTC desks, semi-pro traders, privacy-conscious whales, treasuries /
family offices.

**How to use**
1. Open Pro (`./scripts/run-scatter-web.sh pro sepolia`, http://localhost:4003).
2. Connect MetaMask (Sepolia) and pass the zk-X509 identity gate.
3. Deposit into the private vault.
4. Place a private limit order — set price, size, recipient; sign with your trading key. The order joins the shared orderbook anonymously and waits for a match.
5. When matched, the relayer batches settlement on-chain; claim the proceeds gaslessly.

**Learn more:** in-app landing page · developer how-to guides under
`developers/docs/guides/` at the repo root (connect-wallet, deposit, place-order,
claim, cancel) · [reposition spec](product/PRO_REPOSITION.md)

---

## Drop

**Sybil-resistant private airdrops.** Get your token to real humans, not bot
farms.

**Why use it**
- **Provable anti-sybil** via zk-X509 — real 1 person = 1 claim, not heuristics (sybil farmers routinely take 10–30% of supply and dump on day one).
- **Gasless claim** — the campaign covers gas for recipients.
- **Per-recipient amount hidden on-chain** — reduces day-one dump pressure.
- Embeddable claim widget + audit-grade signed export.

**Good for:** token launch teams, NFT/communities, DAO governance distributions.

**How to use**
1. Open Drop (`./scripts/run-scatter-web.sh drop sepolia`).
2. Set the sybil & privacy policy — require zk-X509, toggle gasless claim.
3. Upload the recipient list and fund the campaign.
4. One transaction commits the campaign on-chain.
5. Share the claim URL or embed the widget; recipients claim gaslessly.

**Learn more:** in-app landing page · [product spec](product/SCATTERDROP_SPEC.md)

---

## Operators

**Run the settlement rail for private order flow.** You can't front-run — that's
the feature.

**Why use it**
- **Permissionless** — post a bond to the RelayerRegistry and publish your endpoint + per-trade fee (bps).
- **Can't see order amounts/sides** — orders are zk-encrypted.
- **Deterministic on-chain bps per fill** — no opaque take-rate.
- **No vendor lock-in** — change endpoint/fee in one tx; exit and recover your bond after a cool-down.

**Good for:** validators with idle gas budget, OTC desks with their own flow,
operators in regulated jurisdictions.

**How to use**
1. Open Operators (`./scripts/run-scatter-web.sh operators sepolia`, http://localhost:4004).
2. Complete relayer onboarding (KYC → approval → zk-X509 cert → on-chain registration).
3. Stand up the open-source relayer node (Docker / single binary).
4. Monitor fills and treasury from the console.

**Learn more:** [registering a relayer](operations/registering-a-relayer.md) ·
[running a relayer](operations/running-a-relayer.md)

---

## Admin

**Deployment governance console** — wired to the multisig that governs this
deployment. Operator CA issuance, sanctions list, protocol parameters (fee
splits, bond minimums, pause switches), and treasury (FeeVault + timelocked fee
changes). Internal/operator tool, not an end-user product.

Open with `./scripts/run-scatter-web.sh admin sepolia` (http://localhost:4005).

---

## Where to go next

- **Run it yourself:** [Sepolia team testing guide](operations/sepolia-team-setup.md)
- **How the system is wired:** [Sepolia architecture](operations/sepolia-architecture.md)
- **Build on it:** developer docs under `developers/` at the repo root (concepts, SDK guides, protocol, whitepaper)
- **Operate a relayer:** [registering](operations/registering-a-relayer.md) · [running](operations/running-a-relayer.md)
</content>
</invoke>
