# zkScatter user guide — what each app is for and how to use it

One ZK stack, several front-ends. Each app targets a different job, but they all
share the same private commitment pool, zk-X509 identity gating, and gasless
claims. This page explains **why you'd use each app, what you get, and how to
use it** — in one place.

New to the project and just want to see it run? Start with the
[Sepolia team testing guide](operations/sepolia-team-setup.md) — it gets you a
wallet, test tokens, and a running front-end. This page is the "why / how" layer
on top of that.

> 📸 **Screenshots** go in [`assets/user-guide/`](assets/user-guide/README.md)
> (see that folder's README for filenames + how to swap a placeholder for an
> image). Lines below marked `📸` are slots waiting for a capture.

| App | Use it when you want to… | Status |
|-----|--------------------------|--------|
| [Pay](#pay) | Send payroll / grants / bonuses to many people **without publishing who got how much** | Wireframe (mock data) |
| [Pro](#pro) | Place a **private limit order** with no MEV and no balance leak | Live (real ZK + on-chain) |
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

> ⚠️ Pay launches today but is still a **wireframe with mock data** — SDK/on-chain
> integration is in progress, so the steps below preview the intended flow.

**How to use**
1. Open Pay (`./scripts/run-scatter-web.sh pay sepolia`, http://localhost:4001).
2. Connect MetaMask (Sepolia) and pass the zk-X509 identity gate.
3. New payout → pick token (driven by the on-chain whitelist), add recipients (manual or CSV/Excel upload).
4. Fund the vault, sign once → relayer batches the settlement on-chain.
5. Share each recipient's private claim link; they claim gaslessly.

> 📸 _Slot: `assets/user-guide/pay-payout-wizard.png` — the new-payout wizard (token + recipients), labeled as preview (mock data)._

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

> 📸 _Slot: `assets/user-guide/pro-place-order.png` — the limit-order form._
>
> 📸 _Slot: `assets/user-guide/pro-claim.png` — claiming matched proceeds._

**Learn more:** in-app landing page · developer how-to guides under
`developers/docs/guides/` at the repo root (connect-wallet, deposit, place-order,
claim, cancel) · [reposition spec](product/PRO_REPOSITION.md)

---

## Operators

**Run the settlement rail for private order flow** and earn a per-trade fee for
it. This isn't a new business to start from scratch — it's a way to earn from
infrastructure or order flow you already have.

**Why people run one**

- **You already pay for a node and gas.** Validators and infra operators settle
  trades at near-zero marginal cost, so even a thin per-trade fee (bps) is profit.
  Your idle gas budget becomes revenue.
- **You already have the flow — stop paying someone else to settle it.** OTC
  desks, wallets, and apps that route their own trades can settle them in-house.
  Here the fee isn't new income, it's a cost you stop leaking to an external
  relayer.
- **You need to settle privately *and* compliantly.** The KYC + zk-X509 gate is a
  barrier to most, but for operators in regulated jurisdictions it's the point:
  settle private order flow with a real compliance posture behind it.

**Why it's safe to rely on**

- **You can't front-run it** — orders are zk-encrypted, so you settle without ever
  seeing amounts or sides. That means no MEV to extract here; this is neutral
  infrastructure, not a searcher's game.
- **The terms are on-chain and yours.** Deterministic bps per fill (no opaque
  take-rate), change endpoint/fee in one tx, and exit to recover your bond after a
  cool-down — no vendor lock-in.
- **Skin in the game.** The bond you post is your stake in a censorship-resistant
  settlement layer, and a neutral relayer that proves it can't peek is a
  reputation asset.

**How to use**

Open Operators with `./scripts/run-scatter-web.sh operators sepolia`
(http://localhost:4004). The top nav has a **Home** link plus four menus:
**Platform** (public, network-wide), **My** (your relayer — needs your wallet),
**Identity** (your verification / KYC status), and **Docs**.

### Get registered

Registration is a one-time, gated journey. Two independent gates must both clear
before you can post a bond: an **admin KYC approval** (off-chain packet → on-chain
sign-off) and a **zk-X509 certificate** that proves your identity without
revealing it. The **Register** wizard (`My → Register relayer`) walks all five
steps and won't let you advance until each precondition is met:

1. **KYC** — submit your packet (email, ID document) to the orderbook backend.
2. **zk-X509 verification** — open the CA portal, issue your certificate, generate
   a keypair, and submit the ZK proof. This flips `isVerified` on-chain. Track CA
   address, validity, and your verification/approval status on the
   **Operator CA** screen.
3. **Admin approval** — wait for the admin to sign off in
   `IssuanceApprovalRegistry`; the wizard polls and unlocks automatically.
4. **Endpoint, name & fee** — point the wizard at your running relayer's URL. It
   live-probes `/api/info` so you catch an unreachable node *before* spending gas.
   Set a unique display name and your per-trade fee (bps).
5. **Bond & submit** — enter a bond ≥ the registry minimum, approve the bond token
   if needed, and send the `register()` tx.

New to this? Start at **Onboarding** (`Docs → Get started`) instead — it shows the
six setup steps with live status cards (wallet connected, RPC reachable, on-chain
state) and a glossary of bond / fee bps / slashing / exit cool-down.

> Before step 4 your relayer node must already be running. Clone the repo,
> copy `.env.example` → `.env` (RPC, contract addresses, `RELAYER_PRIVATE_KEY`,
> `RELAYER_PUBLIC_URL`), then `npm start` in `zk-relayer/`. See
> [running a relayer](operations/running-a-relayer.md).

### Run it day to day

Once registered, these screens are your operating loop (most under **My**). The
admin views authenticate by **signing a SIWE challenge with your operator
wallet** in the connect bar — no API key; the session lives only in the tab:

- **Dashboard** — your live overview: bond & fee on-chain, your public endpoint,
  24h fills / pending queue / avg gas, health (running vs paused, ETH balance,
  last settlement), and recent throughput with latency percentiles.
- **Orders** — open orders from the shared orderbook merged with your settled /
  failed history, bucketed by status (Matching, Matched, Cancelled, Expired,
  Settled, Failed). Click a row for full settlement detail or the failure reason.
- **Treasury** — claimable FeeVault balance per token (one click to `claim`),
  lifetime fee totals, and a banner for any pending fee change with its effective
  time.
- **Analytics** — aggregated metrics over 1d / 7d / 30d / 90d (success rate, gas,
  tokens routed, throughput) with CSV export.
- **Controls** (`/runtime`) — pause/resume the relayer, drain the authorize
  queue, publish a fee change on-chain, and manage the sanctions blocklist
  (`Cmd/Ctrl-K` for a command palette).
- **Profile** — edit URL / name / fee (`RelayerRegistry.updateInfo`), add bond, or request
  exit. Exit locks your bond for a cool-down, after which you execute it to
  recover the bond.

### Compare and verify (public)

- **Leaderboard** (`Platform`) — every registered relayer ranked by volume,
  revenue, activity, bond, fee, success rate, or speed, with a live health dot.
  Click a row for that relayer's public **profile** (`/relayer`).

> 📸 _Slot: `assets/user-guide/operators-console.png` — the relayer dashboard (fills / fees / treasury)._

**Learn more:** [registering a relayer](operations/registering-a-relayer.md) ·
[running a relayer](operations/running-a-relayer.md)

---

## Admin

**Deployment governance console** — wired to the multisig that governs this
deployment. Operator CA issuance, sanctions list, protocol parameters (fee
splits, bond minimums, pause switches), and treasury (FeeVault + timelocked fee
changes). Internal/operator tool, not an end-user product.

Open with `./scripts/run-scatter-web.sh admin sepolia` (http://localhost:4005).

> 📸 _Slot: `assets/user-guide/admin-console.png` — the governance console modules._

---

## Where to go next

- **Run it yourself:** [Sepolia team testing guide](operations/sepolia-team-setup.md)
- **How the system is wired:** [Sepolia architecture](operations/sepolia-architecture.md)
- **Build on it:** developer docs under `developers/` at the repo root (concepts, SDK guides, protocol, whitepaper)
- **Operate a relayer:** [registering](operations/registering-a-relayer.md) · [running](operations/running-a-relayer.md)
