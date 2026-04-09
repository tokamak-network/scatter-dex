# Shared Orderbook: Relayer-to-Relayer Order Matching Protocol

## Motivation

Currently, a maker and taker must submit orders to the **same relayer** for matching to occur. If multiple relayers operate independently, liquidity is fragmented — orders on Relayer A can't match with orders on Relayer B.

This design document proposes a **shared orderbook** that enables cross-relayer matching, modeled after the Steam trading bot ecosystem.

## Reference: Steam Trading Bot Ecosystem

Steam bots trade game items (CS2 skins, etc.) through centralized marketplaces:

| Component | Steam | zkScatter (proposed) |
|-----------|-------|---------------------|
| Central market | CSGOFloat, Buff163 | Shared Orderbook Server |
| Bot | Trading bot (per operator) | Relayer (per operator) |
| Item listing | Bot registers inventory via API | Relayer posts order summary via API |
| Matching | Market matches buyer/seller | Orderbook matches maker/taker |
| Settlement | Steam Trade Offer | settlePrivate() with ZK proof |
| Fee | Market takes 2-5% | FeeVault (platform fee on claim) |
| Escrow | Steam Guard holds items | CommitmentPool holds commitments |

Key insight: Steam bots don't share private inventory data with each other. They share **public listings** through a central market, and settlement happens via Steam's **Trade Offer protocol**.

## Architecture

### What is shared (public)
- Token pair (e.g., WETH → USDC)
- Amount / price
- Order direction (buy/sell)
- Expiry time
- Relayer address + endpoint URL
- Order ID (nonce)

### What stays private (per-relayer)
- `ownerSecret`, `salt`, `balance` — commitment secrets
- EdDSA private key
- Claims structure (recipients, amounts, release times)

### Flow

```
┌─────────┐         ┌──────────────────┐         ┌─────────┐
│  User A │─secret──│   Relayer X      │         │  User B │
│ (maker) │         │                  │         │ (taker) │
└─────────┘         │  1. Receives     │         └─────────┘
                    │     full order   │              │
                    │  2. Posts summary│              │
                    │     to shared    │              │
                    │     orderbook    │         ┌─────────┐
                    └────────┬─────────┘         │ Relayer │
                             │                   │    Y    │
                             ▼                   └────┬────┘
                    ┌──────────────────┐              │
                    │  Shared Orderbook│◄─── 3. Posts summary
                    │     Server       │
                    │                  │
                    │  4. Match found! │
                    │     Notify X & Y │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │  5. Settlement   │
                    │  Relayer decided │
                    │  (X or Y)        │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │  6. Users send   │
                    │  secrets to the  │
                    │  settling relayer│
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │  7. ZK proof     │
                    │  generated +     │
                    │  on-chain settle │
                    └──────────────────┘
```

### Step-by-step

1. **User A** submits full order (with secrets) to **Relayer X**
2. **Relayer X** posts order summary (no secrets) to **Shared Orderbook**
3. **User B** submits full order (with secrets) to **Relayer Y**
4. **Relayer Y** posts order summary → Shared Orderbook detects match
5. Shared Orderbook notifies both relayers: "Match found"
6. **Settlement relayer** is determined (see below)
7. Both users are notified: "Send your secrets to [settling relayer]"
8. Users send secrets to the settling relayer
9. Settling relayer generates ZK proof and calls `settlePrivate()`
10. Fee goes to FeeVault → settling relayer claims, shares with matching relayer

### Settlement Relayer Selection

Options:
- **First-come**: whoever claims the match first settles
- **Maker's relayer**: maker's relayer always settles (maker has priority)
- **Auction**: relayers bid on settlement right (lowest fee wins)
- **Round-robin**: alternate between matched relayers

Recommended start: **Maker's relayer settles** (simplest, maker already trusts their relayer with secrets).

### Fee Sharing

When Relayer X settles a match that Relayer Y found:
- Settlement fee goes to FeeVault credited to Relayer X
- Relayer X owes Relayer Y a **matching fee** (off-chain or on-chain split)

Options:
- Off-chain settlement between relayers (simple, trust-based)
- FeeVault split: credit both relayers proportionally (requires contract change)
- Matching bounty: fixed reward for the relayer that found the match

## Implementation Plan

### Phase 1: Shared Orderbook Server (MVP)

A REST/WebSocket server acting as a bulletin board. **The server does not perform matching** — each relayer matches locally against its own private orders (see Steam bot model above).

```
POST   /api/orders              — post order summary (listing)
GET    /api/orders              — list open orders (with filters)
GET    /api/orders/:pair        — orders for a specific token pair
DELETE /api/orders/:id          — cancel/expire order
POST   /api/relayers/register   — register relayer (with heartbeat)
POST   /api/relayers/heartbeat  — keep-alive ping
GET    /api/relayers            — list active relayers
GET    /api/peers               — peer list for P2P fallback
GET    /api/stats               — orderbook statistics
WS     /ws/orders               — real-time order/cancel broadcast
```

> **Note:** The original design included `POST /api/match` for server-initiated matching. This was removed in favor of relayer-side matching — the server is a pure listing service, not a matchmaker.

**Order Summary Schema:**
```json
{
  "id": "relayer-nonce",
  "relayer": "0x...",
  "relayerUrl": "https://relayer-x.example.com",
  "sellToken": "0x...",
  "buyToken": "0x...",
  "sellAmount": "1000000000000000000",
  "buyAmount": "2000000000000000000",
  "minFillAmount": "500000000000000000",
  "maxFee": 30,
  "expiry": 1712624000,
  "createdAt": 1712537600
}
```

**WebSocket Broadcast Events:**
```json
// New order posted
{ "type": "order:new", "order": { /* OrderSummary */ } }

// Order cancelled
{ "type": "order:cancelled", "orderId": "0x...-nonce", "relayer": "0x..." }

// Relayer joined
{ "type": "relayer:registered", "relayer": "0x...", "url": "https://..." }

// Relayer went offline (stale heartbeat)
{ "type": "relayer:offline", "relayer": "0x..." }
```

> **Match notification is NOT sent by the server.** Relayers discover matches locally and coordinate directly via P2P (Trade Offer pattern).

### Phase 2: Relayer Integration

Each relayer adds:
1. On order receipt → POST summary to shared orderbook
2. On match notification → notify user "send secrets to settling relayer"
3. On receiving secrets from remote user → generate proof + settle

### Phase 3: User Experience

Frontend changes:
1. User selects relayer as before
2. If match is cross-relayer, UI shows: "Your order matched via [Relayer Y]. Approve secret transfer to [settling relayer]?"
3. User confirms → secrets sent to settling relayer
4. Settlement proceeds normally

### Phase 4: Decentralization (future)

Replace central server with:
- P2P gossip (libp2p)
- On-chain orderbook (L2 only, due to gas)
- Hybrid: on-chain order hashes + off-chain data

## Security Considerations

1. **Secret exposure**: Users must explicitly approve sending secrets to a new relayer
2. **Relayer impersonation**: Shared orderbook must verify relayer identity (signed messages or on-chain registry check)
3. **Order front-running**: Order summaries are public — MEV bots could front-run. Mitigated by relayer binding in ZK proof
4. **DoS**: Rate limiting on shared orderbook API
5. **Stale orders**: Automatic expiry + heartbeat from relayers

## Non-Goals (for now)

- Partial fills (matching part of an order)
- Multi-relayer settlement (splitting proof generation across relayers)
- On-chain orderbook
- Encrypted order summaries
