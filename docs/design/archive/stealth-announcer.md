# Stealth Announcer — design note (deferred)

Status: **proposal, not implemented** — deferred pending roadmap decision.
Created: 2026-04-14.

Context for a future revisit: the mobile app (and web) currently
requires the sender to deliver a claim JSON (containing the stealth
`ephemeralPubKey`) to the recipient out-of-band so the recipient can
compute `deriveStealthPrivateKey` and claim the funds. This is
functional but gives a significantly worse UX than a normal wallet
that auto-detects incoming transfers.

Fixing the UX means the recipient's client has to auto-discover
incoming stealth transfers without the sender's help. That requires
the sender's `ephemeralPubKey` to live on some public channel the
recipient can scan.

## Why the stealth address on-chain isn't enough

`PrivateSettlement.PrivateClaim` already emits the stealth `recipient`
address. That is public. The missing piece is `ephemeralPubKey`
(a.k.a. `R_pub`, the sender's one-time pubkey per transfer):

```
sender:    r · V_pub                 = s
recipient: v · R_pub                 = s           (same secret, ECDH)

stealth addr = keccak(S_pub + s·G)[12:]
```

Without `R_pub`, the recipient holding only their viewing key `v`
cannot tell whether a given `recipient` address belongs to them — the
derivation is one-way. The ECDH trick is only symmetric when both
sides know their own secret AND their counterpart's public key.

## Options considered

| Path | Contract change | New server / service | Privacy | Standard |
|---|---|---|---|---|
| A. Out-of-band JSON (current) | no | no | high | – |
| B. Add `ephemeralPubKey` to `PrivateSettlement.PrivateClaim` event | **yes (audit)** | no | same as A on-chain | – |
| C. Deploy a separate `StealthAnnouncer` contract (EIP-5564 shape) | **no** | no | same as B on-chain | EIP-5564 |
| D. Off-chain `shared-orderbook` announcement endpoint | no | **yes** | degraded (IP/timing correlation) | – |

## Recommended direction — Option C

**Deploy a standalone `StealthAnnouncer` contract.** Keeps
`PrivateSettlement` untouched (no re-audit), matches the ERC/EIP-5564
announcer pattern, gives recipients a single public event stream to
scan.

Sketch:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract StealthAnnouncer {
    // Indexed `stealthAddress` so recipients/indexers can filter by the
    // destination they already derived. `ephemeralPubKey` carries the
    // 33-byte compressed pubkey the recipient needs for ECDH.
    event Announcement(
        address indexed stealthAddress,
        bytes   ephemeralPubKey,
        bytes   metadata          // reserved — keep "" in v1
    );

    function announce(
        address stealthAddress,
        bytes calldata ephemeralPubKey
    ) external {
        require(ephemeralPubKey.length == 33, "bad ephemeral pubkey");
        emit Announcement(stealthAddress, ephemeralPubKey, "");
    }
}
```

Sender flow becomes:

1. Existing `settlePrivate` / `claimWithProof` / similar tx.
2. **New** `announcer.announce(stealthAddr, R_pub)` tx (or a single
   multicall wrapping both).

Recipient flow becomes:

1. `queryFilter` on `StealthAnnouncer.Announcement` from some watermark block.
2. For each event, try ECDH with local viewing key; if the derived
   address matches `stealthAddress`, auto-register a pending claim
   (same storage shape mobile's `PendingClaimsStorage` uses today).
3. Keep the out-of-band JSON paste path too — fallback when
   announcements are missed or when users prefer not to scan.

## Trade-offs to close out before implementing

- **Gas cost** on sender: +1 tx per private claim (amortizable via
  multicall or EIP-7702 batcher).
- **Scan cost** on recipient: O(N) ECDH trials per session over
  announcements newer than the local watermark. Bounded by
  `queryFilter` page size; caching the tried-block watermark in
  AsyncStorage keeps it to incremental scan after the first pass.
- **Privacy delta vs. current baseline**:
  - `stealthAddress` + `amount` + `token` are already on-chain via
    `PrivateClaim`. Adding `R_pub` does not reveal *which* meta-address
    the recipient holds (only the recipient with `v` can link the two).
  - External observer *can* correlate "same sender" across stealth
    transfers if senders reuse the announcer contract per session and
    their submitter address is the same. Mitigation: senders submit
    the `announce` tx through a relayer / MEV-protected path.
- **Spam / DoS**: the announcer is permissionless; an attacker can
  post bogus `(stealthAddress, R_pub)` pairs to inflate recipient scan
  cost. Mitigations to consider:
  - Minimum ETH value locked per announcement (forfeited to protocol
    treasury on dispute).
  - Bloom-filter hint in metadata so recipients can pre-filter before
    doing ECDH.
  - Rate-limit per submitter address.
- **Censorship**: announcer is a smart contract, so censorship
  resistance equals the underlying chain's. No worse than the current
  `PrivateClaim` event.

## Why *not* Option D (shared-orderbook endpoint)

Tempting because it needs no contract work, but:

- The server sees `(ephemeralPubKey, stealthAddress, IP, timestamp)`
  for every announcement and every recipient poll. IP + timing
  correlation is a new deanonymization vector vs. the on-chain
  baseline.
- Server liveness becomes a new dependency — if the server is down,
  recipients stop seeing incoming funds silently. Nullifiers remain
  unspent, locking funds.
- Server operator can drop or delay announcements as a censorship
  lever.

Given this is a privacy-first chain, moving the only channel for
stealth discovery off-chain is a strict downgrade.

## What needs to happen to pick this up

1. Roadmap call: is the UX gain (auto-discovery of incoming stealth
   claims) worth a new contract deployment?
2. If yes, scope the implementation:
   - Contract + unit tests (contracts/src/zk/StealthAnnouncer.sol).
   - Whitelist of senders / bond requirement if spam becomes real.
   - Mobile: new `hooks/useStealthAnnouncements.ts` that calls
     `queryFilter`, caches watermark in AsyncStorage, runs ECDH per
     event, registers matches via `PendingClaimsStorage`.
   - Web: equivalent hook on the private-claim page so the two
     clients don't diverge again.
   - Sender-side UX: multicall or relayer-bundled tx so users see one
     confirmation, not two.
3. Deprecate the JSON-paste path eventually, but keep it available as
   a fallback until the announcer has measurable coverage.

## Open questions

- Do we want to let senders publish `metadata` (encrypted claim
  preview, amount, token symbol, etc.) so recipients can render the
  card without reading the chain again? Adds UX value but increases
  event size and potential leakage surface.
- Should the announcer itself do a cheap sanity check on
  `stealthAddress` (non-zero, not a known contract)? Cheaper than
  pushing the check to every client.
- How do we watermark scans on a fresh install (user restored from
  seed on a new device)? Either scan from chain tip (miss historical)
  or from the user's meta-address creation block (expensive).

---

Referenced from: mobile task backlog "자동 PrivateClaim 이벤트 인덱서
(viewing key ECDH)" — closed without implementation in favour of
producing this note.
