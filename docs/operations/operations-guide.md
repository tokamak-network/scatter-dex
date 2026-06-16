# Relayer Operations Guide

This guide covers day-to-day relayer operations: monitoring, admin actions, troubleshooting, and maintenance. For initial deployment, see [deployment.md](./deployment.md).

## Table of Contents

1. [Monitoring](#monitoring)
2. [Admin API](#admin-api)
3. [Configuration Reference](#configuration-reference)
4. [Common Operations](#common-operations)
5. [Troubleshooting](#troubleshooting)
6. [Database Management](#database-management)
7. [Security Checklist](#security-checklist)

---

## Monitoring

### Health Check

```bash
curl http://localhost:3002/health
# {"status":"healthy","uptime":3600,"checks":{"rpc":"ok","db":"ok"}}
```

| Status | HTTP | Meaning |
|--------|------|---------|
| `healthy` | 200 | All checks pass |
| `degraded` | 503 | RPC or DB unreachable |

Use `/health` for K8s liveness/readiness probes. Note: the bundled Docker Compose currently probes `/api/info` every 3s with 15 retries (45s startup window) for container orchestration; `/health` is recommended for external monitoring/alerting because it reports degraded state (RPC/DB failures) with HTTP 503.

### Relayer Stats

```bash
curl http://localhost:3002/api/relayer/stats
```

Returns:

```json
{
  "address": "0x...",
  "totalOrders": 142,
  "settledOrders": 130,
  "successRate": 92,
  "crossRelayerSettled": 15,
  "avgSettleTimeMs": 12500,
  "uptimeSince": 1712880000000,
  "totalTradeOffers": 40,
  "settledTradeOffers": 15,
  "pendingOrders": 3,
  "settledVolume": { "0xTokenAddr": "12345678900000000000" },
  "metrics": {
    "gas": {
      "avgCostEth": 0.0048,
      "minCostEth": 0.003,
      "maxCostEth": 0.007,
      "lastCostEth": 0.005,
      "totalSpentEth": 0.624
    },
    "settlement": {
      "avgDurationMs": 12500,
      "minDurationMs": 8000,
      "maxDurationMs": 22000,
      "lastDurationMs": 11200,
      "totalCount": 130,
      "perMinute": 1.2
    },
    "orders": {
      "submittedPerMinute": 3.5
    },
    "sampleSize": 100
  }
}
```

> Schema source: `zk-relayer/src/routes/relayer-stats.ts` (spreads `db.getRelayerStats()` + `getMetrics()`). `settledVolume` is keyed by token address with wei-denominated string amounts.

### Ops Dashboard

Open `http://localhost:3000/relayer/ops` in a browser for real-time monitoring across all relayer instances. Auto-refreshes every 15 seconds.

Shows: instance health, settlement rate, gas spent, throughput, per-relayer breakdown.

---

## Admin API

This section covers the endpoints under `/api/admin/*` plus the operator-only `/api/vault/claim` (see [Vault Claim](#claim-vault-fees-vault-route) subsection — same auth, different route prefix). They authenticate via the relayer **operator's wallet signature (SIWE)** — the relayer's own signing key (its `RELAYER_PRIVATE_KEY`, or whatever `RELAYER_PRIVATE_KEY_FILE` points at), i.e. this node's on-chain operator. No key to configure. The operator console (web UI) does this for you; for raw `curl`, mint a short-lived session bearer first (needs foundry's `cast` + `jq`):

```bash
export OPERATOR_PK=0x...          # the relayer's signing key (RELAYER_PRIVATE_KEY / _FILE)
R=http://localhost:3002
CH=$(curl -s "$R/api/admin/challenge")
MSG=$(echo "$CH" | jq -r .message); NONCE=$(echo "$CH" | jq -r .nonce)
SIG=$(cast wallet sign --private-key "$OPERATOR_PK" "$MSG")
export TOKEN=$(curl -s -X POST "$R/api/admin/session" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg n "$NONCE" --arg m "$MSG" --arg s "$SIG" '{nonce:$n,message:$m,signature:$s}')" \
  | jq -r .token)
```

Then pass `-H "Authorization: Bearer $TOKEN"` on the calls below. The session expires — re-mint when a call returns 401 "Invalid or expired session".

### Status Overview

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3002/api/admin/status
```

### ETH Balance

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3002/api/admin/balance
# {"address":"0x...","ethBalance":"1500000000000000000","chainId":1}
```

`ethBalance` is a **wei**-denominated string (from `provider.getBalance().toString()`). Convert to ETH for display:

```bash
curl -sH "Authorization: Bearer $TOKEN" http://localhost:3002/api/admin/balance \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=BigInt(JSON.parse(s).ethBalance);console.log(Number(b)/1e18,"ETH")})'
```

### Change Fee

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"feeBps": 50}' \
  http://localhost:3002/api/admin/fee
# {"status":"updated","oldFeeBps":30,"newFeeBps":50}
```

Fee is persisted to DB and survives restarts.

### Pause / Resume

```bash
# Pause — new POST orders return 503
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3002/api/admin/pause

# Resume
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3002/api/admin/resume
```

Pause state is persisted to DB. Useful before maintenance or when gas prices spike.

### Drain All Orders

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3002/api/admin/drain
# {"status":"drained","privateOrdersCancelled":5,"authorizeOrdersCancelled":12}
```

Cancels all pending orders immediately. Use before shutdown or emergency maintenance.

### Claim Vault Fees (vault route)

> Note: unlike the endpoints above, this lives under `/api/vault/*` rather than `/api/admin/*`, but uses the same SIWE bearer auth.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"token": "0xTokenAddress"}' \
  http://localhost:3002/api/vault/claim
```

---

## Configuration Reference

### Required

| Variable | Description |
|----------|-------------|
| `RELAYER_PRIVATE_KEY` | Wallet private key (or use `RELAYER_PRIVATE_KEY_FILE`) |
| `COMMITMENT_POOL_ADDRESS` | CommitmentPool contract address |
| `PRIVATE_SETTLEMENT_ADDRESS` | PrivateSettlement contract address |
| `FEE_VAULT_ADDRESS` | FeeVault contract address |

> `RPC_URL` has a default (`http://localhost:8545`) suitable for local Anvil, so it is technically optional. For any non-local deployment (testnet/production) it is effectively required — set it to your JSON-RPC provider endpoint.

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `RPC_URL` | `http://localhost:8545` | Ethereum JSON-RPC endpoint (override for testnet/prod) |
| `PORT` | `3002` | API server port |
| `RELAYER_FEE` | `30` | Fee in basis points (0.3%) |
| `DB_PATH` | `./zk-relayer.db` | SQLite database path |
| `MAX_GAS_PRICE_GWEI` | `100` | Gas price ceiling |
| `CORS_ORIGINS` | `http://localhost:3000,http://localhost:3002,http://localhost:3003` | Comma-separated allowed origins |
| `RPC_URLS_FALLBACK` | — | Comma-separated fallback RPC endpoints |
| `SHARED_ORDERBOOK_URL` | — | Cross-relayer matching (optional) |
| `RELAYER_PUBLIC_URL` | — | This relayer's public URL for P2P |
| `RELAYER_NAME` | — | Human-readable relayer name |
| `TOKEN_LIST` | — | Token config: `addr:symbol:decimals,...` |

### Private Key Security

Production: use file-based secrets instead of environment variables:

```bash
# Write key to a file with restricted permissions
echo "0x..." > /run/secrets/relayer-key
chmod 600 /run/secrets/relayer-key

# Set in .env
RELAYER_PRIVATE_KEY_FILE=/run/secrets/relayer-key
```

---

## Common Operations

### Planned Maintenance

```bash
# 1. Pause new orders
curl -X POST -H "Authorization: Bearer $TOKEN" localhost:3002/api/admin/pause

# 2. Wait for pending settlements to complete (check status)
curl -H "Authorization: Bearer $TOKEN" localhost:3002/api/admin/status
# Check: pendingTxs == 0, privateOrders.pending == 0

# 3. Drain remaining orders if needed
curl -X POST -H "Authorization: Bearer $TOKEN" localhost:3002/api/admin/drain

# 4. Stop the service
docker compose stop zk-relayer

# 5. Perform maintenance...

# 6. Restart
docker compose up -d zk-relayer
# Pause state is persisted and restored on startup — the relayer
# remains paused after restart. Call /api/admin/resume when ready.
```

### Gas Price Spike

```bash
# Pause to stop settling at high gas prices
curl -X POST -H "Authorization: Bearer $TOKEN" localhost:3002/api/admin/pause

# Monitor gas prices, then resume
curl -X POST -H "Authorization: Bearer $TOKEN" localhost:3002/api/admin/resume
```

The `MAX_GAS_PRICE_GWEI` config also auto-rejects settlements above the threshold.

### Low ETH Balance

```bash
# Check balance
curl -H "Authorization: Bearer $TOKEN" localhost:3002/api/admin/balance

# If low, send ETH to relayer address, or pause until refilled
```

### Restart Recovery

On restart, the relayer automatically:
1. Restores pause state from DB
2. Restores saved relayer fee from DB
3. Recovers pending transactions (receipt polling)
4. Reloads pending authorize orders from DB
5. Re-indexes on-chain commitments from last checkpoint

No manual intervention needed for clean restarts.

---

## Troubleshooting

### Relayer won't start

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Missing required env var: RELAYER_PRIVATE_KEY` | Key not set | Set `RELAYER_PRIVATE_KEY` or `RELAYER_PRIVATE_KEY_FILE` |
| `Missing required env var: COMMITMENT_POOL_ADDRESS` | Contracts not deployed | Deploy contracts first, set addresses in `.env` |
| `health: degraded, rpc: error` | RPC unreachable | Check `RPC_URL`, firewall, provider status |
| `health: degraded, db: error` | DB file locked/corrupt | Check disk space, file permissions (should be 0600) |

### Settlement failures

| Log message | Cause | Fix |
|-------------|-------|-----|
| `Gas price X gwei exceeds max Y gwei` | Gas spike | Wait or increase `MAX_GAS_PRICE_GWEI` |
| `Settlement rejected: gas cost exceeds fee` | Unprofitable trade | Increase `RELAYER_FEE` or lower gas threshold |
| `tx-retry wait timed out` | TX stuck in mempool | Will auto-retry; check RPC provider health |
| `maker order not found` | Cross-relayer race | Normal — order was matched by another relayer |

### Cross-relayer issues

| Symptom | Fix |
|---------|-----|
| No cross-relayer matches | Verify `SHARED_ORDERBOOK_URL` and `RELAYER_PUBLIC_URL` are set |
| Trade offers rejected | Check P2P authentication — both relayers must sign with their registered keys |
| Shared orderbook unreachable | Check `curl $SHARED_ORDERBOOK_URL/health` |

### Database issues

```bash
# Check DB file size
ls -lh zk-relayer.db*

# Verify integrity
sqlite3 zk-relayer.db "PRAGMA integrity_check;"

# Check pending orders (active path — Half-proof / authorize)
sqlite3 zk-relayer.db "SELECT COUNT(*) FROM authorize_orders WHERE status='pending';"

# Inspect legacy private_orders (archival only — see Tables section below)
sqlite3 zk-relayer.db "SELECT COUNT(*) FROM private_orders;"
```

---

## Database Management

### Tables

| Table | Purpose |
|-------|---------|
| `authorize_orders` | **Active** — Half-proof order persistence (the only intake path post-S-M14 / PR #215) |
| `private_orders` | **Legacy / archival** — Full-proof order history. The intake endpoint (`POST /api/private-orders`) is 410 Gone since PR #316; rows here are pre-migration history kept for stats. |
| `private_claims` | **Legacy / archival** — Claim payout distribution for legacy private orders. No own `status` column; join to `private_orders` for the order-level status. |
| `settled_claims_roots` | Prevents duplicate gasless claims |
| `pending_txs` | TX recovery on restart |
| `trade_offers` | Cross-relayer audit trail |
| `relayer_meta` | Runtime state (pause, fee, uptime) |

### Backup

```bash
# Hot backup (WAL mode safe)
sqlite3 zk-relayer.db ".backup /path/to/backup.db"
```

### Periodic Cleanup

The relayer auto-purges (all every 60s):
- Expired pending private orders from the in-memory orderbook
- Expired remote orders mirrored from the shared orderbook
- Non-pending/expired authorize orders

Separately, on-chain commitments are re-indexed every 5 minutes to stay in sync.

No manual cleanup needed for normal operation.

---

## Security Checklist

- [ ] `RELAYER_PRIVATE_KEY_FILE` used instead of env var
- [ ] Admin auth verified — connect the operator wallet via the console (admin endpoints reject unauthenticated requests with 401)
- [ ] HTTPS enabled on all public endpoints (reverse proxy)
- [ ] `CORS_ORIGINS` restricted to your frontend domain
- [ ] Database file permissions are 0600 (auto-set on startup)
- [ ] Separate wallet per relayer with minimal ETH balance
- [ ] `MAX_GAS_PRICE_GWEI` set to prevent gas drain attacks
- [ ] Firewall: only expose ports 3002 (API) and optionally 4000 (shared orderbook)
- [ ] P2P endpoints authenticated (auto via EIP-191 signature)
- [ ] Monitor `/health` endpoint with alerting

See [relayer-security.md](./relayer-security.md) for the full threat model.
