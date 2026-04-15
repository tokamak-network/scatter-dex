# Fee Architecture: Limit Orders vs Market Orders

> Last updated: 2026-04-11

zkScatter has two distinct fee models for its two order types.

## Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        zkScatter Fee Flow                           │
│                                                                     │
│  ┌──────────────┐         ┌──────────────┐       ┌───────────────┐ │
│  │ Limit Order  │────────>│   Relayer    │──────>│   FeeVault    │ │
│  │ (settleAuth) │  fee    │  (collects)  │deposit│ (holds until  │ │
│  └──────────────┘         └──────────────┘       │  claim)       │ │
│                                                   └───────┬───────┘ │
│                                                    claim  │         │
│                                                   ┌───────▼───────┐ │
│  ┌──────────────┐                                 │   Relayer     │ │
│  │ Market Order │──── platform fee ──────────────>│   receives    │ │
│  │(settleWithDex│      (sellToken)                │   (100 - X)%  │ │
│  └──────┬───────┘                                 └───────┬───────┘ │
│         │                                          X% fee │         │
│         └── surplus ──────────────────────────────────────▼─────── │
│              (buyToken)                            ┌──────────────┐ │
│                                                    │   Treasury   │ │
│                                                    └──────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

## 1. Limit Order Fees (settleAuth)

**When**: Two users match via a relayer (P2P).

**Flow**:
1. User signs `maxFee` (bps) in their authorize proof — this is the maximum relay fee they accept.
2. Relayer submits `settleAuth(maker, taker, feeTokenMaker, feeTokenTaker)`.
3. Fee is deducted from the counterparty's sellAmount:
   - `feeTokenMaker` (in maker's buyToken) → paid to taker's relayer
   - `feeTokenTaker` (in taker's buyToken) → paid to maker's relayer
4. Fee goes to `FeeVault.deposit(relayer, token, amount)`.
5. When relayer calls `FeeVault.claim(token)`:
   - `platformFeeBps` (e.g. 10%) is deducted → sent to **treasury**
   - Remainder → sent to **relayer**

**On-chain events**:
- `FeeClaimed(relayer, token, relayerAmount, platformFee)` — emitted at claim time

**Key properties**:
- Fee is denominated in **buyToken** (the counterparty's sell token)
- Platform takes a cut of the relayer's earnings, not directly from the user
- Fee is **deferred** — treasury receives it only when the relayer claims

### Contract references

| Contract | Function | Role |
|----------|----------|------|
| `PrivateSettlement.sol` | `settleAuth()` lines 648-655 | Deducts fee from counterparty's sellAmount |
| `PrivateSettlement.sol` | `_routeFeeFromPoolTo()` | Routes fee from pool → FeeVault |
| `FeeVault.sol` | `deposit()` | Credits relayer balance |
| `FeeVault.sol` | `claim()` | Splits: relayer + platformFee → treasury |

---

## 2. Market Order Fees (settleWithDex)

**When**: User swaps directly via external DEX (Uniswap, Curve, etc.). No relayer.

**Flow**:
1. Owner sets `dexPlatformFeeBps` (e.g. 100 = 1%, max 500 = 5%).
2. User calls `settleWithDex(proof, dexRouter, dexCalldata)`.
3. Platform fee = `sellAmount × dexPlatformFeeBps / 10000`.
4. Fee is deducted from sellAmount **before** the DEX swap:
   - `platformFee` → sent directly to `feeVault.treasury()` in **sellToken**
   - `swapAmount = sellAmount - platformFee` → approved to DEX router
5. DEX swap executes: sellToken → buyToken.
6. If `amountOut > totalLocked` (positive slippage):
   - Surplus → sent directly to `feeVault.treasury()` in **buyToken**
   - Claims receive exactly `totalLocked`

**On-chain events**:
- `DexPlatformFeeCollected(nullifier, token, amount, treasury)` — emitted immediately at settle time
- `SettledWithDex(..., amountOut, totalLocked)` — surplus = `amountOut - totalLocked`

**Key properties**:
- Fee is denominated in **sellToken** (pre-swap deduction)
- Surplus is denominated in **buyToken** (post-swap excess)
- Both go directly to treasury — no intermediate deposit/claim step
- Fee is **immediate** — treasury receives it in the same transaction

### Contract references

| Contract | Function | Role |
|----------|----------|------|
| `PrivateSettlement.sol` | `settleWithDex()` lines 888-900 | Deducts fee, sends to treasury |
| `PrivateSettlement.sol` | `setDexPlatformFee()` | Owner sets fee rate (0-500 bps) |
| `PrivateSettlement.sol` | `MAX_DEX_PLATFORM_FEE_BPS` | Constant: 500 (5% cap) |

---

## 3. Fee Comparison

| | Limit Order | Market Order |
|---|-------------|--------------|
| **Fee source** | Counterparty's sellAmount | User's own sellAmount |
| **Fee token** | buyToken | sellToken |
| **Who pays** | Counterparty (indirectly) | User (directly) |
| **Intermediary** | Relayer → FeeVault → claim | None (direct to treasury) |
| **Timing** | Deferred (at relayer claim) | Immediate (at settle) |
| **Platform cut** | % of relayer fee (`FeeVault.platformFeeBps`) | Fixed bps (`dexPlatformFeeBps`) |
| **Surplus** | N/A (exact P2P match) | Positive slippage → treasury |
| **Config** | `FeeVault.platformFeeBps` | `PrivateSettlement.dexPlatformFeeBps` |
| **Max** | `FeeVault.MAX_PLATFORM_FEE` | 500 bps (5%) |

---

## 4. Revenue Tracking (Off-chain)

### Total platform revenue

```
Total = Σ FeeClaimed.platformFee     (limit order revenue, per relayer claim)
      + Σ DexPlatformFeeCollected.amount  (market order revenue, per trade)
      + Σ (SettledWithDex.amountOut - SettledWithDex.totalLocked)  (surplus, per trade)
```

### Event-based indexing

| Event | Source | Revenue Type |
|-------|--------|-------------|
| `FeeClaimed(relayer, token, amount, platformFee)` | FeeVault | Limit order platform cut |
| `DexPlatformFeeCollected(nullifier, token, amount, treasury)` | PrivateSettlement | Market order platform fee |
| `SettledWithDex(..., amountOut, totalLocked)` | PrivateSettlement | Market order surplus |

### Example The Graph query

```graphql
# Limit order platform revenue (last 7 days)
{
  feeClaims(where: { timestamp_gt: $weekAgo, platformFee_gt: "0" }) {
    token { symbol }
    platformFee
  }
}

# Market order platform revenue (last 7 days)
{
  dexPlatformFeeCollecteds(where: { blockTimestamp_gt: $weekAgo }) {
    token
    amount
  }
}
```

---

## 5. Configuration Guide

### Setting limit order platform fee (FeeVault)

```solidity
// Owner of FeeVault
feeVault.setPlatformFee(1000); // 10% of relayer earnings
feeVault.setTreasury(treasuryAddress);
```

### Setting market order platform fee (PrivateSettlement)

```solidity
// Owner of PrivateSettlement
settlement.setDexPlatformFee(100); // 1% of sellAmount
// Treasury is read from feeVault.treasury() — must set FeeVault first
settlement.setFeeVault(feeVaultAddress);
```

### Whitelisting DEX routers

```solidity
// Uniswap V3 SwapRouter02
settlement.setDexRouterWhitelist(0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45, true);
// Curve 3pool
settlement.setDexRouterWhitelist(0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7, true);
```
