# Running a Relayer

This is the focused guide for **standing up just YOUR relayer** and getting it
on-chain — not the whole stack. Use it once you've been **approved** (KYC →
zk-X509 proof → admin approval; see [Registering a Relayer](./registering-a-relayer.md)).

> Want the full local stack (anvil + contracts + orderbook + every app) for
> development instead? That's [Local Setup](./local-setup.md) /
> [Deployment](./deployment.md). This page is only the relayer process + the
> shared orderbook it talks to.

A relayer is an off-chain Node service. It needs three things:
1. an **Ethereum RPC** for the chain the protocol is deployed on,
2. the protocol **contract addresses** (CommitmentPool, PrivateSettlement, FeeVault, RelayerRegistry),
3. a reachable **shared orderbook** URL (the bulletin board it posts to).

---

## Prerequisites

- **Node.js + npm**, **git**
- Your **operator wallet private key** — the SAME wallet that was verified +
  approved on-chain (`isVerified` / `kycApproved`). Registering from any other
  wallet reverts.
- The deployment's **RPC URL** and **contract addresses** (ask the network
  admin, or read them from the operators app — they're in
  `apps/operators/.env.local` as `NEXT_PUBLIC_*`).

---

## Current deployment values (fill these into your `.env`)

A relayer must point at the **live** RPC, shared orderbook, and contracts of the
deployment it joins — not placeholders. Get them one of these ways:

- **Ask the network admin** for the deployment's RPC URL, shared-orderbook URL,
  and contract addresses, **or**
- **Read them from the running operators app** — they're emitted into
  `apps/operators/.env.local` (the `NEXT_PUBLIC_*` keys). Map them across:

  | Your relayer `.env` | Read from operators `.env.local` |
  |---|---|
  | `RPC_URL` | `NEXT_PUBLIC_RPC_URL` |
  | `SHARED_ORDERBOOK_URL` | `NEXT_PUBLIC_SHARED_ORDERBOOK_URL` |
  | `COMMITMENT_POOL_ADDRESS` | `NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS` |
  | `PRIVATE_SETTLEMENT_ADDRESS` | `NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS` |
  | `FEE_VAULT_ADDRESS` | `NEXT_PUBLIC_FEE_VAULT_ADDRESS` |
  | `RELAYER_REGISTRY_ADDRESS` | `NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS` |
  | `TOKEN_LIST` | `NEXT_PUBLIC_TOKENS` |

> **This local stack right now** (anvil `http://localhost:8545`, orderbook
> `http://localhost:4000`) deploys to deterministic addresses. Confirm they're
> still current before copying — every `dev.sh` redeploy can change them — by
> reading `apps/operators/.env.local`:
> ```bash
> grep -E 'NEXT_PUBLIC_(RPC_URL|SHARED_ORDERBOOK_URL|COMMITMENT_POOL|PRIVATE_SETTLEMENT|FEE_VAULT|RELAYER_REGISTRY|TOKENS)' apps/operators/.env.local
> ```

## 1. Get the code

```bash
git clone https://github.com/tokamak-network/scatter-dex.git
cd scatter-dex/zk-relayer
npm install
```

## 2. Configure the relayer

Copy the example env and fill it in (`zk-relayer/.env.example` lists every key):

```bash
cp .env.example .env
```

The `.env` has **two kinds of values** — keep them straight:

**A) Provided by the deployment** (copy verbatim from the network / operators
`.env.local`, per the table above — do NOT make these up):

```bash
RPC_URL=                      # the deployment's chain RPC
SHARED_ORDERBOOK_URL=         # the running shared orderbook
COMMITMENT_POOL_ADDRESS=0x…
PRIVATE_SETTLEMENT_ADDRESS=0x…
FEE_VAULT_ADDRESS=0x…
RELAYER_REGISTRY_ADDRESS=0x…
TOKEN_LIST=0x…:WETH:18,0x…:USDC:6   # = operators NEXT_PUBLIC_TOKENS
```

**B) Chosen by you, the operator** (your identity + how you run this relayer):

```bash
RELAYER_PRIVATE_KEY=0x…       # YOUR verified/approved operator wallet key
                              # (or RELAYER_PRIVATE_KEY_FILE=/run/secrets/…)
RELAYER_NAME="bot-1"          # your label on the leaderboard / RelayerPicker
RELAYER_FEE=30                # basis points you keep per fill (max 500 = 5%)
PORT=3004                     # a FREE port (see note) — yours to pick
RELAYER_PUBLIC_URL=http://localhost:3004   # where peers/apps reach YOUR relayer
CORS_ORIGINS=http://localhost:4001,http://localhost:4003,http://localhost:4004  # browser origins allowed to call you
DB_PATH=./zk-relayer-bot-1.db # your relayer's own SQLite file
```

> **`RELAYER_PRIVATE_KEY` (group B) is the one that must match your on-chain
> identity** — the same wallet that was verified/approved. The group-A values
> just connect you to the existing network.

> **Port must not collide.** The default dev stack already uses 3002 (Relayer A)
> and 3003 (Relayer B), so the example above uses **3004** for `bot-1`. Set
> `PORT` and `RELAYER_PUBLIC_URL` to the same free port.

> **Where's the shared orderbook?** Every relayer in a deployment posts to one
> shared orderbook service. In production it's already running (the admin gives
> you its URL). To run your own locally for testing, start it from
> `shared-orderbook/` (`npm install && npm run dev`, default `:4000`) and point
> `SHARED_ORDERBOOK_URL` at it.

> **⚠ Local / loopback peers — `ALLOW_PRIVATE_RELAYER_URLS=1`.** Cross-relayer
> matching works in two steps: the matcher pairs your order with a remote
> relayer's order, then sends a **trade offer to that peer's
> `RELAYER_PUBLIC_URL`**. An SSRF guard (`zk-relayer/src/lib/url-guard.ts`) blocks
> outbound requests to private / loopback addresses by default, so when peers
> advertise `http://localhost:<port>` (every local multi-relayer setup) the
> offer is **rejected**. The relayer logs structured JSON — the message is
> `Trade offer rejected` with the guard error in `meta.reason`:
> ```json
> {"level":"warn","mod":"authorize-cross","msg":"Trade offer rejected","meta":{"reason":"unsafe peer URL: URL hostname localhost resolves to a private/loopback IP (::1)"}}
> ```
> The order matches but never settles. Fix: set **`ALLOW_PRIVATE_RELAYER_URLS=1`**
> on **every** relayer in the local stack (not just one — the guard runs on the
> sender side). Add it to your `.env`:
> ```bash
> ALLOW_PRIVATE_RELAYER_URLS=1   # local/loopback peers only — MUST stay unset in production
> ```
> `dev.sh` sets this automatically for the relayers it launches; you only need it
> when starting a relayer by hand. **Never set it in production** — it disables
> the SSRF protection that stops a malicious peer URL from reaching internal
> services.

## 3. Start it

```bash
npm run dev          # or: npm run build && npm start
```

Sanity-check it answers (the registration probe hits this exact endpoint):

```bash
curl -s http://localhost:3002/api/info | python3 -m json.tool
# { "name": "My Relayer", "chainId": 1, "address": "0x…", ... }
```

In production, put it behind HTTPS at `RELAYER_PUBLIC_URL` and keep it always-on
(systemd / a process manager). See [Deployment](./deployment.md) for a hardened
service + reverse-proxy reference.

## 4. Register on-chain

Registration is **gated** — `RelayerRegistry.register()` reverts with
`NotVerified` unless your wallet proved its certificate to zk-X509, and (when
the KYC gate is wired) `NotKycApproved` without a current admin approval. If you
haven't onboarded yet, do that first ([Registering a Relayer](./registering-a-relayer.md)).

Easiest path — the operators app `/register` wizard, **Steps 4–5** (Endpoint +
Bond): it probes your URL live and builds the tx for you.

Or directly with `cast` (signature is
`register(string url, string name, uint256 fee, uint256 bondAmount)`; the bond
must be ≥ `RelayerRegistry.minBond()` and is sent as `--value` in native-bond mode):

```bash
BOND=$(cast call $RELAYER_REGISTRY_ADDRESS "minBond()(uint256)" --rpc-url $RPC_URL)
cast send $RELAYER_REGISTRY_ADDRESS \
  "register(string,string,uint256,uint256)" \
  "$RELAYER_PUBLIC_URL" "$RELAYER_NAME" "$RELAYER_FEE" "$BOND" \
  --value "$BOND" \
  --rpc-url $RPC_URL --private-key $RELAYER_PRIVATE_KEY
```

On confirmation your relayer appears on `/leaderboard` and becomes selectable in
Pay/Pro — it's now eligible to match orders.

---

## Troubleshooting

- **`register()` reverts `NotVerified`** — your wallet hasn't proved its
  certificate to zk-X509 (or you're registering from a different wallet than the
  one verified). Complete onboarding from the same wallet.
- **`register()` reverts `NotKycApproved`** — the KYC gate is on and the admin
  hasn't approved your wallet yet. Wait for / request approval.
- **`/api/info` doesn't answer** — the process isn't up, or `PORT` /
  `RELAYER_PUBLIC_URL` don't match what you're registering. The registration
  probe must reach the URL you submit.
- **Endpoint probe warns "chainId mismatch"** — `RPC_URL` points at a different
  chain than the apps. Align it with the deployment's chain.
- **Orders match but never settle (cross-relayer)** — the order shows `matching`
  on both relayers but no settlement tx fires, and the sender's log shows a
  `msg":"Trade offer rejected"` line with `meta.reason` =
  `unsafe peer URL: … resolves to a private/loopback IP`.
  The SSRF guard is blocking the loopback peer URL. Set
  `ALLOW_PRIVATE_RELAYER_URLS=1` on **every** relayer in a local stack and
  restart. Production peers use public HTTPS URLs, so this never trips there —
  keep the flag unset in production. See the env note in step 2.

See also: [Registering a Relayer](./registering-a-relayer.md) (full onboarding),
[Deployment](./deployment.md) (production hardening), [Security Hardening](./relayer-security.md).
