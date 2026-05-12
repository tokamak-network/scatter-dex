# Sanctions Enforcement Model

This document explains how ScatterDEX enforces the on-chain
sanctions blocklist — which entry points check the list, what
happens when an address is added or removed, and what the
operational implications are for an exchange or regulator
evaluating the protocol.

## What the gate does, in one sentence

**The gate refuses to execute actions involving a sanctioned
address. It does not hide anything.**

Specifically:

- A sanctioned address cannot **deposit** to the commitment pool.
- A sanctioned address cannot be the **recipient of a claim**.
  At settle time the relevant amount has already been transferred
  from `CommitmentPool` to `PrivateSettlement` (via
  `CommitmentPool.transferToSettlement`) and is tracked under
  `PrivateSettlement.claimsGroups[claimsRoot]`. The recipient
  refusal at `claimWithProof` time leaves that balance sitting on
  `PrivateSettlement` — claimable in principle, but only by the
  bound recipient, so the leaf becomes effectively dead state.
- A sanctioned address cannot **withdraw** from the pool, nor can
  funds be withdrawn *to* a sanctioned address.
- A sanctioned relayer cannot **match orders** or **submit
  settlements**.

What stays the same regardless of sanctions status:

- Every on-chain action that did succeed is still publicly visible
  on the chain explorer.
- Commitment-tree inserts, nullifier publications, settlement
  events, claim events, and pool balance totals are all observable
  the same way they are for any other address.
- Adding an address to the sanctions list does **not** retroactively
  erase past activity from the chain. It only refuses the *next*
  action that involves that address.

Funds an address held before sanctions are not moved, hidden, or
zeroed by the sanctions event. They simply become **frozen**:

- If they're still in `CommitmentPool` (as a commitment the address
  has not yet spent), they sit there indefinitely — the deposit
  remains on chain, but withdraw / settle paths refuse to act on
  it.
- If they were already settled to that address (i.e. moved to
  `PrivateSettlement.claimsGroups[...]` at settle time, awaiting
  a `claimWithProof` call), the balance stays on the settlement
  contract — `claimWithProof` refuses the now-sanctioned recipient.

In both cases the on-chain state is unchanged at the moment the
address is sanctioned. The gate refuses the *next* action that
would move those funds.

## Where the check fires

The protocol's sanctions gate is enforced at the state-changing
boundary entry points listed below. The check itself is uniform —
if a non-zero `SanctionsList` is registered and the checked
address is on it, the call reverts.

| Entry point | Checked address | Notes |
|---|---|---|
| `CommitmentPool.deposit` | `msg.sender` (the depositor) | Pool entry |
| `CommitmentPool.withdraw` | both the proof submitter and the `recipient` | Pool exit |
| `PrivateSettlement.settleAuth` | `msg.sender` (the matching relayer) | OTC match — relayer-level gate |
| `PrivateSettlement.settleWithDex` | `msg.sender` (the relayer running the asset-conversion path) | Same — relayer-level |
| `PrivateSettlement.scatterDirectAuth` | `msg.sender` (the relayer / issuer of the self-distribution proof) | Same — relayer-level |
| `PrivateSettlement.claimWithProof` (called per-leaf by both `claimWithProof` and `claimWithProofBatch`) | `recipient` baked into the leaf preimage | **Beneficiary-level gate** — the load-bearing piece (see next section) |

All source for the above lives in `contracts/src/zk/CommitmentPool.sol`
and `contracts/src/zk/PrivateSettlement.sol`.

### Entry points without a direct in-function check

The following entry points exist on `PrivateSettlement` but do
**not** themselves call `_requireNotSanctioned`. They are listed
for completeness so an auditor isn't surprised:

- **`cancelPrivate`** — escrow rotation (same balance, new salt
  back to the same owner pubkey). The cancel circuit binds the
  submitter inside the proof, so funds never leave the
  submitter's own escrow. Pool deposit / withdraw / claim — the
  paths funds actually leave through — still carry the gate, so
  a sanctioned address cannot extract the rotated funds.
- **`scatterDirect`** (the legacy non-auth variant, not
  `scatterDirectAuth`) — restricted to `onlyRelayer`, so the
  relayer-registry path is the gate. The funds it routes still
  land in `claimsGroups[…]` and become subject to the
  beneficiary-level claim-time gate before any user receives
  them.
- **`claimWithProofBatch`** — wraps `claimWithProof` per leaf, so
  every leaf in the batch goes through the recipient-level
  check. The batch wrapper itself doesn't need a separate
  check.

Adding a direct check to these is a follow-on item if the audit
recommends defence-in-depth; the current claim-time and pool
boundary gates already prevent funds from reaching a sanctioned
address by any of these paths.

The same `ISanctionsList` interface lets the operator swap the
default `SanctionsList` implementation for the Chainalysis SDN
Oracle (`0x40C57923...`) or any other compatible blocklist —
the entry points read through the interface so no contract code
needs to change.

## The "claim-time gate" — the load-bearing piece

The settlement / scatter / settle-with-dex entry points check
`msg.sender` — which for a privacy-preserving relayer protocol is
the **relayer** submitting the proof, not the beneficiary. So
this layer is best described as a relayer-side filter: a relayer
on the sanctions list cannot match orders or run an
asset-conversion settle. It is not a beneficiary-level screen at
this stage, by design — the beneficiary is hidden inside the ZK
proof and only revealed at claim time.

The **claim** entry point is where the beneficiary-level gate
lives. `claimWithProof` (and `claimWithProofBatch`, which loops
through `_executeClaim`) checks the `recipient` address — the
address baked into the claim leaf's preimage and revealed in the
public signals. That gate is the load-bearing one for the
protocol's compliance posture, because:

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
every pre-existing claim leaf bound to that address — but the
retroactive effect is on *future actions*, not on past on-chain
state. There is no grandfathering of new attempted transactions,
and no rewriting of history.

Consequences:

- Funds already settled to a now-sanctioned address stay locked
  on `PrivateSettlement` under `claimsGroups[claimsRoot]`. (At
  settle time, `CommitmentPool.transferToSettlement` moves the
  ERC-20 token balance from the pool into the settlement
  contract; the per-leaf entitlement lives in
  `PrivateSettlement.claimsGroups[...]` until claimed.) The leaf
  preimage and the on-chain state are unchanged by the sanctions
  event; only the `claimWithProof` call for that leaf now
  reverts.
- The original sender cannot reclaim those funds either (the
  claim circuit binds the recipient inside the leaf preimage; a
  third party — sender or anyone else — cannot substitute a
  different recipient without breaking the Merkle membership
  check).
- An OFAC SDN listing that lands between settlement and claim
  effectively turns the routed amount into a frozen on-chain
  balance on `PrivateSettlement`: it remains visible on-chain
  (the contract's ERC-20 holdings, and the matching
  `claimsGroups[...]` storage), but no entry point will accept a
  transaction that would move it to the sanctioned recipient.

This is intentional. From an exchange's risk perspective the
property to subscribe to is:

> *"Once the operator multisig adds an address to SanctionsList,
> no future on-chain action can move funds to or from that address
> through the ScatterDEX entry points. Past activity by that
> address stays observable on chain — the gate refuses actions,
> not data."*

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

- **Does not hide anything.** Adding an address to the sanctions
  list refuses future actions involving that address. It does not
  redact, erase, or obscure any on-chain data. Past commitments,
  nullifiers, settlements, claims, and pool balances stay
  observable on chain. Chain analytics tooling continues to see
  exactly what it would see otherwise.
- **Does not screen the original depositor of funds that a third
  party later claims.** The check fires on the address acting at
  each entry point — depositor at deposit time, relayer at
  settle time, recipient at claim time. Chain analytics outside
  the protocol can still trace fund provenance; the on-chain
  gate only refuses the specific actions listed above.
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
