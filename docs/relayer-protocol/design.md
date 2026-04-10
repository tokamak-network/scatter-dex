# Relayer Communication Protocol: Federated P2P Matching & Fair Exchange

> **Status**: Design reference (pre-implementation)
> **Scope**: Protocol specification for relayer-to-relayer communication in the federated zkScatter network. Replaces (or evolves) the current HTTP-based Trade Offer protocol with a Waku v2-based commit-reveal exchange.
> **Related docs**:
> - [../design-shared-orderbook.md](../design-shared-orderbook.md) — current Trade Offer protocol (HTTP-based, Phase 2/3.6, already implemented)
> - [../dispute-registry/design.md](../dispute-registry/design.md) — dispute resolution that depends on this protocol's commit-reveal messages
> - [../relayer-security.md](../relayer-security.md) — operational threat model
> - [../PAPER.md](../PAPER.md) — compliance and trust model
> - [../../contracts/src/RelayerRegistry.sol](../../contracts/src/RelayerRegistry.sol) — relayer discovery and bond
> - [../../contracts/src/zk/PrivateSettlement.sol](../../contracts/src/zk/PrivateSettlement.sol) — on-chain settlement target

## 1. Motivation

### 1.1 What exists today

The current zkScatter relayer network already has:

- **Shared Orderbook server** (`shared-orderbook/`) — a central bulletin board where relayers post public order summaries and discover cross-relayer matches. See [../design-shared-orderbook.md](../design-shared-orderbook.md) §Phase 1.
- **HTTP Trade Offer protocol** — when a match is detected, the taker's relayer sends the **full order (with secrets)** to the maker's relayer over HTTPS. The maker's relayer re-verifies the EdDSA signature, generates the settlement proof, and submits on-chain. See [../design-shared-orderbook.md](../design-shared-orderbook.md) §Phase 2, §Phase 3.6.
- **Trustless fee split** (Phase 3.6, implemented) — `makerRelayer` and `takerRelayer` are bound in the ZK proof via `orderHash`. Either relayer can submit, but neither can redirect the other's fee.

### 1.2 What is missing

The current protocol has three structural problems that this document addresses:

1. **Secrets cross the relayer boundary in plaintext.** The Trade Offer transmits the full order, including `ownerSecret`, `salt`, and `balance`, between relayers. Even with TLS, this creates a trust surface described in [../relayer-security.md](../relayer-security.md) §3 (Trade Offer interception) and §1 (malicious relayer operator).
2. **No cryptographic commitment to a trade.** The taker's relayer can send a Trade Offer and the maker's relayer can simply ignore it without on-chain evidence. "Aborting" is indistinguishable from "never received it". See [../dispute-registry/design.md](../dispute-registry/design.md) §"What has NOT shifted yet".
3. **Central shared orderbook is a single point of failure.** The current implementation acknowledges this (§"Phase 4: Decentralization (future)") and proposes libp2p as the replacement. This doc specifies Waku v2 as the concrete transport.

### 1.3 What this document specifies

- The **message schema** for relayer-to-relayer communication over Waku v2
- The **state machine** each order traverses from submission to settlement or termination
- The **inventory model** relayers use to track locally-held proofs
- The **matching assignment rule** that prevents double-matching across the federation
- The **protocol versioning** strategy for forward/backward compatibility
- **Security analysis** of the protocol under the federated trust model

This document does **not** specify:
- The actual circuit split (`maker_order.circom`, `taker_match.circom`) — that is a separate document
- The dispute resolution contract and evidence validation — see [../dispute-registry/design.md](../dispute-registry/design.md)
- User-facing UX flows — see [../zk-private-trading.md](../zk-private-trading.md)

### 1.4 Architectural prerequisites

This protocol assumes the two architectural shifts listed in [../dispute-registry/design.md](../dispute-registry/design.md) §"Architectural prerequisites for this design":

1. **Client-side proving split** — users generate proofs locally, relayers only hold public proofs
2. **Federated orderbook over gossip** — no central shared orderbook server (or the server becomes a libp2p/Waku bootstrap node, not a matching authority)

Without these shifts, the commit-reveal messages in this document cannot carry the privacy guarantees they promise.

## 2. Reference Model: Steam Trading Bot Ecosystem

zkScatter's federated relayer network is modeled after the **Steam trading bot ecosystem** (DMarket, Skinport, CS.Money, CSGOFloat, Buff163). The Steam analogy is already used in [../design-shared-orderbook.md](../design-shared-orderbook.md) §"Reference: Steam Trading Bot Ecosystem". This document deepens that analogy to cover the cross-bot communication layer — the part Steam handles centrally through the Valve API but that zkScatter must do decentralized.

### 2.1 What Steam does that we copy

```
┌─ User ─────┐
│            │   Trade Offer
│  Seller    │───────────────┐
└────────────┘               │
                             ▼
                      ┌──────────────┐     Bot-to-Bot
                      │   Bot_A      │◄────── Exchange ──────┐
                      │  (inventory) │                        │
                      └──────┬───────┘                        │
                             │                         ┌──────┴───────┐
                             │ List                    │    Bot_B     │
                             ▼                         │  (inventory) │
                      ┌──────────────┐                 └──────┬───────┘
                      │  Marketplace │◄─── Buy order ─────────┘
                      │  (orderbook) │
                      └──────┬───────┘
                             │
                             ▼
                      Settlement via Steam Trade Offer
                      (atomic swap guaranteed by Steam)
```

| Steam trading bot pattern | zkScatter analog |
|---|---|
| Bot holds item "inventory" | Relayer holds order "inventory" (public proofs, not witness data) |
| Trade Offer API (propose/accept/confirm) | Waku message-based commit-reveal protocol |
| Inter-bot inventory balancing trades | Cross-relayer fair exchange |
| Per-bot API endpoint + rate limit | Per-relayer Waku content topic + RLN |
| Order states: pending/active/traded/expired | Order state machine (see §5) |
| Multi-bot parallel operation | Federated relayer network |
| SteamWeb API style standardization | Standard Waku protocol schemas (protobuf) |
| Trade Offer expiry + auto-cancel | Proof expiry + auto-refund |

### 2.2 What Steam does that we explicitly avoid

The Steam bot model has structural weaknesses that a decentralized, non-custodial DEX must not inherit:

| Steam weakness | zkScatter improvement |
|---|---|
| Bots are custodial (hold items) | Relayers hold only proofs; funds stay in `CommitmentPool` |
| Bot operators can exit-scam | Public dispute records + dual-CA identity → loss of users → loss of fees ([../dispute-registry/design.md](../dispute-registry/design.md)) |
| Bot-to-bot trust is informal | Fair exchange protocol + on-chain dispute resolution |
| API specs fragmented per company | Single standard Waku protocol (this document) |
| Centralization (one operator runs many bots) | Federation gated by `RelayerRegistry` with public bond |
| No audit trail of failed trades | Commit-reveal messages are signed, dispute-filable on-chain |
| Marketplace is a central party | Orderbook is gossiped over Waku, no central matcher |

### 2.3 The key insight

From [../design-shared-orderbook.md](../design-shared-orderbook.md) lines 22-23:

> Steam bots don't share private inventory data with each other. They share **public listings** through a central market, and settlement happens via Steam's **Trade Offer protocol**.

zkScatter's evolution of this idea:

> zkScatter relayers don't share private witness data with each other. They share **public order summaries + ZK proofs** through a **gossip network**, and settlement happens via a **commit-reveal fair exchange + on-chain ZK settlement** — eliminating both the "central market" trust requirement and the custodial "bot trust" requirement.

## 3. Architecture Overview

### 3.1 Network topology

```
          ┌─────────────────────────────────────────────────────┐
          │        Waku v2 gossip network (public topics)       │
          │                                                     │
          │   /zkscatter/1/orderbook/proto                      │
          │   /zkscatter/1/heartbeat/proto                      │
          └───────────────────┬─────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ▼               ▼               ▼
       ┌─────────┐      ┌─────────┐      ┌─────────┐
       │Relayer A│      │Relayer B│      │Relayer C│
       └────┬────┘      └────┬────┘      └────┬────┘
            │                │                │
            │    Direct encrypted messages   │
            │    /zkscatter/1/match/<id>/    │
            ◄────────────────┼────────────────▶
                             │
                             ▼
                    ┌─────────────────┐
                    │ PrivateSettle-  │
                    │    ment.sol     │
                    └─────────────────┘

    Users submit proofs to their chosen relayer and go offline.
```

### 3.2 Roles

- **User (maker/taker)**: generates ZK proof locally in browser (via rapidsnark-wasm), submits proof + fee to a chosen relayer over HTTPS. Can go offline immediately after submission.
- **Relayer**: registered in `RelayerRegistry` with a bond. Gossips orders, negotiates matches with peers, holds proofs locally, executes commit-reveal, submits settlement on-chain, collects fees.
- **Third-party observer / watchdog**: subscribes to gossip topics, archives commit messages, can record disputes on-chain if it observes abort behavior. Anyone can record; the contract is permissionless (see [../dispute-registry/design.md](../dispute-registry/design.md)).

### 3.3 Communication surfaces

Three distinct communication channels, each with different confidentiality and reliability needs:

| Channel | Transport | Cardinality | Payload |
|---|---|---|---|
| User → Relayer | HTTPS | 1:1 | Proof + order metadata + fee |
| Relayer → Relayer (public) | Waku gossip | 1:N | Order announcements, heartbeats |
| Relayer → Relayer (direct) | Waku direct or libp2p | 1:1 | Match negotiation, commit-reveal, settlement coordination |
| Relayer → Chain | Ethereum RPC | 1:1 | `settlePrivate` tx |

### 3.4 Trust boundaries

- **User trusts their chosen relayer** with the single proof they submit (not with witnesses — those never leave the user's browser)
- **Relayers do not trust each other**, but they trust:
  - EIP-712 signatures (cryptographic)
  - `RelayerRegistry` bond status (economic)
  - `DisputeRegistry` cryptographic recording → reputation pressure (no slashing)
  - Waku v2 transport integrity (protocol-level)
- **No party trusts** the shared orderbook server (deprecated in this model — only optional as a bootstrap discovery node)

## 4. Message Types

All messages are protobuf-encoded with EIP-712 typed signatures where specified. Messages carry `protocolVersion` in the envelope.

### 4.1 Envelope

```protobuf
message RelayerMessage {
  uint32 protocol_version = 1;    // e.g., 1
  uint64 timestamp_ms = 2;        // sender's clock; validated against clock skew window
  bytes sender_relayer_id = 3;    // Ethereum address, 20 bytes
  MessageType type = 4;
  bytes payload = 5;              // type-specific protobuf
  bytes signature = 6;            // EIP-712 over (type, payload, timestamp_ms, sender_relayer_id)
}

enum MessageType {
  // Gossip messages
  ORDER_ANNOUNCE = 0;
  ORDER_CANCEL = 1;
  RELAYER_HEARTBEAT = 2;

  // Direct messages (point-to-point between two relayers)
  MATCH_PROPOSE = 10;
  MATCH_ACCEPT = 11;
  MATCH_REJECT = 12;
  COMMIT = 13;
  REVEAL = 14;
  SETTLE_NOTICE = 15;
  DISPUTE_CLAIM = 16;
  STATE_SYNC_REQUEST = 17;
  STATE_SYNC_RESPONSE = 18;
}
```

### 4.2 Gossip messages

Broadcast to all federated relayers via Waku gossip. Contain only public data.

#### `ORDER_ANNOUNCE`
```protobuf
message OrderAnnounce {
  bytes order_id = 1;           // 32-byte canonical order id
  bytes pair = 2;               // H(sellToken || buyToken)
  Side side = 3;                // BUY or SELL
  uint256 price = 4;            // uint256 fixed-point
  uint256 amount = 5;           // uint256 base units
  uint64 expiry = 6;            // unix seconds
  bytes maker_relayer = 7;      // 20-byte Ethereum address of the holding relayer
  bytes maker_pubkey = 8;       // EdDSA pubkey used for order auth
  bytes merkle_root = 9;        // commitment pool root used by the proof
  // NOTE: no proof, no nullifier, no witness data
}
```

#### `ORDER_CANCEL`
```protobuf
message OrderCancel {
  bytes order_id = 1;
  bytes reason = 2;             // optional, enum string
}
```
Cancels must be signed by the maker_relayer that originally announced the order. Other relayers refuse to remove the order from their local inventory without a valid signature.

#### `RELAYER_HEARTBEAT`
```protobuf
message RelayerHeartbeat {
  bytes relayer_id = 1;
  string endpoint_url = 2;      // human-readable, for debugging
  repeated bytes supported_pairs = 3;
  uint32 active_orders = 4;
  uint64 uptime_since = 5;
  bytes waku_peer_id = 6;       // libp2p peer id for direct messaging
}
```
Sent at a fixed interval (suggested: every 30s). Absence of heartbeat for N intervals triggers timeout detection by peers.

### 4.3 Direct messages

Point-to-point between two relayers. Encrypted end-to-end (ephemeral X25519 session established via initial handshake) even though transport (Waku) already encrypts at the network layer.

#### `MATCH_PROPOSE`
Sent by a relayer that found a match against a peer's order.
```protobuf
message MatchPropose {
  bytes order_id = 1;           // maker's order
  bytes proposer_relayer = 2;   // my relayer id (taker side)
  bytes taker_order_id = 3;     // my local order id
  uint256 matched_price = 4;
  uint256 matched_amount = 5;
  uint64 proposal_nonce = 6;    // monotonic per (proposer, maker) pair
  uint64 expires_at = 7;        // if no ACCEPT/REJECT before this, auto-cancel
}
```

#### `MATCH_ACCEPT` / `MATCH_REJECT`
```protobuf
message MatchAccept {
  bytes proposal_nonce = 1;     // echo of MatchPropose.proposal_nonce
  uint64 round_id = 2;          // new round_id for the subsequent commit-reveal
}

message MatchReject {
  bytes proposal_nonce = 1;
  RejectReason reason = 2;
}

enum RejectReason {
  ORDER_ALREADY_MATCHED = 0;
  ORDER_EXPIRED = 1;
  PRICE_MISMATCH = 2;
  AMOUNT_INSUFFICIENT = 3;
  POLICY_DENIED = 4;
  UNKNOWN = 99;
}
```

#### `COMMIT`
**This is the normative commit message referenced by [../dispute-registry/design.md](../dispute-registry/design.md) §"Evidence Schemas".** It is the cryptographic anchor for dispute evidence.

```protobuf
message Commit {
  bytes relayer = 1;            // committing relayer id (20 bytes)
  bytes order_id = 2;
  bytes commit_hash = 3;        // H(proof_bytes || salt), 32 bytes
  uint64 round_id = 4;          // monotonic per counterparty pair
  uint64 commit_time = 5;       // unix seconds
  uint64 reveal_deadline = 6;   // commit_time + REVEAL_WINDOW
  bytes counterparty_id = 7;    // H(counterparty_relayer || round_id)
  uint32 protocol_version = 8;
  bytes eip712_signature = 9;   // signed over all above fields
}
```
The EIP-712 typed data domain must match the `DisputeRegistry` contract's expected domain (`zkScatterDisputeRegistry` v1) so that the same signature is valid both off-chain and on-chain for dispute evidence.

#### `REVEAL`
```protobuf
message Reveal {
  bytes relayer = 1;
  bytes order_id = 2;
  bytes commit_hash = 3;        // must match the prior COMMIT's commit_hash
  bytes proof_bytes = 4;        // the actual ZK proof being revealed
  bytes salt = 5;               // used to open the commitment
  uint64 reveal_time = 6;
  bytes eip712_signature = 7;
}
```
**REVEAL is also signed** — this is required for the dispute registry's Type 2 (reveal/commit mismatch) detection. Without a signed reveal, the registry cannot prove the accused actually revealed the wrong proof. The signature binds the revealer to the specific proof+salt pair.

#### `SETTLE_NOTICE`
Informational notice that a settlement transaction has been submitted. Not required for the protocol's correctness but useful for off-chain indexing and dispute timeline reconstruction.
```protobuf
message SettleNotice {
  bytes order_id = 1;
  bytes tx_hash = 2;
  uint64 block_number = 3;      // may be 0 if not yet mined
  bytes submitter = 4;          // relayer that actually called settlePrivate
}
```

#### `DISPUTE_CLAIM`
Off-chain announcement that a dispute has been raised on-chain. Allows peers to update local state and stop relaying the disputed order.
```protobuf
message DisputeClaim {
  bytes dispute_id = 1;
  bytes accuser = 2;
  bytes accused = 3;
  DisputeType dtype = 4;
  bytes on_chain_tx = 5;        // tx hash of raiseAbortDispute() etc.
}
```

#### `STATE_SYNC_REQUEST` / `STATE_SYNC_RESPONSE`
Used after a relayer restart. New relayer requests the current orderbook state from one or more peers.
```protobuf
message StateSyncRequest {
  uint64 from_timestamp_ms = 1;
  repeated bytes interested_pairs = 2;
}

message StateSyncResponse {
  repeated OrderAnnounce orders = 1;
  repeated RelayerHeartbeat relayers = 2;
  uint64 snapshot_at_ms = 3;
}
```

### 4.4 Message validation pipeline

Every received message is validated in this order, and rejected on first failure:

1. **Decode** — valid protobuf under the declared `MessageType`
2. **Protocol version** — within the receiving relayer's supported range
3. **Timestamp skew** — `|now - timestamp_ms| ≤ MAX_CLOCK_SKEW` (5 min, aligned with `PrivateSettlement.TIMESTAMP_TOLERANCE`)
4. **Signature** — EIP-712 recover matches `sender_relayer_id`
5. **Sender liveness** — `sender_relayer_id` is an active relayer in `RelayerRegistry`
6. **Type-specific validation** — e.g., `COMMIT.reveal_deadline > commit_time`, `ORDER_ANNOUNCE.expiry > now`
7. **Deduplication** — not a replay of a previously-processed message
8. **Policy checks** — rate limits, whitelist, blacklist
9. **State transition** — if all pass, apply to local state (§5)

## 5. State Machine

Each order traverses a deterministic state machine. The state is tracked locally by **every relayer that holds the order** (the holder) and replicated as public gossip (for `SUBMITTED` → `OPEN` → terminal transitions only).

### 5.1 States

```
SUBMITTED
  │    (user → holder relayer; proof verified locally)
  ▼
PENDING
  │    (proof validated, preparing for gossip)
  ▼
OPEN
  │    (order announced to federation; waiting for matches)
  ▼
PROPOSED
  │    (a peer sent MATCH_PROPOSE; we accepted)
  ▼
COMMITTED
  │    (both sides sent COMMIT; entering reveal window)
  ▼
REVEALED
  │    (both sides sent REVEAL within window; proofs ready)
  ▼
SETTLING
  │    (settlePrivate tx submitted to chain)
  ▼
SETTLED              ← terminal (success)

Alternative terminals:
  CANCELLED          (user cancel / expiry / MATCH_REJECT before commit)
  DISPUTED           (commit sent but counterparty aborted; dispute filed)
  SLASHED            (on-chain dispute resolved against this relayer)
  FAILED             (settlePrivate reverted; see below)
```

### 5.2 Transition table

| From | To | Trigger | Gossip? |
|---|---|---|---|
| — | `SUBMITTED` | User POST to relayer | No |
| `SUBMITTED` | `PENDING` | Local proof verification starts | No |
| `PENDING` | `OPEN` | Verification passed, `ORDER_ANNOUNCE` sent | Yes |
| `PENDING` | `CANCELLED` | Verification failed | No |
| `OPEN` | `PROPOSED` | Received `MATCH_PROPOSE`, sent `MATCH_ACCEPT` | No |
| `OPEN` | `CANCELLED` | Expired / user cancel / `ORDER_CANCEL` gossiped | Yes |
| `PROPOSED` | `OPEN` | `MATCH_REJECT` received or timeout (no `COMMIT`) | No |
| `PROPOSED` | `COMMITTED` | Both `COMMIT` messages exchanged | No |
| `COMMITTED` | `REVEALED` | Both `REVEAL` messages received within window | No |
| `COMMITTED` | `DISPUTED` | Reveal window passed without counterparty reveal | No |
| `REVEALED` | `SETTLING` | `settlePrivate` tx submitted | No |
| `REVEALED` | `FAILED` | Submission failed before tx sent (RPC error, nonce issue) | No |
| `SETTLING` | `SETTLED` | Tx mined, `PrivateSettled` event observed | Yes (via `SETTLE_NOTICE`) |
| `SETTLING` | `FAILED` | Tx reverted on-chain | Yes |
| `DISPUTED` | `SLASHED` | `DisputeResolved` event upholds dispute | Yes |
| `DISPUTED` | `REVEALED` | Counterparty submitted counter-evidence during challenge window | No |

### 5.3 Invariants

- An order is in exactly one of the active states at any time
- Terminal states (`SETTLED`, `CANCELLED`, `SLASHED`, `FAILED`) are final; once entered, no further transitions
- Every transition into `COMMITTED` must be paired with a signed `COMMIT` message from both relayers (required for dispute evidence)
- The nullifier for a settled order is never re-used (enforced on-chain by `PrivateSettlement.nullifiers` map)

### 5.4 Fair Exchange Algorithm

The state machine above is driven by a concrete commit-reveal fair-exchange protocol. This subsection specifies the message ordering, timing, and abort handling in sufficient detail that two independently-implemented relayers can interoperate. The narrative sections above (§4.3 `COMMIT` / `REVEAL`) define the wire format; this subsection defines the **behaviour**.

#### 5.4.1 Problem statement

Two relayers A (maker side) and B (taker side) each hold one half of a matched trade. Neither has the other's proof. Both need to end up with both proofs so that either can call `settlePrivate` on-chain. The protocol must satisfy:

1. **Liveness under cooperation** — if both relayers behave honestly and are both online, the exchange completes in bounded time and both sides end up with both proofs.
2. **Abort safety** — if either relayer withholds, the other can detect the withholding within a bounded window and safely abandon the match without permanent value loss.
3. **No privacy leak to a withholder** — a relayer that aborts mid-protocol must not learn anything about the counterparty's witness that it could not have learned from the counterparty's public order announcement.
4. **Dispute evidence** — every malicious withholding generates a cryptographically-bound record that an independent dispute registry can later attribute to the aborting relayer.

Crucially, the protocol does **not** need atomic swap semantics. Because both proofs are bound via `orderHash` to their respective relayers (Phase 3.6 trustless fee split, already implemented), neither relayer can unilaterally profit from holding both proofs — the on-chain settle call still requires both proofs to be submitted together, and the fee split is locked in the proofs themselves. The worst a malicious withholder can do is **delay** the trade, not **steal** it.

#### 5.4.2 Protocol flow

Let A be the **lower-address** relayer in the matched pair (by 20-byte Ethereum address, lexicographic order) and B the higher-address relayer. This breaks the symmetry and assigns a deterministic commit order without consensus.

```
                   A (lower addr)                         B (higher addr)
                        │                                       │
   t=0    MATCH_ACCEPT ─┼──────────────────────────────────────▶│
                        │        round_id assigned              │
   t=0    round started │                                       │ round started
                        │                                       │
   t≤T_C  COMMIT(A) ────┼──────────────────────────────────────▶│  (A commits first)
                        │                                       │
   t≤2T_C               │◀──────────────────────────── COMMIT(B)│  (B commits after seeing A)
                        │                                       │
                        │           both COMMIT seen            │
                        │       → state COMMITTED (both)        │
                        │                                       │
   t≤2T_C+T_R  REVEAL(A)┼──────────────────────────────────────▶│  (A reveals first)
                        │                                       │
   t≤2T_C+2T_R          │◀──────────────────────────── REVEAL(B)│  (B reveals after seeing A)
                        │                                       │
                        │           both REVEAL seen            │
                        │       → state REVEALED (both)         │
                        │                                       │
   t≥          either side calls settlePrivate on-chain
```

With the default parameters in §13:

| Phase | Symbol | Default |
|---|---|---|
| Commit wait (per step) | `T_C` | 10 s (= `MATCH_PROPOSE_TIMEOUT`) |
| Reveal wait (per step) | `T_R` | 5 min (= `REVEAL_WINDOW`) |
| Full fair-exchange deadline | `2·T_C + 2·T_R` | ~10 min 20 s from `MATCH_ACCEPT` |

The four-step ordering (A-commit → B-commit → A-reveal → B-reveal) is the minimal non-simultaneous fair-exchange pattern. Simultaneous commit is not required because sequential commit with a short timeout is already fast enough; the latency budget is dominated by `T_R`, not `T_C`.

#### 5.4.3 Why this is safe against withholding

Enumeration of abort points, with A and B as above:

**Point 1 — B does not COMMIT after seeing A's COMMIT.**
A times out at `2·T_C = 20 s`. The round is closed locally at A, state transitions `PROPOSED → OPEN` (per the transition table in §5.2, "MATCH_REJECT received or timeout (no COMMIT)"). A's order returns to the open orderbook for rematching. A's witness has **not** been revealed to B — only A's commit hash, which is a Poseidon-based pre-image-hiding commitment to `(proof_bytes, salt)`. The aborting relayer B learns nothing beyond the public order parameters it already saw in `ORDER_ANNOUNCE`. A's escrow nullifier has **not** been consumed on-chain, so A can rematch freely.

**Point 2 — A does not REVEAL after both COMMITs.**
B times out at `2·T_C + T_R`. Both commits are signed EIP-712 messages, so B has a cryptographic record that A committed and then refused to reveal. B files this record with the off-chain `DisputeRegistry` (Type 1 — abort after commit) per the `DISPUTE_CLAIM` message flow (§4.3). A's reputation is permanently recorded. B's witness has not been revealed (only B's commit hash), so B loses nothing except the round latency. B's order returns to `OPEN` and re-enters matching.

**Point 3 — B does not REVEAL after A reveals.**
This is the **asymmetric-reveal** position — A has already sent `REVEAL(A)` and B is holding both commits plus A's revealed proof. A times out at `2·T_C + 2·T_R`. Does A lose anything?
  - B cannot submit `settlePrivate` with only A's proof. The on-chain contract requires both maker and taker proofs, and the taker proof is bound to the taker's relayer via `orderHash` (Phase 3.6). B has not produced a taker proof for this round.
  - B has seen A's proof. But A's proof is per-order (bound to `makerNonce`), and A's escrow nullifier is still unconsumed on-chain. A simply rematches with a different counterparty using a new order + new nonce. The old proof becomes worthless to B the moment A re-matches, because the nonce no longer corresponds to an open order.
  - A files a Type 2 dispute (abort after partial reveal) with `DisputeRegistry`. The evidence is: B's signed COMMIT (proving B entered the round), A's signed REVEAL (proving A fulfilled the reveal obligation), B's absence of REVEAL before deadline (attested by A and optionally by other relayers who subscribe to the `/zkscatter/1/match/B/proto` topic).

The residual cost to A in Point 3 is **one round of latency** (up to `2·T_C + 2·T_R` ≈ 10 min) and **one burned order identifier** (must re-sign with a new nonce). There is no privacy loss, no fund loss, and no stuck state.

**Point 4 — A reveals a proof that does not match its COMMIT.**
The REVEAL message contains `commit_hash` which must equal `H(proof_bytes || salt)`. B checks this locally: if the hash doesn't match, B does not proceed to `settlePrivate` and files a Type 3 dispute (reveal-commit mismatch). This is the check at §4.3 `REVEAL` ("must match the prior COMMIT's commit_hash"). The asymmetry is the same as Point 3 — A has essentially aborted, just in a more provable way.

**Point 5 — Both sides withhold.**
No dispute is filed (both are aborting). The round times out at `2·T_C + 2·T_R`. Both orders return to `OPEN`. The only cost is latency.

#### 5.4.4 Why record-only (no slashing) is sufficient here

The reader might expect bond slashing as the "real" deterrent against Point 2 and Point 3 withholding. The architectural decision to use **record-only enforcement via `DisputeRegistry`** instead of on-chain slashing is specified in full in [../dispute-registry/design.md](../dispute-registry/design.md) §"Why reputation works better than slashing here". The load-bearing reasons are repeated here for self-containment of this protocol spec:

1. **The relayer identity set is public and non-anonymous.** Every active relayer is registered in `RelayerRegistry` with a Dual-CA identity. A public misbehaviour record attached to a public identity causes market-level fee loss that exceeds any slashable bond — the market does the slashing for us. Lightning Network needs slashing because its channels are anonymous; zkScatter doesn't, because its relayers aren't.

2. **Slashing adds a contract-complexity surface that has its own failure modes.** Bond manipulation, accuser rewards, challenge windows, griefing deposits, slash distribution — each of these is an opportunity for a bug that is strictly worse than the problem being solved. The dispute registry is a 3-field event emitter. It cannot grief honest relayers because it takes no custody of their bond.

3. **Reputation composes with the Dual-CA identity layer.** A slashed bond can be replaced from a fresh wallet; a Dual-CA identity cannot be replaced without re-running the KYC + KYB path at two independent authorities. Reputation records attached to the Dual-CA identity are therefore **more persistent** than slashable bonds would be.

The withholding scenarios in §5.4.3 all resolve to "record the misbehaviour, return to open state, rematch". There is no scenario in which a malicious withholder extracts value; the worst outcome is latency. Latency plus a permanent public record is the entire enforcement mechanism, and it is sufficient because the underlying economic incentive — "next user picks a different relayer" — is strong enough to deter rational misbehaviour.

#### 5.4.5 Dispute evidence format

Each of Points 2, 3, 4 generates a `DISPUTE_CLAIM` message (§4.3). The on-chain evidence submitted to `DisputeRegistry` is:

| Dispute type | Evidence |
|---|---|
| Type 1 — abort after commit (Point 2) | Accuser's signed `COMMIT` + accused's signed `COMMIT` + accuser's proof-of-non-reveal (absence of REVEAL in the accuser's local message log before `reveal_deadline`) |
| Type 2 — abort after partial reveal (Point 3) | Accuser's signed `COMMIT` + accused's signed `COMMIT` + accused's signed `REVEAL` + accuser's signed `REVEAL` + proof that the accused did not reveal before deadline |
| Type 3 — reveal-commit mismatch (Point 4) | Accused's signed `COMMIT` + accused's signed `REVEAL` where `H(REVEAL.proof_bytes || REVEAL.salt) ≠ COMMIT.commit_hash`. This is self-contained — the dispute registry verifies the hash on-chain. |

The exact Solidity encoding of each evidence blob is specified in [../dispute-registry/design.md](../dispute-registry/design.md) "Evidence Schemas". The contract validates the signatures and the hash check, then emits a permanent event. No funds move.

#### 5.4.6 Worked example — happy path

```
t=0.00s   MATCH_ACCEPT(A→B)        round_id=42 opened, both → PROPOSED
t=0.15s   COMMIT(A→B)              A sends first (lower addr). A → COMMITTED_HALF
t=0.30s   COMMIT(B→A)              B responds within T_C. Both → COMMITTED
t=0.45s   REVEAL(A→B)              A reveals first.
t=0.60s   REVEAL(B→A)              B reveals. Both → REVEALED
t=0.60s   Either side builds the settlePrivate tx.
t=2.50s   settlePrivate tx mined. PrivateSettled event → SETTLED
t=2.60s   SETTLE_NOTICE(A→B) (or B→A) — informational
```

Total wall-clock time from `MATCH_ACCEPT` to `SETTLED` is dominated by the on-chain settlement latency, not the protocol. The commit-reveal dance adds roughly 0.6 s of off-chain round trips.

#### 5.4.7 Worked example — B withholds after A reveals (Point 3)

```
t=0.00s   MATCH_ACCEPT(A→B)
t=0.15s   COMMIT(A→B)
t=0.30s   COMMIT(B→A)
t=0.45s   REVEAL(A→B)              A has now revealed its proof to B
t=0.45s+  A expects REVEAL(B) by t ≤ 2·T_C + 2·T_R = ~10m 20s
t=10.33m  REVEAL_WINDOW deadline passes without REVEAL(B)
t=10.33m  A constructs Type 2 evidence:
            - COMMIT(A) (self-signed)
            - COMMIT(B) (B-signed, received at t=0.30s)
            - REVEAL(A) (self-signed)
            - (No REVEAL(B) — local log attests absence)
t=10.34m  A files DISPUTE_CLAIM with DisputeRegistry on-chain
t=10.34m  A's order returns to OPEN (state transition DISPUTED → ... not applied
          because A is the accuser, not the disputed party; A's state just resets)
t=10.40m  A re-signs a new order with a fresh makerNonce and rematches
          against a different taker (nullifier was never consumed)
t=∞       B's reputation carries the Type 2 record forever. Next user who
          queries the reputation dashboard sees it.
```

This is the worst case the protocol has to handle, and it resolves cleanly: A loses ~10 minutes and one order nonce, B loses reputation, no funds move, no on-chain slashing is needed.

## 6. Inventory Model

Each relayer maintains a local key-value store keyed by `order_id`. This is the relayer's private state — not gossiped.

```
InventoryRecord {
  order_id: bytes32

  // Public metadata (also present in ORDER_ANNOUNCE gossip)
  public_meta: {
    pair: bytes32
    side: Side
    price: uint256
    amount: uint256
    expiry: uint64
    maker_pubkey: bytes
    merkle_root: bytes
    announced_at: uint64
  }

  // Private holding data
  proof_blob: bytes          // the actual ZK proof; NEVER gossiped
  role: Role { MAKER_SIDE, TAKER_SIDE }
                            // relayer's position relative to this order

  // Lifecycle
  state: OrderState          // §5
  state_entered_at: uint64

  // Matching lock
  match_lock: {
    locked: bool
    counterparty_relayer: bytes?
    counterparty_order_id: bytes?
    round_id: uint64?
    commit_hash_self: bytes?
    commit_hash_peer: bytes?
    lock_expires_at: uint64?
  }

  // Economic
  fee_promised: uint256      // user-agreed fee at submission
  fee_collected: uint256?    // after settlement

  // Audit
  user_submission_ts: uint64
  last_state_change_ts: uint64
  received_messages: [MessageId]  // deduplication set, bounded LRU
}
```

### 6.1 Inventory pruning

Records are moved from hot storage to cold archive when:
- State is terminal (`SETTLED`, `CANCELLED`, `SLASHED`, `FAILED`) and
- `last_state_change_ts > now - RETENTION_HOT` (suggested: 7 days)

Cold archive is retained indefinitely for dispute evidence. Relayers must not delete `COMMIT`-bearing records until at least `CHALLENGE_WINDOW` (3 days) after the dispute-filing deadline has passed.

### 6.2 Inventory privacy

Inventory is **local-only**. A relayer must never share `proof_blob` except as part of a `REVEAL` message during a specific matched round. Even during `STATE_SYNC_RESPONSE`, only the public metadata is included — proofs remain with the holding relayer.

## 7. Matching Rules

### 7.1 Local matching

Each relayer independently evaluates its local inventory against gossiped orders. Matching is standard price-time priority:

1. **Price priority** — the better price goes first. For a BUY, better = higher bid. For a SELL, better = lower ask.
2. **Time priority** — among orders at the same price, the one announced earlier goes first.
3. **Minimum fill** — orders can specify a minimum fill amount; below this, no match is proposed.

### 7.2 Cross-relayer assignment (deterministic sharding)

The fundamental problem: if two relayers both see the same maker order and both have matching taker orders, they will race to `MATCH_PROPOSE`. Without coordination, this wastes rounds and creates dispute opportunities.

**Proposed rule** (avoids consensus and avoids leader election):

```
For each (maker_order, time_slot) pair, a single relayer is deterministically
designated as the "primary matcher":

    primary_matcher = active_relayers[H(maker_order_id || slot_number) mod N]

where:
  slot_number = floor(now_seconds / MATCHING_SLOT_DURATION)
  MATCHING_SLOT_DURATION = 5 seconds
  active_relayers = sorted list from RelayerRegistry, snapshotted at slot start
```

Only the primary matcher is allowed to send `MATCH_PROPOSE` for this `(order, slot)`. Other relayers see the announcement and wait.

**Fallback** — if the primary matcher does not propose a match within the slot, the next candidate (shifted by 1 in the sorted list) is allowed in the next slot. This avoids stalls if the primary is offline.

**Why this works**:
- Every relayer computes the same assignment (deterministic hash)
- No explicit consensus needed
- Load distributes evenly across relayers on average
- Compromises liveness gracefully (offline primary → next slot takes over)

**Trade-offs**:
- Slot duration adds latency (up to `MATCHING_SLOT_DURATION` seconds per match attempt)
- Relayer set changes (register/exit) require re-snapshotting — must use block-based cutoff for consistency
- Not fair for relayers with very few orders (all-or-nothing matching assignment)

### 7.3 Alternative matching strategies

These are considered and rejected (or deferred) for the MVP:

- **First-come-first-served race** — simple but creates dispute spam and inconsistent states
- **Raft / Paxos quorum** — correct but high complexity and high latency
- **Auction (lowest-fee wins)** — fair but adds an auction round per match
- **Central matching server** — defeats the purpose (we already have this in the legacy design)

MVP chooses deterministic sharding (§7.2) because it's the simplest rule that avoids consensus. Revisit if production data shows uneven load.

## 8. Transport: Waku v2

### 8.1 Why Waku v2

- **Ethereum-native** — maintained by the Ethereum Foundation (Status team), designed for dApp messaging
- **RLN (Rate Limiting Nullifier)** — native ZK-based rate limiting, aligned with zkScatter's privacy goals
- **Pub/Sub + request/response** — supports both gossip and direct messaging in one library
- **libp2p-based** — standard peer discovery, NAT traversal, transport encryption
- **No blockchain dependency** — messages are ephemeral, no L1 footprint

Alternatives considered:
- **libp2p directly** — more flexibility, but more to build (topic management, persistence)
- **Nostr** — simple but no native ZK rate limiting
- **IPFS pubsub** — deprecated by libp2p gossipsub (which Waku wraps)

### 8.2 Content topics

```
/zkscatter/1/orderbook/proto           — gossip: ORDER_ANNOUNCE, ORDER_CANCEL
/zkscatter/1/heartbeat/proto           — gossip: RELAYER_HEARTBEAT
/zkscatter/1/match/<relayer_id>/proto  — direct: per-relayer inbox for MATCH_* and COMMIT/REVEAL
/zkscatter/1/dispute/proto             — gossip: DISPUTE_CLAIM (audit trail)
```

`<relayer_id>` is the relayer's Ethereum address (hex-encoded, lowercase, no `0x`). Each relayer subscribes to its own `match/<relayer_id>` topic and treats incoming messages as direct messages to itself.

### 8.3 RLN configuration

- **Epoch duration**: 10 seconds
- **Rate limit**: 10 messages per epoch per relayer identity
- **Slashing integration**: RLN epoch leaks a nullifier that can be observed on-chain; could feed into reputation system but **not into bond slashing** directly (out of scope for MVP)

### 8.4 Bootstrap discovery

Relayers find each other via:

1. **On-chain `RelayerRegistry`** — primary source of truth. `RelayerRegistry.getActiveRelayers()` returns all registered addresses. Each relayer publishes its Waku peer ID in `RELAYER_HEARTBEAT` gossip, so discovery = (on-chain address list) ∩ (recent heartbeats).
2. **Seed nodes** — hardcoded bootstrap Waku peers maintained by the zkScatter team. Used only for initial network entry.
3. **DHT** — libp2p's Kademlia DHT for peer discovery inherited from Waku.

### 8.5 Transport security

- **Noise encryption** (Waku default) protects messages from network observers
- **EIP-712 signatures** protect against impersonation within the protocol layer
- **End-to-end encryption** via an ephemeral X25519 session for direct messages (defense-in-depth: even if Waku transport is compromised, direct message content is still encrypted)

## 9. Protocol Versioning

### 9.1 Version identifier

Every message carries `protocol_version` in the envelope. A semver-like scheme is used:

- **Major version** — breaks compatibility (e.g., new required field, changed signature domain). Relayers with different major versions refuse to interoperate.
- **Minor version** — additive changes. Relayers accept older minor versions but may ignore new fields.
- **Patch** — non-semantic (bug fixes, metadata). Always compatible.

Only the major version is included in the content topic (`/zkscatter/1/...`). Minor/patch versions are in the message envelope.

### 9.2 Version negotiation

On first contact with a new peer:
1. Exchange `RELAYER_HEARTBEAT` (which includes `supported_versions`)
2. Use the highest mutually supported version
3. If no overlap, refuse to interoperate (log warning)

### 9.3 Migration strategy

When a breaking change is needed:
1. Announce deprecation: new version advertised in parallel with old
2. Grace period: both versions coexist for 30 days
3. Cut-over: old version topic closed after grace period
4. Relayers that don't upgrade fall out of the federation (visible via heartbeat absence)

## 10. Security Considerations

### 10.1 Threats addressed

| Threat | Mitigation |
|---|---|
| Secret exposure during matching | Client-side proving split — relayers never hold witnesses |
| Unauthorized matching | Deterministic sharding — only primary matcher can propose |
| Relayer impersonation | EIP-712 signatures + `RelayerRegistry` membership |
| Match flooding (DoS) | Waku RLN rate limiting + per-relayer quotas |
| Eavesdropping on direct messages | Noise (Waku) + X25519 session (E2E) |
| Replay of old commits | `round_id` monotonic per pair + signature over timestamp |
| Inconsistent orderbook views | Gossip + deterministic sharding ensures eventual consistency |
| Stale orderbook after restart | `STATE_SYNC_*` messages |
| Fair-exchange violation | Commit-reveal + on-chain `DisputeRegistry` recording → reputation loss |

### 10.2 Threats explicitly out of scope

- **Complete network partition** — if a relayer is cut off from Waku entirely, its orders cannot be matched. Acceptable; users can submit to multiple relayers.
- **Waku network compromise** — requires compromising the underlying libp2p/Noise stack. Treated as a dependency assumption.
- **Ethereum L1 re-org beyond finality depth** — `PrivateSettlement` assumes finalized state. Reorgs are the L1's problem.
- **Censorship by the RelayerRegistry owner** — governance issue, not protocol issue. Mitigated by making `RelayerRegistry` ownership a DAO or multisig in production.

### 10.3 Interactions with existing threat model

From [../relayer-security.md](../relayer-security.md):

| relayer-security.md threat | This protocol's effect |
|---|---|
| §1 Malicious relayer operator | **Weakened** — client-side proving removes most of the target (no witnesses to steal) |
| §2 Database theft | **Weakened** — database holds only proofs, not witnesses |
| §3 Trade Offer interception | **Replaced** — Trade Offer is gone; commit-reveal over Waku takes its place |
| §4 Shared orderbook compromise | **Eliminated** — no central orderbook to compromise |
| §5 Relayer private key compromise | **Unchanged** — key compromise still allows signing malicious commits; mitigated by bond slashing |

## 11. Integration with Existing Code

### 11.1 What gets added

New code:
- `zk-relayer/src/protocol/` — new module implementing the Waku-based protocol
  - `waku.ts` — Waku v2 client wrapper
  - `messages.ts` — protobuf codecs and validators
  - `state-machine.ts` — order state machine
  - `inventory.ts` — local inventory store
  - `matching.ts` — deterministic sharding + local matching
  - `fair-exchange.ts` — commit-reveal flow
- Relayer SDK client library (for third-party watchdogs) — optional

New dependencies:
- `@waku/sdk` or equivalent JS library
- `protobufjs`

### 11.2 What gets deprecated

Gradual deprecation path for the current HTTP Trade Offer implementation:

- **Phase 0**: current HTTP Trade Offer remains default. Waku protocol added as opt-in flag per relayer.
- **Phase 1**: both protocols run in parallel; relayers supporting both fall back to HTTP if peer lacks Waku.
- **Phase 2**: default switches to Waku; HTTP available as fallback.
- **Phase 3**: HTTP Trade Offer removed from code; shared orderbook server retired or repurposed as a Waku bootstrap node.

### 11.3 Integration with `RelayerRegistry`

No contract changes strictly required by this protocol alone. Relayer discovery uses existing `getActiveRelayers()`.

**Optional enhancement**: add a `mapping(address => string) public wakuPeerId` to let relayers register their Waku peer IDs on-chain. Trade-off: simpler discovery vs. extra gas per update. Recommendation: keep peer IDs off-chain (in heartbeat gossip) for now; revisit if discovery proves unreliable.

### 11.4 Integration with `PrivateSettlement`

No changes required. The `settlePrivate(SettleParams)` function remains the settlement target; the new protocol just changes how relayers get to the point of calling it.

The already-implemented `makerRelayer`/`takerRelayer` binding in the proof (Phase 3.6) is directly compatible: the commit-reveal exchange ensures both relayers have matching proofs, and either can call `settlePrivate`.

### 11.5 Integration with `DisputeRegistry`

Per [../dispute-registry/design.md](../dispute-registry/design.md):
- The `RelayerCommit` EIP-712 struct in this protocol **must match** the one consumed by `DisputeRegistry`. The EIP-712 domain must be the `DisputeRegistry` contract's domain (`zkScatterDisputeRegistry` v1) so the same signature is valid in both contexts.
- The `RelayerReveal` struct (§4.3, `REVEAL` message) is required for Type 2 (mismatch) records.
- The `DISPUTE_CLAIM` gossip message is informational only; the authoritative record is the on-chain `DisputeRecorded` event.
- The dispute model is **record-only**: there is no on-chain slashing or reward. Reputation is built by off-chain indexers reading the event log; users select relayers via the frontend's reputation display.

## 12. Open Questions

### OQ-1: Waku v2 vs. libp2p directly
Waku v2 is a wrapper around libp2p with added conveniences (content topics, RLN). For a project that wants maximum control, raw libp2p might be preferred. **Decision deferred**: start with Waku; migrate if we hit limitations (e.g., message size caps, topic management issues).

### OQ-2: Direct message reliability
Waku's pub/sub is best-effort. For critical direct messages (COMMIT, REVEAL), we may need acknowledgment + retry. **Proposed**: add an `ACK` message type at Phase 1; for now, rely on protocol-level timeout + retry in the sender.

### OQ-3: Cross-relayer fee accounting
When a match involves `R_M` and `R_T`, fee splits already work via the on-chain Phase 3.6 mechanism. But does each relayer need to know the *exact* fee the other is collecting? **Current design**: no — each relayer only collects its own side's fee, and the on-chain settlement enforces the split cryptographically.

### OQ-4: Handling forks in state
Two relayers might briefly have different views of the orderbook due to gossip latency. **Proposed**: accept eventual consistency; rely on deterministic sharding to prevent double-matching. If a race occurs, one side sends `MATCH_REJECT` with `ORDER_ALREADY_MATCHED`.

### OQ-5: Watchdog incentive
Third parties can record disputes via [../dispute-registry/design.md](../dispute-registry/design.md), but the design is **record-only** — no on-chain reward. Watchdog coverage relies on:
- Relayer self-defense (a relayer auto-records disputes against bad peers to protect its own reputation)
- Off-chain indexer competition (running an indexer is a paid service for frontends)
- Optional: Phase 4 may introduce off-chain reward markets for dispute recording, separate from the on-chain contract.

### OQ-6: Protocol governance
Who gets to change `protocol_version`, add new message types, or modify the message schema? **Deferred** to governance design. For MVP, treat this document as the source of truth, changes go through normal PR review.

### OQ-7: Compatibility with non-federated relayers
Can a relayer operate as a "solo" node, receiving only its own users' orders and never gossiping? **Yes**, but it sacrifices cross-relayer matching. Useful for private deployments (e.g., a single institution running its own relayer for its own users). No protocol changes needed; the relayer simply doesn't subscribe to gossip topics.

## 13. Parameters Summary

| Parameter | Default | Where used | Notes |
|---|---|---|---|
| `MAX_CLOCK_SKEW` | 5 min | Message timestamp validation | Aligned with `PrivateSettlement.TIMESTAMP_TOLERANCE = 300s` |
| `HEARTBEAT_INTERVAL` | 30 s | Relayer liveness | Absence of 3 intervals = offline |
| `MATCHING_SLOT_DURATION` | 5 s | Deterministic sharding | Trade-off: latency vs. liveness |
| `MATCH_PROPOSE_TIMEOUT` | 10 s | Accept/reject window | Short — keep the protocol snappy |
| `REVEAL_WINDOW` | 5 min | Commit-reveal | **Must match** `DisputeRegistry.REVEAL_WINDOW` |
| `RLN_EPOCH` | 10 s | Waku RLN | Messages per epoch per relayer |
| `RLN_RATE_LIMIT` | 10 / epoch | Waku RLN | Anti-flood |
| `STATE_SYNC_WINDOW` | 24 h | State recovery | How far back to sync on restart |
| `RETENTION_HOT` | 7 days | Local inventory | Hot storage lifetime for terminal orders |
| `RETENTION_COLD` | ∞ | Cold archive | Required for dispute evidence |

## 14. Implementation Roadmap

### Sprint 1-2: Transport skeleton
- [ ] Waku v2 integration in `zk-relayer` (Node.js)
- [ ] Content topic setup, peer discovery via `RelayerRegistry`
- [ ] Handshake + EIP-712 signature validation
- [ ] `RELAYER_HEARTBEAT` implementation

### Sprint 3-4: Gossip layer
- [ ] `ORDER_ANNOUNCE` / `ORDER_CANCEL` flow
- [ ] Local inventory store (SQLite / LevelDB)
- [ ] Orderbook view synthesis from gossip
- [ ] `STATE_SYNC_*` messages

### Sprint 5-6: Matching & direct messaging
- [ ] Local price-time priority matcher
- [ ] Deterministic sharding assignment
- [ ] `MATCH_PROPOSE` / `MATCH_ACCEPT` / `MATCH_REJECT` flow
- [ ] Direct message encryption (X25519 session)

### Sprint 7-8: Fair exchange
- [ ] `COMMIT` / `REVEAL` state machine
- [ ] EIP-712 signing aligned with `DisputeRegistry`
- [ ] Timeout handling + local abort detection
- [ ] `SETTLE_NOTICE` publication

### Sprint 9-10: Integration & deprecation
- [ ] Feature flag to enable Waku protocol alongside HTTP Trade Offer
- [ ] E2E tests: 2 relayers on Waku matching across federation
- [ ] Comparison benchmarks (HTTP Trade Offer vs Waku commit-reveal)
- [ ] Documentation + relayer operator guide

### Sprint 11+: Hardening
- [ ] RLN rate limiting enabled
- [ ] Watchdog tooling
- [ ] Dispute recording integration (requires `DisputeRegistry.sol` deployed)
- [ ] Migration of default to Waku protocol

## 15. References

### Internal
- [../design-shared-orderbook.md](../design-shared-orderbook.md) — current HTTP Trade Offer protocol (the baseline this replaces)
- [../dispute-registry/design.md](../dispute-registry/design.md) — on-chain dispute resolver (depends on this protocol's commit-reveal)
- [../relayer-security.md](../relayer-security.md) — operational threat model for individual relayers
- [../PAPER.md](../PAPER.md) — overall zkScatter architecture and compliance model
- [../../contracts/src/RelayerRegistry.sol](../../contracts/src/RelayerRegistry.sol) — relayer discovery and bond
- [../../contracts/src/zk/PrivateSettlement.sol](../../contracts/src/zk/PrivateSettlement.sol) — on-chain settlement target

### External
- **Waku v2**: https://docs.waku.org/ — Ethereum-native messaging layer
- **libp2p gossipsub**: https://docs.libp2p.io/concepts/pubsub/overview/ — underlying gossip protocol
- **RLN (Rate Limiting Nullifier)**: https://rate-limiting-nullifier.github.io/ — ZK-based rate limiting
- **EIP-712**: typed structured data hashing and signing
- **Steam Web API**: reference for Trade Offer pattern (https://steamcommunity.com/dev)
- **DMarket / Skinport / CS.Money**: real-world multi-bot trading architectures that inspired the federation model

---

*This document is a design reference. Actual implementation should revisit each design decision with production constraints and update this document accordingly.*
