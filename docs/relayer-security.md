# Relayer Security Guide

## Overview

The zkScatter relayer operates as a trusted intermediary that holds users' private commitment data during order matching and settlement. This document covers the security model, threat vectors, and recommended mitigations for relayer operators.

## Trust Model

Users explicitly trust their chosen relayer with sensitive data when submitting orders. This is analogous to the Steam trading bot model — users delegate their items (commitment secrets) to a bot (relayer) for automated trading.

### Data Classification

| Data | Sensitivity | Location | Lifetime |
|------|------------|----------|----------|
| `ownerSecret` | **Critical** — proves commitment ownership | Memory + SQLite DB | Until settlement |
| `salt` | **Critical** — needed for ZK proof | Memory + SQLite DB | Until settlement |
| `balance` | **High** — reveals deposited amount | Memory + SQLite DB | Until settlement |
| `claims` (secrets, recipients) | **High** — defines payout structure | Memory + SQLite DB | Until all claims processed |
| EdDSA signature | Medium — order authentication | Memory + SQLite DB | Until settlement |
| `leafIndex` | Low — public on-chain | Memory + SQLite DB | Until settlement |
| Relayer private key | **Critical** — signs on-chain transactions | Environment variable / file | Permanent |

### What is NOT shared

The shared orderbook server only receives `OrderSummary` — a public subset:
- Token pair, amounts, price, expiry, nonce
- Relayer address and endpoint URL
- EdDSA public key (`pubKeyAx`)

**Never transmitted to the shared orderbook:** `ownerSecret`, `salt`, `balance`, `claims`, EdDSA private key, signatures.

## Threat Vectors

### 1. Malicious Relayer Operator

**Risk:** A relayer operator can read all user secrets in the database.

**Impact:** The operator could theoretically reconstruct ZK proofs to settle orders unfavorably or extract funds. However, the commitment pool's nullifier system prevents double-spending — once a commitment is settled, its nullifier is marked as spent on-chain.

**Mitigations:**
- Users should only use relayers they trust (reputation system in Phase 4)
- Settlement is atomic and on-chain — relayer cannot partially settle
- Fee is capped by `maxFee` set by the user
- Claims are cryptographically bound to the user's chosen recipients

### 2. Database Theft

**Risk:** An attacker gains access to the SQLite database file.

**Impact:** Exposure of all pending orders' secrets. Attacker could use these to front-run settlements if they also have the relayer's private key.

**Mitigations:**
- Encrypt the database at rest (SQLCipher or filesystem-level encryption)
- Restrict file permissions (`chmod 600 zk-relayer.db`)
- Use Docker volumes with appropriate access controls
- Delete secrets from DB after settlement completes (see below)

### 3. Trade Offer Interception

**Risk:** During cross-relayer matching, the taker's full order (including secrets) is transmitted to the maker's relayer via HTTP.

**Impact:** Man-in-the-middle could capture secrets.

**Mitigations:**
- **HTTPS is mandatory in production** — all relayer-to-relayer communication must use TLS
- EIP-191 signatures bind requests to specific method+path+URL, preventing replay
- Signatures include a timestamp with 5-minute expiry window

### 4. Shared Orderbook Server Compromise

**Risk:** Server is hacked or operated maliciously.

**Impact:** Limited — server only has public order summaries. No secrets. Attacker could:
- See all order flow (amounts, prices, timing) — information leakage
- Deny service (DoS) — relayers fall back to P2P mode
- Manipulate order visibility — suppress or inject fake orders

**Mitigations:**
- P2P fallback ensures trading continues if server is down
- Relayers verify all order data independently (EdDSA re-verification)
- Server cannot forge valid EdDSA signatures

### 5. Relayer Private Key Compromise

**Risk:** Attacker obtains the relayer's Ethereum private key.

**Impact:** Can submit fraudulent on-chain transactions, drain relayer's ETH balance, claim accumulated fees from FeeVault.

**Mitigations:**
- Use `RELAYER_PRIVATE_KEY_FILE` with Docker secrets (not environment variables)
- Store keys in HSM/KMS (AWS KMS, HashiCorp Vault) in production
- Use separate hot wallet with minimal balance for gas
- Monitor relayer address for unexpected transactions

## Production Deployment Checklist

### Mandatory

- [ ] **HTTPS everywhere** — relayer API, shared orderbook, P2P communication
- [ ] **Relayer key in secure storage** — Docker secrets, KMS, or HSM
- [ ] **Database file permissions** — `chmod 600`, owned by relayer process user
- [ ] **Rate limiting enabled** — default: 30 writes/min, 120 reads/min
- [ ] **CORS restricted** — only allow known frontend origins
- [ ] **Firewall rules** — restrict P2P port access to known relayer IPs
- [ ] **Monitoring** — alert on failed settlements, unusual order volume, key usage

### Recommended

- [ ] **Database encryption** — SQLCipher or LUKS-encrypted volume
- [ ] **Secret cleanup** — delete `ownerSecret`, `salt`, `balance` from DB after settlement
- [ ] **Separate gas wallet** — minimal ETH balance, auto-refill from cold wallet
- [ ] **Log sanitization** — ensure secrets are not logged (checked: current code does not log secrets)
- [ ] **Docker network isolation** — relayer, shared orderbook, and anvil on separate networks
- [ ] **Backup strategy** — DB backup (encrypted) for order recovery on crash

### Secret Cleanup After Settlement

Once an order is settled on-chain, the secrets are no longer needed. Implement a periodic cleanup:

```sql
-- Zero out secrets for settled orders (preserves order history)
UPDATE private_orders
SET owner_secret = '0', salt = '0', balance = '0'
WHERE status = 'settled' AND submitted_at < (strftime('%s','now') - 3600);

-- Delete claim secrets for settled orders
DELETE FROM private_claims
WHERE (pub_key_ax, nonce) IN (
  SELECT pub_key_ax, nonce FROM private_orders
  WHERE status = 'settled' AND submitted_at < (strftime('%s','now') - 3600)
);
```

## Docker Deployment Security

```yaml
# docker-compose.yml security hardening
services:
  zk-relayer:
    # Run as non-root user
    user: "1000:1000"
    # Read-only filesystem (except DB volume)
    read_only: true
    tmpfs:
      - /tmp
    volumes:
      - relayer-db:/data
    environment:
      DB_PATH: /data/zk-relayer.db
    # Use Docker secrets for private key
    secrets:
      - relayer_key
    # Limit resources
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '1.0'
    # No privileged access
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL

secrets:
  relayer_key:
    file: ./secrets/relayer-private-key.txt
```

## Cross-Relayer Communication Security

### Authentication Flow

All inter-relayer requests use EIP-191 signed messages:

```
Message format: "zkScatter-relay:{address}:{timestamp}:{METHOD}:{path}:{url}"
```

This binds the signature to:
- **Relayer identity** (Ethereum address)
- **Time** (5-minute window)
- **Request target** (method + path — prevents cross-endpoint replay)
- **Relayer URL** (prevents URL spoofing)

### Trade Offer Security

When a cross-relayer match occurs, the taker's full private order is sent to the maker's relayer:

1. **Sender authentication** — EIP-191 signature verified
2. **EdDSA re-verification** — settling relayer independently verifies taker's order signature
3. **Price/token/amount validation** — independent compatibility check
4. **Fee validation** — taker's maxFee must cover settling relayer's fee
5. **Expiry check** — both orders must not be expired
6. **Maker identification** — `(pubKeyAx, nonce)` composite key prevents collision attacks

### P2P Fallback Security

When the shared orderbook server is unavailable:
- Relayers communicate directly using cached peer lists
- Same EIP-191 authentication applies
- Cancel requests verify order ownership (order ID prefix check)
- Remote orders are validated (BigInt parsing, field completeness) before acceptance
