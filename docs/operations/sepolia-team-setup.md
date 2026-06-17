# Sepolia team setup

Run the zkScatter frontends and the zk-X509 management website against the
**live Sepolia (chainId 11155111)** deployment, so the whole team sees the same
contracts. You clone the repo and run a launch script — it wires everything from
the committed address ledgers. **You need a browser wallet on Sepolia and a
one-time zk-X509 identity verification** — this deployment gates deposits and
trades on it (see [Verify your wallet](#verify-your-wallet-zk-x509)). No RPC key
or other config is required.

> zk-X509 core (circuits / contracts / lib) is never modified — these scripts
> only generate gitignored `.env.local` config and start dev servers.

## One-time prerequisites

1. **A browser wallet** (MetaMask etc.) on the Sepolia network with a little test
   ETH for any on-chain action (deposits, `addCA`, registration) — transactions
   are signed and sent through your wallet. Depositing and trading also need a
   one-time [zk-X509 verification](#verify-your-wallet-zk-x509).

2. Clone this repo and `git pull` so you have the latest `contracts/deployments/`
   ledgers.

That's it — **no Sepolia RPC URL is required.** The launch scripts ship a keyless
public-node default and your transactions go through your wallet.

## Get test tokens (TON / USDC / USDT)

To trade you need the deployment's whitelisted tokens, not just ETH. **TON,
USDC, and USDT** come from the **Tokamak testnet faucet** — and it dispenses the
exact same token contracts this deployment whitelists (verified on-chain), so
they show up and are usable in the apps right away.

1. Open the faucet guide:
   <https://docs.tokamak.network/home/service-guide/faucet-testnet>
2. It points at the faucet contract on Sepolia Etherscan — connect your testnet
   wallet on the **Write Contract** tab and call **`requestTokens`**:
   <https://sepolia.etherscan.io/address/0xd655762c601b9cac8f6644c4841e47e4734d0444#writeContract>
3. One call sends you **1200 TON, 100 USDC, 100 USDT**. Limit: **one request per
   24h per account**. (Leftover tokens/ETH can be sent back to the faucet
   contract.)

| token | Sepolia address                              | decimals | where to get it                     |
|-------|----------------------------------------------|----------|-------------------------------------|
| TON   | `0xa30fe40285B8f5c0457DbC3B7C8A280373c40044` | 18       | Tokamak faucet (above)              |
| USDC  | `0x693a591A27750eED2A0e14BC73bB1F313116a1cb` | 6        | Tokamak faucet (above)              |
| USDT  | `0x42d3b260c761cD5da022dB56Fe2F89c4A909b04A` | 6        | Tokamak faucet (above)              |
| WETH  | `0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9` | 18       | wrap Sepolia ETH (canonical WETH9)  |

> **ETH** (for gas, and to wrap into WETH) is **not** from the Tokamak faucet —
> use any public Sepolia ETH faucet (e.g. a faucet tied to your RPC provider).
> The addresses above are the live on-chain whitelist; add them to MetaMask as
> custom tokens if they don't show up automatically.

## Verify your wallet (zk-X509)

**Do this once before depositing or trading.** This deployment gates deposits and
trades on a zk-X509 identity check: `CommitmentPool` and `PrivateSettlement` only
accept actions from a wallet that is `isVerified` in the on-chain
`IdentityRegistry`. Until you verify, a deposit reverts with
`NotIdentityVerified`.

Verification is **self-service** and the ZK proof is generated **locally on your
machine** — this deployment's Users registry uses local proving
(`delegatedProvingRequired = false`), so no server-side prover is involved.

1. **Start the zk-X509 website** (full details in [Run the zk-X509 management
   website](#run-the-zk-x509-management-website)):

   ```bash
   git clone https://github.com/tokamak-network/zk-X509.git "$HOME/src/zk-X509"
   export ZK_X509_REPO="$HOME/src/zk-X509"   # if not at ../zk-X509
   ./scripts/run-zkx509-web.sh sepolia        # → http://localhost:3000
   ```

2. **Install the desktop app** — open the site's **Download** page and install
   the zk-X509 app (macOS `.dmg` / Windows). Signed installers are pending Apple
   notarization, so a build-from-source fallback is documented there too.

3. **Issue your certificate** in the desktop app.

4. **Register** — on the website open the **Users** registry → **Register** tab
   and follow the steps. The desktop app builds the ZK proof locally and submits
   it to the `IdentityRegistry` from your wallet.

5. **Confirm** — once the tx is mined, `IdentityRegistry.isVerified(yourWallet)`
   is `true`. You can now deposit and trade in the scatter apps.

## Run a scatter frontend

```bash
./scripts/run-scatter-web.sh <app> sepolia
#   app = hub | pay | pro | operators | admin
```

This reads `contracts/deployments/11155111.json`, generates
`apps/<app>/.env.local` (gitignored), and starts the dev server.

| app       | dev URL                 |
|-----------|-------------------------|
| pay       | http://localhost:4001   |
| pro       | http://localhost:4003   |
| operators | http://localhost:4004   |
| admin     | http://localhost:4005   |
| hub       | http://localhost:4006   |

Examples:

```bash
./scripts/run-scatter-web.sh hub sepolia        # navigation hub (no RPC needed)
./scripts/run-scatter-web.sh pro sepolia        # pro trading UI
./scripts/run-scatter-web.sh operators sepolia  # operator / KYC console
```

Flags:

- `--no-start` — write `.env.local` only, don't launch the dev server.

The generated `.env.local`:

- **Contract addresses** come from the committed ledger — never hand-edit them.
- **`NEXT_PUBLIC_RPC_URL`** is a keyless public-node default, used for reads
  only — your transactions always go through your wallet.
- **Shared orderbook** defaults to the live central box
  `http://136.115.115.93:4000` (static-reserved IP). Override with
  `SCATTER_ORDERBOOK_URL` if needed.
- **Token list** is sourced from the **on-chain whitelist** (Pool ∩ Settlement
  `getWhitelistedTokens`), so no token addresses are baked into the env.

Optional overrides (export before running):

| variable                 | purpose                                  | default                     |
|--------------------------|------------------------------------------|-----------------------------|
| `SCATTER_ORDERBOOK_URL`  | central shared orderbook                 | `http://136.115.115.93:4000`|
| `ZKX509_WEB_URL`         | zk-X509 CA-registration website          | `http://localhost:3000`     |

The apps show a **relayer selector** in the UI, populated from the on-chain
`RelayerRegistry`; the first online relayer is auto-selected and you can switch in
the dropdown. Right now exactly one relayer is registered (**bot-1**, below), so
it's the only choice — teammates who [run their own](#run-your-own-relayer-optional)
appear automatically.

### Live shared infrastructure

| service              | URL                                          | shared?                              |
|----------------------|----------------------------------------------|--------------------------------------|
| Shared orderbook     | `http://136.115.115.93:4000` (`/health`)     | **yes** — one central bulletin board |
| Relayer **bot-1**    | `http://136.115.115.93:3002` (`/api/info`)   | no — run by an individual operator   |

The **orderbook is the single central service** everyone shares (a GCP
`e2-micro` on a static-reserved IP). The **relayer is not** shared infrastructure
in the same sense — relayers are **operator-hosted and per-operator**. `bot-1` is
run by an **individual operator** (it just happens to be co-located on the same
box so there's at least one live relayer to trade against) — it is **not** project
infrastructure. **Anyone can register a relayer** (next section); once it's
registered on-chain it appears in everyone's selector automatically.

> These are plain **`http://`** endpoints, reachable from frontends served over
> `http://localhost` (the dev setup here). A frontend served over `https://`
> (Vercel, Netlify, an ngrok tunnel) would have the browser block them as **mixed
> content** — front it with a TLS reverse proxy (the box ships a Caddy/Let's
> Encrypt overlay, see `deploy/runtime`) and use the `https://` host instead.

### Run your own relayer (optional)

You don't need your own relayer to test — selecting **bot-1** in the UI is
enough. But the protocol is designed for **anyone to run one**, and a relayer you
register on-chain shows up in everyone's selector. To do it on Sepolia:

1. Get approved: zk-X509 relayer cert (`identityRegistry.isVerified`) and, if the
   KYC gate is enabled, admin approval (`issuanceApprovalRegistry.isApproved`).
   Full flow: [Registering a Relayer](./registering-a-relayer.md).
2. Stand up the relayer process and call `RelayerRegistry.register(url, name,
   fee, bondAmount)` from the **same approved wallet**: [Running a
   Relayer](./running-a-relayer.md). The bond is whatever the admin set via
   `setMinBond` (currently **0** on this deployment).

Once it's running with `SHARED_ORDERBOOK_URL` + `RELAYER_PUBLIC_URL` set, it
auto-registers and heartbeats with the shared orderbook, and — because it's in
the on-chain `RelayerRegistry` — appears in the apps' relayer selector for the
whole team.

## Run the zk-X509 management website

The zk-X509 frontend lives in a **separate repo**. Clone it once, then point the
launcher at your checkout (`ZK_X509_REPO`, default `../zk-X509`):

```bash
git clone https://github.com/tokamak-network/zk-X509.git "$HOME/src/zk-X509"
export ZK_X509_REPO="$HOME/src/zk-X509"      # if not at ../zk-X509
./scripts/run-zkx509-web.sh sepolia
```

It reads the zk-X509 repo's own ledger
(`$ZK_X509_REPO/deployments/11155111.json`; falls back to scatter-dex's
`contracts/deployments/zk-x509-{factory,users}-11155111.json`), generates
`frontend/.env.local`, and starts the frontend on http://localhost:3000.

**No RPC key needed here.** Unlike the scatter apps, the zk-X509 frontend routes
**all** node access — reads *and* writes — through your connected wallet
(`lib/useReadProvider.ts`); it never uses a configured RPC endpoint to talk to
the chain.

On the dashboard you should see the two registries created through our
RegistryFactory (Users + Relayers). Their addresses live in the zk-X509 repo
ledger `deployments/11155111.json` as `registries.users.address` /
`registries.relayers.address`. (The scatter-dex fallback stores them in two
separate files — `contracts/deployments/zk-x509-users-11155111.json` and
`…-relayers-11155111.json` — each under an `identityRegistry` key.) The script
echoes the addresses it injected.

Flags:

- `--no-start` — write `.env.local` only.
- `--with-local-backend` — also generate `backend/.env` and start a *local*
  backend (see topology below; normally the backend is central).

### Backend & prover topology (important)

- **Frontend works against the chain with just a wallet** (no RPC key needed).
  Browsing registries, the dashboard, and **`addCA`** all work with **no backend**.
- **Backend** is an offline **metadata/CMS** (display names, notices, CA guide,
  GitHub PR submission). It is a **central** service — a per-developer localhost
  copy would not share metadata. So `run-zkx509-web.sh` does **not** start it
  unless you pass `--with-local-backend`. Set `ZKX509_BACKEND_URL` to point at
  the central host once it's live; until then only the notices / CA-guide panels
  are affected.
- **Identity proofs are generated locally, not by a server.** The Users registry
  uses local proving (`delegatedProvingRequired = false`), so the **zk-X509
  desktop app** builds the ZK proof on your machine — no server-side prover is
  deployed or needed. The web frontend itself doesn't generate proofs; it
  orchestrates browse / `addCA` / registration. To verify your wallet, follow
  [Verify your wallet](#verify-your-wallet-zk-x509).

## Sepolia addresses

The committed ledgers are the single source of truth — the scripts always read
from them, so addresses are never copied by hand (and never go stale here):

- **scatter:** `contracts/deployments/11155111.json` (+ `.md` for a readable view)
- **zk-X509:** `contracts/deployments/zk-x509-{factory,users,relayers}-11155111.json`

To see the addresses a run would inject without starting anything, use
`--no-start` (the script echoes what it wrote):

```bash
./scripts/run-scatter-web.sh admin sepolia --no-start && cat apps/admin/.env.local
./scripts/run-zkx509-web.sh sepolia --no-start
```

## After a redeploy

The scripts are **idempotent**. When contracts are redeployed, only the ledger
changes — just `git pull` and re-run the same command; addresses update
automatically. No hand-editing of any `.env.local`.

## Troubleshooting

- **No RPC key set?** Not an error — both the scatter apps and the zk-X509
  website fall back to a keyless public node (both launch scripts just print a
  `NOTE`) and route your transactions through your wallet.
- **`ledger not found`** — `git pull` to get `contracts/deployments/`.
- **`zk-X509 frontend not found`** — set `ZK_X509_REPO` to your checkout path.
- **Notices / CA-guide panel empty** — expected until `ZKX509_BACKEND_URL`
  points at the central backend; on-chain features are unaffected.
- **Deposit reverts with `NotIdentityVerified`** — your wallet isn't zk-X509
  verified yet. Complete [Verify your wallet](#verify-your-wallet-zk-x509) first.
- **Wallet `verify` fails** — run the verify flow from the zk-X509 **desktop
  app** (the web page alone doesn't generate proofs) and from the **same wallet**
  you trade with. See [Verify your wallet](#verify-your-wallet-zk-x509).

## Reporting bugs and filing issues

Hit something broken or surprising while testing? **File a GitHub issue** so it's
tracked — don't just report it in chat.

- **Open an issue:** <https://github.com/tokamak-network/scatter-dex/issues/new/choose>
  and pick **🐛 Bug report** (or **💡 Feedback / idea** for UX/suggestions).
- Or from the CLI in this repo:

  ```bash
  gh issue create --repo tokamak-network/scatter-dex
  ```

Please include, so it's reproducible:

- **App + network** — e.g. `pro` on Sepolia, the dev URL (`localhost:4003`).
- **Which relayer** you had selected in the UI (e.g. `bot-1`), if relevant.
- **Steps to reproduce**, what you expected, what actually happened.
- **Tx hash(es)** for any on-chain action, and your wallet address (public is
  fine — never paste a private key or seed phrase).
- **Console / network errors** — open the browser devtools console and copy any
  red errors; note the failing request URL if it's a relayer/orderbook call.
- **Your commit:** `git rev-parse --short HEAD` (so we know which build you ran).

> Security-sensitive findings (fund loss, proof bypass, key exposure) — do **not**
> open a public issue. Email **security@tokamak.network** privately instead (a
> PGP key is available; see `docs/cex-compliance/SECURITY-AND-AUDIT.md`).
