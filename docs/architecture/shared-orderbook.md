# Shared Orderbook: Relayer-to-Relayer Order Matching Protocol

> **Status**: Implemented and live (`shared-orderbook/` server +
> `zk-relayer` integration). This document describes the **current HTTP
> protocol**. The planned Waku gossip replacement is specced separately in
> [relayer-protocol/design.md](../design/relayer-protocol/design.md)
> (pre-implementation).
>
> **Half-proof update**: this protocol originally shipped against the legacy
> custodial flow, where users delegated commitment secrets to relayers and a
> "Trade Offer" carried witness data between relayers. That flow is **retired**
> (the `PrivateOrder` variant was removed post-S-M14). Today the orderbook
> carries summaries of **authorize (Half-proof) orders**: users prove their own
> side in the browser and hand the relayer a *proof*, never secrets. See
> [circuit-split/design.md](../design/circuit-split/design.md).

## Motivation

A maker and taker must reach the **same settlement transaction** for matching
to occur. If multiple relayers operate independently, liquidity is fragmented
— orders on Relayer A can't match with orders on Relayer B.

The shared orderbook enables cross-relayer matching with a strict division of
labor: relayers share **public listings** through a central bulletin board,
matching happens **locally on each relayer**, and settlement is coordinated
**directly relayer-to-relayer** (the Trade Offer). Private data never enters
the picture at any layer — even the user's *own* relayer holds only the
user's self-generated proof, never witness data.

## Architecture

### What is shared (public, on the orderbook)
- `chainId` (network-scoped book; defaults to Sepolia for legacy posts)
- Token pair (`sellToken` / `buyToken`)
- `sellAmount` / `buyAmount` (limit price)
- `maxFee` (bps) and `expiry`
- Relayer address + endpoint URL
- `id` — an **opaque 32-byte offer handle** (for authorize orders,
  `bytes32(nullifier)`). Deliberately unlinkable to the user's EdDSA pubkey.

### What never leaves the user's device
- `secret`, `salt`, `balance` — commitment preimage
- EdDSA private key
- Claim preimages (recipients, amounts, release times)

The relayer holds the user's **authorize proof + public signals**
(`AuthorizeOrderFile`), which is sufficient to settle and insufficient to
forge — every trade parameter is bound by the user's EdDSA-signed `orderHash`
inside the proof.

### Flow

```
┌─────────┐          ┌──────────────────┐          ┌─────────┐
│  User A │──proof──▶│   Relayer X      │          │  User B │
│ (maker) │ (browser │  (maker side)    │          │ (taker) │
└─────────┘  proving)│                  │          └────┬────┘
                     │ 1. Stores proof  │               │ proof
                     │ 2. Posts summary │          ┌────▼────┐
                     └────────┬─────────┘          │ Relayer │
                              │                    │    Y    │
                              ▼                    └────┬────┘
                     ┌──────────────────┐               │
                     │ Shared Orderbook │◀── 3. Posts summary
                     │ (listing only —  │               │
                     │  no matching)    │── 4. order:new broadcast
                     └──────────────────┘               │
                                                        ▼
                     5. Relayer Y finds a compatible local order
                        and sends a Trade Offer DIRECTLY to X:
                        POST /api/p2p/authorize-trade-offer
                        { makerNullifier, takerOrder (proof) }
                                                        │
                     ┌──────────────────┐               │
                     │ 6. Relayer X     │◀──────────────┘
                     │  validates taker │
                     │  proof + compat, │
                     │  calls           │
                     │  settleAuth(m,t) │
                     └──────────────────┘
```

### Step-by-step

1. **User A** generates an authorize proof in the browser and submits it to
   **Relayer X** (`POST /api/authorize-orders`). No secrets are transmitted.
2. **Relayer X** posts an order summary (no proof, no signals beyond the trade
   parameters) to the shared orderbook.
3. **User B** does the same on **Relayer Y**.
4. The server broadcasts `order:new`; each relayer's
   `AuthorizeCrossRelayerMatchService` scans its **local** orders for
   token/price compatibility.
5. On a hit, the local side acts as **taker** and sends a Trade Offer directly
   to the maker's relayer: `POST /api/p2p/authorize-trade-offer` with
   `{ makerNullifier, takerOrder }` — `takerOrder` is the taker's
   proof file, not witness data.
6. The **maker's relayer** re-validates the taker proof and the cross-side
   compatibility rules, then submits `settleAuth(makerProof, takerProof)`
   on-chain.
7. Both relayers mark the orders matched (`POST /api/orders/:id/matched`) and
   report the settlement to the server's stats/leaderboard endpoints.

**No user interaction after order submission** — the relayer already holds
everything needed to settle (the proof), and nothing it holds can be abused
beyond settling the exact signed order.

**Races**: both relayers may fire offers simultaneously. A local lock prevents
redundant attempts on the same order; the cross-relayer race is settled
deterministically on-chain — the loser's transaction reverts with
`NullifierAlreadySpent`.

### Settlement relayer

**The maker's relayer settles** (the taker side initiates the offer). This was
chosen over first-come / auction / round-robin alternatives for simplicity;
`settleAuth` itself accepts submission from either bound relayer, so the
protocol can evolve without a contract change.

### Fees

Fee handling is **trustless and per-side** (Phase 3.6, see below): each user's
EdDSA-signed `orderHash` binds their own relayer, and the contract routes
`feeTokenMaker` → maker's relayer and `feeTokenTaker` → taker's relayer. A
relayer cannot redirect the counterparty's fee.

The earlier idea of an off-chain "matching fee" owed between relayers is
**dead** — on-chain both fees route by proof. The Trade Offer *response* does
echo the taker-side fee (`takerFee`, `takerFeeToken`) so the taker's relayer
can record revenue in its local `fee_history` for leaderboard parity; this is
off-chain accounting only, no value transfer.

## Server API (implemented)

A REST/WebSocket bulletin board. **The server does not perform matching** —
each relayer matches locally against its own private orders. Writes require
signed relayer auth headers
(`x-relayer-address` / `x-relayer-signature` / `x-relayer-timestamp`, with
method + path + body-hash binding and a ±300 s window); reads are
rate-limited.

```
POST   /api/orders                        — post order summary (listing)
GET    /api/orders                        — list open orders (filters incl. chainId)
GET    /api/orders/:pair                  — orders for a token pair
DELETE /api/orders/:id                    — cancel (posting relayer only)
POST   /api/orders/:id/matched            — flip own open order to matched
POST   /api/relayers/register             — register relayer
POST   /api/relayers/heartbeat            — keep-alive ping
GET    /api/relayers                      — list active relayers
GET    /api/relayers/:address             — single relayer detail
GET    /api/peers                         — peer list for P2P fallback
GET    /api/stats                         — orderbook statistics
POST   /api/settlements                   — relayer reports a settlement
GET    /api/settlements                   — settlement feed
GET    /api/settlements/relayers/:addr/stats — per-relayer stats
GET    /api/settlements/network/totals    — network totals
GET    /api/settlements/leaderboard       — relayer leaderboard
GET    /api/commitments                   — Merkle-leaf range feed (commitment indexer)
POST   /api/kyc/submit, GET /api/kyc/status — relayer-operator KYC intake
/api/admin/*                              — SIWE-gated admin (audit log, verify stats)
GET    /health                            — liveness
WS     /ws/orders                         — real-time broadcast
```

**Order summary schema** (`OrderSummary` in `packages/types`):
```json
{
  "id": "0x…",                  // 32-byte hex offer handle (bytes32(nullifier))
  "chainId": 11155111,
  "relayer": "0x…",
  "relayerUrl": "https://relayer-x.example.com",
  "sellToken": "0x…",
  "buyToken": "0x…",
  "sellAmount": "1000000000000000000",
  "buyAmount": "2000000000000000000",
  "minFillAmount": "0",
  "maxFee": 30,
  "expiry": 1712624000,
  "createdAt": 1712537600
}
```

**WebSocket broadcast events** (`BroadcastEvent`):
```json
{ "type": "order:new", "order": { /* OrderSummary */ } }
{ "type": "order:cancelled", "orderId": "0x…", "relayer": "0x…" }
{ "type": "order:matched",   "orderId": "0x…", "relayer": "0x…" }
{ "type": "order:expired",   "orderId": "0x…" }
{ "type": "relayer:registered", "relayer": "0x…", "url": "https://…" }
{ "type": "relayer:offline",  "relayer": "0x…" }
```

> **Match notification is NOT sent by the server.** Relayers discover matches
> locally and coordinate directly via the P2P Trade Offer. `order:matched` is
> an after-the-fact status broadcast from the owning relayer, so other books
> can drop the listing (and the UI doesn't mis-render settled trades as
> "cancelled").

### P2P fallback

When the shared orderbook server is down, relayers exchange summaries
directly: `POST /api/p2p/orders` on each peer (discovered earlier via
`GET /api/peers`), same signed-header auth. The Trade Offer endpoint
(`/api/p2p/authorize-trade-offer`) is always direct relayer-to-relayer,
server up or not — the bulletin board is a discovery convenience, not a
dependency of settlement.

## Rollout history

- **Phase 1 — server MVP**: listing service, registration, heartbeat, WS.
- **Phase 2 — relayer integration** (PR #113): auto-post on receipt, local
  matching on remote arrival, direct Trade Offer, maker-relayer settlement.
- **Phase 3 — deployment** (PR #114, #115): Docker Compose, testnet guide,
  security checklist.
- **Phase 3.5 — frontend UX**: status panel, relayer-card orderbook state,
  Local/Global orderbook toggle, "Cross" badge on cross-relayer matches,
  submission notice.
- **Phase 3.6 — trustless fee split**: `orderHash` binds the user's relayer;
  public signals carry one `relayer` per side; the contract routes each side's
  fee to that side's relayer; only a bound relayer can submit.
- **Half-proof migration**: orderbook entries switched to authorize-order
  summaries keyed by offer handle; the witness-carrying `PrivateOrder` Trade
  Offer was retired (tracker #29).
- **Later additions**: per-network books (`chainId`), settlement
  reporting/leaderboard, commitment-indexer feed (`GET /api/commitments`),
  relayer KYC intake, SIWE admin surface.

### Phase 4: Decentralization (future)

Replace the central server with Waku v2 gossip + commit-reveal — specced in
[relayer-protocol/design.md](../design/relayer-protocol/design.md). The
on-chain-orderbook and libp2p alternatives mentioned in earlier drafts were
folded into that design.

## Security Considerations

1. **No witness exposure**: relayers hold proofs, not secrets. A malicious
   relayer can at worst settle the exact order the user signed (or refuse to —
   mitigated by [cancel](../design/circuit-split/design.md) §7). The legacy
   custodial threat model in
   [relayer-security.md](../operations/relayer-security.md) §1–§3 no longer
   applies to this path.
2. **Relayer impersonation**: all writes (server and P2P) carry relayer
   signatures with method/path/body-hash binding and a timestamp window;
   order mutation (`DELETE`, `:id/matched`) is restricted to the posting
   relayer.
3. **Order front-running**: summaries are public — but settlement requires the
   bound relayer's submission and the user-signed proof, so an observer cannot
   steal a match; at worst they learn trade intent.
4. **Linkability**: the offer handle is opaque (`bytes32(nullifier)`) and the
   summary contains no per-trader-stable value, consistent with D1.
5. **DoS**: per-route rate limiting + per-relayer write limits.
6. **Stale orders**: automatic expiry + relayer heartbeats (`relayer:offline`
   broadcast on stale heartbeat).

## Non-Goals (for now)

- Partial fills (`minFillAmount` is carried in the schema but matching and
  settlement are all-or-nothing)
- Multi-relayer settlement (splitting one settlement across >2 relayers)
- On-chain orderbook
- Encrypted order summaries
