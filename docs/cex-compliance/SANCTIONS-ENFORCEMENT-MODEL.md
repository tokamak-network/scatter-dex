# Sanctions Enforcement Model

This document explains how ScatterDEX enforces the on-chain
sanctions blocklist — which entry points check the list, what
happens when an address is added or removed, and what the
operational implications are for an exchange or regulator
evaluating the protocol.

## Where the check fires

The protocol's sanctions gate is enforced at every state-changing
boundary entry point. There is no path that bypasses the gate.

| Entry point | Checked address | Source file |
|---|---|---|
| `CommitmentPool.deposit` | `msg.sender` (the depositor) | `contracts/src/zk/CommitmentPool.sol` |
| `CommitmentPool.withdraw` | both the EOA producing the proof and the `recipient` | `contracts/src/zk/CommitmentPool.sol` |
| `PrivateSettlement.settleAuth` | `msg.sender` (the matching relayer) | `contracts/src/zk/PrivateSettlement.sol` |
| `PrivateSettlement.settleWithDex` | `msg.sender` (the relayer running the asset-conversion path) | `contracts/src/zk/PrivateSettlement.sol` |
| `PrivateSettlement.scatterDirectAuth` | `msg.sender` (the relayer / issuer running the self-distribution path) | `contracts/src/zk/PrivateSettlement.sol` |
| `PrivateSettlement.claimWithProof` (and `claimWithProofBatch`) | `recipient` (the address the payout is bound to in the leaf) | `contracts/src/zk/PrivateSettlement.sol` |

The check itself is the same on every entry: if a non-zero
`SanctionsList` is registered and the checked address is on it,
the call reverts.

The same `ISanctionsList` interface lets the operator swap the
default `SanctionsList` implementation for the Chainalysis SDN
Oracle (`0x40C57923...`) or any other compatible blocklist —
the entry points read through the interface so no contract code
needs to change.

## The "claim-time gate" — the load-bearing piece

The settlement / scatter / settle-with-dex entry points block at
**relayer** granularity (they check `msg.sender`). That's the
gate most analogous to "filtering at the matching engine".

The **claim** entry point blocks at **recipient** granularity.
That gate is the load-bearing one for the protocol's compliance
posture, because:

1. A settle / scatter / settle-with-dex transaction does not move
   funds to any user yet — it only registers a `claimsGroups[…]`
   entry. The actual fund movement happens later at claim time.
2. Adding an address to `SanctionsList` after settlement still
   blocks any future `claimWithProof` whose leaf recipient
   matches. The funds for that leaf stay locked in the pool —
   there is no path to move them past the sanction.
3. The check fires on every claim independently, so the gate
   always reflects the **current** sanctions list, not a snapshot
   taken at order time.

In short: settle is reversible (or, more precisely, never moves
funds in the first place); claim is the irreversible step, and
the claim path is where the recipient-level check lives.

## Retroactive enforcement

Adding an address to the sanctions list **retroactively** affects
every pre-existing claim leaf bound to that address. There is no
grandfathering. Consequences:

- Funds already settled to a now-sanctioned address stay locked
  in the `CommitmentPool` and become unclaimable.
- The original sender cannot reclaim those funds either (the
  claim circuit binds the recipient inside the leaf preimage; a
  third party — sender or anyone else — cannot substitute a
  different recipient without breaking the Merkle membership
  check).
- An OFAC SDN listing that lands between settlement and claim
  effectively turns the routed amount into a frozen on-chain
  balance.

This is intentional. From an exchange's risk perspective the
property to subscribe to is:

> *"Once the operator multisig adds an address to SanctionsList,
> no future on-chain action can move funds to or from that address
> through the ScatterDEX entry points."*

## Removal semantics

Removing an address (`removeSanction` or `removeSanctionsBatch`)
re-enables every entry point's interaction with that address.
There is no timelock today; removal applies on the next block.

In an OFAC delisting scenario the operator multisig calls
`removeSanction(addr)` and any previously-frozen claim leaf bound
to that address becomes claimable again on its next attempt.

## Optional Pluggable Implementation

The `SanctionsList` contract is one possible implementation of
`ISanctionsList`. Operators can swap it for any other contract
that satisfies the interface, including:

- **Chainalysis SDN Oracle** (`0x40C57923B0a7F3a0FAaA9A6f3A52f3a1f4...` —
  per their public docs) — a community-maintained blocklist with
  no owner key.
- A bespoke list that aggregates multiple sources (OFAC + EU + UK
  + local regulator) and exposes the merged view via
  `isSanctioned`.

Boundary contracts call `setSanctionsList(addr)` (owner-gated) to
point at the chosen implementation; the rest of the protocol is
agnostic.

## Operational responsibilities

| Task | Owner | Cadence |
|---|---|---|
| OFAC SDN list synchronisation | Operations multisig (operator team) | Per OFAC publication cycle (typically weekly batched updates) |
| Verifying batch additions don't exceed `MAX_BATCH_SIZE` (200) | Operations multisig | Per batch — split into multiple calls if larger |
| Reviewing Chainalysis vs. self-managed trade-off | Compliance team | Pre-deploy and on major regulator events |
| Incident response when a sanctioned interaction is attempted | Operations multisig + compliance | Per event |

These are operational policy items; they are not enforced on-chain.

## What this gate does NOT do

- **Does not screen the original depositor of funds that a third
  party later claims.** The check fires on the address acting at
  each entry point — depositor at deposit time, relayer at
  settle time, recipient at claim time. Chain analytics outside
  the protocol can still trace fund provenance; the on-chain
  gate only blocks the specific actions listed above.
- **Does not unwind past actions.** Adding an address after a
  deposit is recorded does not retroactively reject the deposit
  — the deposit already landed. The gate only blocks **future**
  actions by that address.
- **Does not freeze the full pool.** Funds settled to a
  non-sanctioned recipient remain claimable even if the
  *original sender* is later sanctioned; the recipient is the
  address that bears the gate at claim time.
- **Does not provide global pause.** That's a separate
  `pause()` / `unpause()` mechanism on each contract (see
  [`ADMIN-WALLETS-AND-UPGRADE-POLICY.md`](./ADMIN-WALLETS-AND-UPGRADE-POLICY.md)).
  An OFAC enforcement event affecting one address uses the
  sanctions gate; a protocol-level incident uses pause.

## How to verify

- Read the test file `contracts/test/SanctionsList.t.sol` — it
  exercises every entry point above and asserts the expected
  revert path on each.
- Read the deploy script `contracts/script/DeployLocal.s.sol` —
  the `_deployAndWireSanctionsList` helper records the proxy
  address, wires it onto both boundary contracts, and the
  summary surfaces the address as
  `NEXT_PUBLIC_SANCTIONS_LIST_ADDRESS=`.
- Probe a running deployment — call `pool.sanctionsList()` and
  `privateSettlement.sanctionsList()` and check they return the
  same non-zero address.

## History

- 2026-05-12 — initial document. Captures the protocol-level
  enforcement model after the SanctionsList proxy was wired
  into `DeployLocal.s.sol` (this PR). The gate semantics
  themselves were already present in the boundary contracts'
  source; this document is the canonical reference for an
  exchange or regulator evaluating the protocol.
