# Dispute Registry: Reputation-Based Relayer Accountability

> **Status**: Design reference (pre-implementation)
> **Scope**: `contracts/src/DisputeRegistry.sol` — a **record-only** dispute system. No bond slashing, no economic penalty contract logic. Misbehavior is permanently recorded; reputation does the enforcement.
> **Related docs**:
> - [../circuit-split/design.md](../circuit-split/design.md) — maker/taker proof split (architectural prerequisite)
> - [../relayer-protocol/design.md](../relayer-protocol/design.md) — Waku v2 commit-reveal that produces dispute evidence
> - [../design-shared-orderbook.md](../../architecture/shared-orderbook.md) — current Trade Offer (legacy)
> - [../relayer-security.md](../../operations/relayer-security.md) — operational threat model
> - [../PAPER.md](../../research/PAPER.md) §Compliance — dual-CA identity model that makes reputation enforceable
> - [../../contracts/src/RelayerRegistry.sol](../../contracts/src/RelayerRegistry.sol) — relayer bond + identity gate (no changes required)
> - [../../contracts/src/zk/PrivateSettlement.sol](../../contracts/src/zk/PrivateSettlement.sol) — settlement events used as ground truth

## Motivation

### The original L-3 problem

`RelayerRegistry.sol` line 11 notes:
> NOTE (L-3): No bond slashing mechanism — malicious relayers lose only gas on failed settle() attempts. Consider adding slashing for repeated violations.

The naive fix is to add bond slashing, which requires complex contract logic: dispute games, challenge windows, evidence validation, slash distribution, accuser rewards, treasury splits, anti-grief deposits. We considered this and decided against it.

### Why reputation works better than slashing here

zkScatter has two structural properties that make a **record-only reputation system more effective than economic slashing**:

1. **Relayers earn from fees**, and fees only come from users. A relayer with a public misbehavior record loses users → loses fees → effectively self-slashes economically.
2. **Relayers are not anonymous**. The dual-CA identity model (see [../PAPER.md](../../research/PAPER.md) §Compliance) requires relayer-side **minimum-masked identity** — organization name, jurisdiction, license number are visible on-chain. A misbehaving relayer cannot escape by spinning up a new anonymous identity; rebuilding reputation under a new legal entity is expensive and slow.

Combined:
```
Misbehavior recorded → Public record → Frontend shows it
                                              ↓
              Users avoid the relayer → Fees → 0 → Business dead
                                              ↓
              Re-spawning under a new identity = months of legal work
                                              ↓
                  Effective penalty >> any slashable bond
```

The market does the slashing for us, and the dual-CA layer prevents identity laundering.

### What this design does NOT do

- Does not modify relayer bonds in any way
- Does not transfer assets between accuser, accused, or treasury
- Does not have a challenge period
- Does not require special accuser deposits
- Does not implement dispute games
- Does not depend on `DisputeRegistry` having any privileged access to other contracts

The bond in `RelayerRegistry.sol` remains exactly what it is today: a registration deposit. No changes required.

### What this design DOES do

- Provides a single on-chain function `recordDispute(...)` that verifies cryptographic evidence and emits a permanent log entry
- Provides an optional `rebutDispute(...)` so the accused can post counter-evidence (also a log entry, no state change)
- Defines an off-chain reputation aggregation model that consumes the events
- Defines a frontend display contract for showing relayer history to users

The entire on-chain footprint is **a verifier and an event emitter**.

## Dispute Types (recorded, not punished)

The three cryptographically-provable dispute types from the prior design carry over unchanged. Only the consequence changes (record instead of slash).

### Type 1: Abort after commit
A relayer signed a commit binding them to reveal a proof, and then failed to reveal within the deadline.

### Type 2: Reveal/commit mismatch
A relayer revealed a proof that does not hash to the same value as their original commit.

### Type 3: Double-commit
A relayer signed two distinct commits for the same `orderId` within overlapping reveal windows.

### Out of scope (same as before)
- **Invalid proof submission** — handled naturally by `PrivateSettlement.settleAuth` reverting on bad proofs
- **Censorship / gossip suppression** — not provable on-chain; addressed architecturally by user fan-out

## Evidence Schemas

Identical to the prior design (so the relayer-protocol's `RelayerCommit` and `RelayerReveal` schemas remain valid).

### `RelayerCommit` (EIP-712 typed data)
```
struct RelayerCommit {
    address relayer;        // committer
    bytes32 orderId;
    bytes32 commitHash;     // H(proofBytes || salt)
    uint256 roundId;        // monotonic per (R_M, R_T) pair
    uint256 commitTime;
    uint256 revealDeadline; // commitTime + REVEAL_WINDOW
    bytes32 counterpartyId; // H(counterparty relayer || roundId)
    uint32 protocolVersion;
}
```

### `RelayerReveal` (EIP-712 typed data)
```
struct RelayerReveal {
    address relayer;
    bytes32 orderId;
    bytes32 commitHash;     // must match the prior commit
    bytes proofBytes;
    bytes32 salt;
    uint256 revealTime;
}
```

EIP-712 domain separator must match what the [../relayer-protocol/design.md](../relayer-protocol/design.md) §4.3 messages use, so the same signatures are valid both as protocol messages and as on-chain dispute evidence.

## Contract API

The entire contract is approximately **150 lines of Solidity**.

```solidity
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {PrivateSettlement} from "./zk/PrivateSettlement.sol";

contract DisputeRegistry is EIP712 {
    enum DisputeType {
        AbortAfterCommit,
        RevealCommitMismatch,
        DoubleCommit
    }

    PrivateSettlement public immutable settlement;
    uint256 public constant REVEAL_WINDOW = 5 minutes;

    // ─── Events (the only stateful effect of this contract) ──────────
    event DisputeRecorded(
        bytes32 indexed disputeId,
        address indexed accused,
        address indexed accuser,
        bytes32 orderId,
        DisputeType dtype,
        bytes evidence,
        uint256 blockNumber
    );

    event DisputeRebutted(
        bytes32 indexed disputeId,
        address indexed accused,
        bytes counterEvidence,
        uint256 blockNumber
    );

    // ─── Errors ──────────────────────────────────────────────────────
    error InvalidSignature();
    error AlreadySettled();
    error CommitNotExpired();
    error CommitHashMatch();
    error CommitsAreSame();
    error WindowsDoNotOverlap();
    error OrderIdMismatch();

    constructor(address _settlement)
        EIP712("zkScatterDisputeRegistry", "1")
    {
        settlement = PrivateSettlement(_settlement);
    }

    // ─── Type 1: Abort after commit ──────────────────────────────────

    function recordAbort(
        RelayerCommit calldata commit,
        bytes calldata commitSig,
        RelayerReveal calldata accuserReveal,
        bytes calldata accuserRevealSig
    ) external returns (bytes32 disputeId) {
        // 1. Verify the accused signed the commit
        address recoveredAccused = _recoverCommit(commit, commitSig);
        if (recoveredAccused != commit.relayer) revert InvalidSignature();

        // 2. Verify the accuser actually followed the protocol (their reveal is valid)
        address recoveredAccuser = _recoverReveal(accuserReveal, accuserRevealSig);
        if (recoveredAccuser != msg.sender) revert InvalidSignature();

        // 3. Verify the reveal deadline has passed
        if (block.timestamp < commit.revealDeadline) revert CommitNotExpired();

        // 4. Verify no on-chain settlement happened for this orderId
        if (_isAlreadySettled(commit.orderId)) revert AlreadySettled();

        // 5. Record
        disputeId = keccak256(abi.encode(commit.relayer, commit.orderId, commit.roundId));
        emit DisputeRecorded(
            disputeId,
            commit.relayer,
            msg.sender,
            commit.orderId,
            DisputeType.AbortAfterCommit,
            abi.encode(commit, commitSig, accuserReveal),
            block.number
        );
    }

    // ─── Type 2: Reveal/commit mismatch ──────────────────────────────

    function recordMismatch(
        RelayerCommit calldata commit,
        bytes calldata commitSig,
        RelayerReveal calldata accusedReveal,
        bytes calldata accusedRevealSig
    ) external returns (bytes32 disputeId) {
        address recoveredAccused = _recoverCommit(commit, commitSig);
        if (recoveredAccused != commit.relayer) revert InvalidSignature();

        address recoveredRevealer = _recoverReveal(accusedReveal, accusedRevealSig);
        if (recoveredRevealer != commit.relayer) revert InvalidSignature();

        // The hash of (proof || salt) must NOT match the commit hash
        bytes32 actualHash = keccak256(abi.encodePacked(accusedReveal.proofBytes, accusedReveal.salt));
        if (actualHash == commit.commitHash) revert CommitHashMatch();
        // (If they matched it'd be a valid reveal, not a mismatch.)

        if (commit.orderId != accusedReveal.orderId) revert OrderIdMismatch();

        disputeId = keccak256(abi.encode(commit.relayer, commit.orderId, commit.roundId, "mismatch"));
        emit DisputeRecorded(
            disputeId,
            commit.relayer,
            msg.sender,
            commit.orderId,
            DisputeType.RevealCommitMismatch,
            abi.encode(commit, commitSig, accusedReveal, accusedRevealSig),
            block.number
        );
    }

    // ─── Type 3: Double-commit ───────────────────────────────────────

    function recordDoubleCommit(
        RelayerCommit calldata commitA,
        bytes calldata sigA,
        RelayerCommit calldata commitB,
        bytes calldata sigB
    ) external returns (bytes32 disputeId) {
        // Both must be signed by the same relayer
        address recoveredA = _recoverCommit(commitA, sigA);
        address recoveredB = _recoverCommit(commitB, sigB);
        if (recoveredA != recoveredB) revert InvalidSignature();
        if (commitA.relayer != recoveredA) revert InvalidSignature();

        // Same orderId
        if (commitA.orderId != commitB.orderId) revert OrderIdMismatch();

        // Different commits (otherwise it's the same commit, not a double)
        if (commitA.commitHash == commitB.commitHash &&
            commitA.counterpartyId == commitB.counterpartyId) revert CommitsAreSame();

        // Reveal windows must overlap
        uint256 latestStart = commitA.commitTime > commitB.commitTime
            ? commitA.commitTime
            : commitB.commitTime;
        uint256 earliestEnd = commitA.revealDeadline < commitB.revealDeadline
            ? commitA.revealDeadline
            : commitB.revealDeadline;
        if (latestStart >= earliestEnd) revert WindowsDoNotOverlap();

        disputeId = keccak256(abi.encode(commitA.relayer, commitA.orderId, commitA.commitHash, commitB.commitHash));
        emit DisputeRecorded(
            disputeId,
            commitA.relayer,
            msg.sender,
            commitA.orderId,
            DisputeType.DoubleCommit,
            abi.encode(commitA, sigA, commitB, sigB),
            block.number
        );
    }

    // ─── Rebuttal (accused posts counter-evidence) ───────────────────

    function rebutDispute(bytes32 disputeId, bytes calldata counterEvidence) external {
        // No on-chain validation — the rebuttal is just a public record.
        // Off-chain reputation systems weigh disputes vs rebuttals.
        emit DisputeRebutted(disputeId, msg.sender, counterEvidence, block.number);
    }

    // ─── Internal helpers ────────────────────────────────────────────

    function _recoverCommit(RelayerCommit calldata commit, bytes calldata sig)
        internal view returns (address)
    { /* EIP-712 hash + ECDSA.recover */ }

    function _recoverReveal(RelayerReveal calldata reveal, bytes calldata sig)
        internal view returns (address)
    { /* EIP-712 hash + ECDSA.recover */ }

    function _isAlreadySettled(bytes32 orderId) internal view returns (bool) {
        return settlement.orderSettled(orderId);
    }
}
```

**Total contract complexity**: 4 external functions, no mutable state (only events), no admin, no upgrades.

## Optional `PrivateSettlement` extension

To let `_isAlreadySettled` work cryptographically, add a single mapping to `PrivateSettlement.sol`:

```solidity
// In PrivateSettlement.sol — single line addition
mapping(bytes32 => bool) public orderSettled;

// In settleAuth, after successful verification:
orderSettled[m.orderId] = true;
```

**Cost**: one extra SSTORE per settlement (~20k gas, ~1.2% increase over the ~1.6M baseline). Acceptable.

**Alternative (zero-cost)**: rely on the existing `PrivateSettledAuth` event and have off-chain indexers prevent disputes for already-settled orders before submission. The contract can't enforce this directly without storage. **Recommendation**: do the small `PrivateSettlement` addition.

## How Reputation is Built

The on-chain `DisputeRegistry` is intentionally minimal. **Reputation lives off-chain**, computed by indexers from the event log.

### Off-chain reputation indexer (illustrative)

```
Inputs (from on-chain logs):
  - DisputeRegistry.DisputeRecorded events
  - DisputeRegistry.DisputeRebutted events
  - PrivateSettlement.PrivateSettledAuth events
  - RelayerRegistry.RelayerRegistered / RelayerExited events

For each relayer, compute:
  - total_settlements   = count(PrivateSettledAuth where relayer in {makerRelayer, takerRelayer})
  - dispute_count       = count(DisputeRecorded where accused == relayer)
  - rebuttal_count      = count(DisputeRebutted where accused == relayer)
  - dispute_rate        = dispute_count / max(total_settlements, 1)
  - last_dispute_block  = max block of any DisputeRecorded against this relayer
  - days_since_dispute  = (now - last_dispute_block) in days
  - tenure_days         = (now - registered_at) in days

Reputation score (0-100, illustrative):
  base = 100
  - dispute_rate * 1000     // every 1% dispute rate costs 10 points
  - dispute_count * 5       // each absolute dispute costs 5 points
  + min(tenure_days / 30, 20)  // up to 20 points for 600+ days tenure
  + min(total_settlements / 100, 30)  // up to 30 points for 3000+ trades
  + recent_recovery_bonus(days_since_dispute)
```

Indexers can be:
- The zkScatter team's reference indexer (initial)
- Independent third-party indexers (over time)
- Frontend-embedded indexer for fully decentralized usage

No single indexer is canonical. Users see whichever indexer their frontend connects to.

### Frontend display

When users select a relayer, the frontend shows reputation:

```
┌─────────────────────────────────────────────────┐
│ Choose a relayer                                │
├─────────────────────────────────────────────────┤
│                                                  │
│ ⭐⭐⭐⭐⭐ Bob's Relayer LLC (Singapore)         │
│   • 5,247 trades • 0 disputes                   │
│   • Active since Jan 2026                       │
│   • Identity verified (CA: GlobalSign-EU)       │
│   [ Select ]                                     │
│                                                  │
│ ⭐⭐⭐ Charlie Inc (Delaware, USA)               │
│   • 1,832 trades • 3 disputes ⚠                 │
│     - Abort after commit (Mar 12, rebutted)     │
│     - Reveal mismatch (Mar 28)                  │
│     - Abort after commit (Apr 02)               │
│   • Identity verified (CA: DigiCert-US)         │
│   [ Select with caution ]                        │
│                                                  │
│ ⭐⭐ NewBoy Co (Estonia)                         │
│   • 12 trades • 0 disputes                      │
│   • Active for 5 days (low tenure)              │
│   [ Select ]                                     │
│                                                  │
└─────────────────────────────────────────────────┘
```

The user makes an informed choice. The market does the slashing.

### Anti-gaming considerations

Reputation systems have known failure modes. Mitigations:

| Attack | Mitigation |
|---|---|
| Sybil disputes (file many fake disputes) | Cryptographic verification — invalid evidence reverts on-chain |
| Coordinated bad-mouthing | Multiple independent indexers; users can compare |
| Identity laundering (new entity to escape reputation) | Dual-CA model — minimum identity masking makes new-entity creation expensive and slow |
| Pre-launch reputation farming | Frontend penalizes very-new relayers (< 30 days tenure) |
| "Cleared" rebuttals manipulating display | Frontend shows rebuttal but doesn't auto-clear the original; user sees both |
| Indexer collusion | Open-source indexer; multiple operators; on-chain log is the source of truth |

## Cost Analysis

### Gas costs

| Operation | Estimated gas | Notes |
|---|---|---|
| `recordAbort` | ~80k | 2 ECDSA recover + 1 SLOAD + event |
| `recordMismatch` | ~80k | 2 ECDSA recover + keccak + event |
| `recordDoubleCommit` | ~85k | 2 ECDSA recover + comparisons + event |
| `rebutDispute` | ~25k | Just an event emit |
| `PrivateSettlement.orderSettled` mapping write (added) | +20k | One extra SSTORE per settle |

**At mainnet 30 Gwei (~$2900/ETH)**:
- Recording a dispute: ~$7
- Rebutting: ~$2
- Extra cost per settle from the new mapping: ~$1.70

### Comparison with the prior slash-based design

| Aspect | Slash-based (rejected) | Record-based (this) |
|---|---|---|
| Contract LOC | ~400 | ~150 |
| Storage variables | ~10 | 0 |
| Functions | 8+ | 4 |
| Admin functions | 3 | 0 |
| Economic parameters | 9 | 0 |
| Challenge windows | Yes (3 days) | No |
| Bond manipulation | Yes | No |
| Reward distribution | Yes | No |
| Audit surface | Large | Tiny |
| Implementation effort | Weeks | Days |
| Worst-case false action | Honest relayer slashed | Honest relayer publicly accused (rebuttal possible) |
| Recovery from false action | Refund (complex) | Rebuttal + indexer reweighting |

The record-based design has roughly **1/4 the implementation cost** and **1/10 the audit surface**.

## Threat Analysis

### What this protects against
- A relayer that commits and then refuses to reveal during cross-relayer matching
- A relayer that reveals a proof inconsistent with their commitment
- A relayer that double-books the same order to multiple counterparties

### What this does NOT protect against
- **Fast exit scams** — a relayer that runs many successful trades and then disappears with no disputes filed will have a clean record. The dual-CA identity is the protection here, not the dispute system.
- **Subtle off-chain misbehavior** — censorship, slow responses, biased matching. These leave no on-chain evidence. Off-chain reputation systems based on user reviews or uptime monitoring address these.
- **Indexer manipulation** — a malicious frontend can show falsified reputation. Users should cross-check from multiple indexers; the on-chain log is the source of truth.
- **Coordinated honest-relayer takedown** — adversaries colluding to file disputes against an honest relayer. The cryptographic evidence requirement prevents *invalid* disputes, but a sufficiently sophisticated attacker who actually has commit signatures from a target relayer (e.g., due to key compromise) could file real-looking disputes. **This is the same risk as any reputation system** and is mitigated by indexer diversity and the rebuttal mechanism.

### What used to be a threat and isn't anymore
- **Bond loss for honest relayers** — no longer possible because no slashing happens
- **Dispute griefing for economic gain** — accusers don't get paid in this design
- **Treasury extraction attacks** — no treasury involved

## Open Questions

### OQ-1: Should `_isAlreadySettled` be enforced on-chain or off-chain?
On-chain (with the `orderSettled` mapping addition to `PrivateSettlement`) is safer but adds gas to every settlement. Off-chain (with indexer pre-check) is gas-free but allows malicious post-settlement disputes. **Recommendation**: on-chain. The cost is 1.2% of settlement gas, which is acceptable for the integrity guarantee.

### OQ-2: Should rebuttal evidence be validated on-chain?
Currently `rebutDispute` is a free-form event emit with no validation. We could require the rebutter to submit verifiable counter-evidence (e.g., a settlement tx hash + block number, or a valid late reveal). **Recommendation**: keep it free-form. Off-chain reputation systems can weigh evidence quality. Adding on-chain validation would add complexity for marginal gain.

### OQ-3: Should there be a time limit for filing disputes?
A relayer could in principle have a dispute filed against them years after the alleged misbehavior. **Recommendation**: no on-chain time limit (events are public regardless), but **frontend reputation systems should weight recent disputes more heavily** and decay old ones. After ~1 year, an old dispute should have minimal effect on display reputation.

### OQ-4: Cold-start for new relayers
New relayers have low tenure and thin trade history, making them look risky on the reputation display. This creates a chicken-and-egg problem. **Mitigations**:
- Frontend displays "low tenure" as a neutral note, not a negative score
- Recommended initial relayer set curated by zkScatter team
- Onboarding incentives (reduced fees for first N trades) to bootstrap volume

### OQ-5: Relayer re-registration after self-exit
A relayer can voluntarily exit (`requestExit` → `executeExit`) and re-register later from the same address. Their dispute history persists (the address is the same). **Recommendation**: this is correct behavior; reputation should not be wiped by exit/re-entry.

### OQ-6: Indexer governance
Who runs the canonical reputation indexer? How are scoring algorithms updated? **Decision deferred** to operational governance. For MVP, ship a reference indexer in the zkScatter monorepo, document the scoring formula, and invite third-party indexers to compete.

## Migration from prior slash-based design

The earlier draft of this document (titled "Dispute Resolver: On-chain Bond Slashing") proposed extensive slash-based machinery: bond manipulation, challenge windows, reward distribution, anti-grief deposits. **All of that is removed.**

Specifically:
- ❌ `RelayerRegistry.slash()` — not added
- ❌ `RelayerRegistry.setDisputeResolver()` — not added
- ❌ `RelayerRegistry.requestExit()` modification — not needed
- ❌ Challenge period — not present
- ❌ Slash parameters (`SLASH_BPS_TYPE1/2/3`, `ACCUSER_REWARD_BPS`, `TREASURY_BPS`) — not defined
- ❌ Dispute deposit / anti-grief mechanics — not needed
- ✅ `PrivateSettlement.orderSettled` mapping — small addition (~20k gas per settle)
- ✅ `DisputeRegistry.sol` — new contract, ~150 LOC, stateless except for events

The L-3 note in `RelayerRegistry.sol` is now answered by: **"slashing is unnecessary because reputation built from public records is more effective in a non-anonymous federated system."** Update the L-3 comment in code accordingly when the new contract ships.

## Implementation Roadmap

### Sprint 1: Contract
- [ ] Define EIP-712 domain separators (must match relayer-protocol's `RelayerCommit`/`RelayerReveal`)
- [ ] Implement `DisputeRegistry.sol` (~150 LOC)
- [ ] Add `mapping(bytes32 => bool) public orderSettled` to `PrivateSettlement.sol` and populate on settlement
- [ ] Unit tests for each dispute type (positive + negative paths)
- [ ] Integration tests with `PrivateSettlement` + `RelayerRegistry`

### Sprint 2: Indexer
- [ ] Reference reputation indexer (Node.js or Rust)
- [ ] Scoring formula implementation
- [ ] REST API for frontend consumption
- [ ] Documentation of scoring methodology

### Sprint 3: Frontend
- [ ] Relayer selection UI with reputation display
- [ ] Per-relayer dispute history view
- [ ] Rebuttal display (showing both accusation and accused's response)
- [ ] Visual cues (badges, colors) for reputation tiers

### Sprint 4: Relayer SDK
- [ ] Auto-detect abort during commit-reveal
- [ ] Auto-file dispute via `recordAbort` after reveal deadline + grace period
- [ ] Auto-rebut: detect false dispute, post counter-evidence
- [ ] Configuration: opt-in/out of automatic dispute filing

### Sprint 5: Documentation & Operator Guide
- [ ] Relayer operator guide: "what disputes mean for you"
- [ ] Indexer operator guide: "how to run a third-party reputation service"
- [ ] User guide: "how to read relayer reputation"

## References

### Internal
- [../../contracts/src/RelayerRegistry.sol](../../contracts/src/RelayerRegistry.sol) — relayer bond + identity (no changes)
- [../../contracts/src/zk/PrivateSettlement.sol](../../contracts/src/zk/PrivateSettlement.sol) — settlement contract (one mapping added)
- [../circuit-split/design.md](../circuit-split/design.md) — split proofs that produce commit-reveal evidence
- [../relayer-protocol/design.md](../relayer-protocol/design.md) — Waku v2 protocol that produces signed commits/reveals
- [../PAPER.md](../../research/PAPER.md) §Compliance — dual-CA identity model
- [../architecture-v2.md](../../architecture/architecture-v2.md) — overall architecture entry point

### External
- **Lemon market** (Akerlof 1970) — economic theory of how unrated quality drives bad actors out of markets
- **Yelp / Trustpilot** — non-cryptographic reputation systems as reference
- **Lightning Network channel state proofs** — comparison: Lightning slashes via penalty txs because nodes can be anonymous; zkScatter doesn't need slashing because relayers are not anonymous
- **EIP-712** — typed structured data hashing and signing

---

*This document was previously titled "Dispute Resolver" with a slash-based design. The folder was renamed from `dispute-resolver/` to `dispute-registry/` to reflect the shift from slash-and-resolve to record-and-display.*
