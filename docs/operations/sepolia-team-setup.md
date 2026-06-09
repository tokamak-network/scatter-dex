# Sepolia team setup

Run the zkScatter frontends and the zk-X509 management website against the
**live Sepolia (chainId 11155111)** deployment, so the whole team sees the same
contracts. You clone the repo, supply only **your own RPC key**, and the launch
scripts wire everything else from the committed address ledgers.

> zk-X509 core (circuits / contracts / lib) is never modified — these scripts
> only generate gitignored `.env.local` config and start dev servers.

## One-time prerequisites

1. **Your own Sepolia RPC key.** Contract addresses are public, but the RPC URL
   is injected into `NEXT_PUBLIC_*` and therefore **exposed in the browser** — so
   everyone uses their *own* key, never a shared one.

   ```bash
   export SEPOLIA_RPC_URL="https://eth-sepolia.g.alchemy.com/v2/<your-key>"
   ```

   (Alchemy, Infura, or your own node all work.) Add it to your shell profile so
   it persists.

2. **A browser wallet** (MetaMask etc.) on the Sepolia network with a little test
   ETH for any on-chain action (deposits, `addCA`, registration).

3. Clone the repo and `git pull` so you have the latest `contracts/deployments/`
   ledgers.

## Run a scatter frontend

```bash
scripts/run-scatter-web.sh <app> sepolia
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
scripts/run-scatter-web.sh hub sepolia        # navigation hub (no RPC needed)
scripts/run-scatter-web.sh pro sepolia        # pro trading UI
scripts/run-scatter-web.sh operators sepolia  # operator / KYC console
```

Flags:

- `--no-start` — write `.env.local` only, don't launch the dev server.

The generated `.env.local`:

- **Contract addresses** come from the committed ledger — never hand-edit them.
- **`SEPOLIA_RPC_URL`** (your key) is injected as `NEXT_PUBLIC_RPC_URL`.
- **Shared orderbook** defaults to the live central box
  `http://136.115.115.93:4000` (static-reserved IP). Override with
  `SCATTER_ORDERBOOK_URL` if needed.
- **Token list** is sourced from the **on-chain whitelist** (Pool ∩ Settlement
  `getWhitelistedTokens`), so no token addresses are baked into the env.

Optional overrides (export before running):

| variable                 | purpose                          | default                     |
|--------------------------|----------------------------------|-----------------------------|
| `SCATTER_ORDERBOOK_URL`  | central shared orderbook         | `http://136.115.115.93:4000`|
| `ZKX509_WEB_URL`         | zk-X509 CA-registration website  | `http://localhost:3000`     |
| `ZK_RELAYER_URL`         | a relayer endpoint               | `http://localhost:3002`     |

## Run the zk-X509 management website

The zk-X509 frontend lives in a **separate repo**. Point this script at your
checkout (`ZK_X509_REPO`, default `../zk-X509`):

```bash
export ZK_X509_REPO="$HOME/src/zk-X509"      # if not at ../zk-X509
scripts/run-zkx509-web.sh sepolia
```

It reads the zk-X509 repo's own ledger
(`$ZK_X509_REPO/deployments/11155111.json`; falls back to scatter-dex's
`contracts/deployments/zk-x509-{factory,users}-11155111.json`), generates
`frontend/.env.local`, and starts the frontend on http://localhost:3000.

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

- **Frontend works against the chain with just a wallet + RPC.** Browsing
  registries, the dashboard, and **`addCA`** all work with **no backend**.
- **Backend** is an offline **metadata/CMS** (display names, notices, CA guide,
  GitHub PR submission). It is a **central** service — a per-developer localhost
  copy would not share metadata. So `run-zkx509-web.sh` does **not** start it
  unless you pass `--with-local-backend`. Set `ZKX509_BACKEND_URL` to point at
  the central host once it's live; until then only the notices / CA-guide panels
  are affected.
- **Prover is not deployed.** Wallet **`verify`** (zk-proof submission) is
  therefore unavailable. On-chain read/write (browse, `addCA`) still works with
  a wallet.

## Sepolia addresses

The committed ledgers are the single source of truth — the scripts always read
from them, so addresses are never copied by hand (and never go stale here):

- **scatter:** `contracts/deployments/11155111.json` (+ `.md` for a readable view)
- **zk-X509:** `contracts/deployments/zk-x509-{factory,users,relayers}-11155111.json`

To see the addresses a run would inject without starting anything, use
`--no-start` (the script echoes what it wrote):

```bash
scripts/run-scatter-web.sh admin sepolia --no-start && cat apps/admin/.env.local
scripts/run-zkx509-web.sh sepolia --no-start
```

## After a redeploy

The scripts are **idempotent**. When contracts are redeployed, only the ledger
changes — just `git pull` and re-run the same command; addresses update
automatically. No hand-editing of any `.env.local`.

## Troubleshooting

- **`$SEPOLIA_RPC_URL is not set`** — export your own key (see prerequisites).
- **`ledger not found`** — `git pull` to get `contracts/deployments/`.
- **`zk-X509 frontend not found`** — set `ZK_X509_REPO` to your checkout path.
- **Notices / CA-guide panel empty** — expected until `ZKX509_BACKEND_URL`
  points at the central backend; on-chain features are unaffected.
- **Wallet `verify` fails** — expected; the prover is not deployed yet.
