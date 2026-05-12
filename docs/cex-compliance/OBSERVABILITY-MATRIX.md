# Observability Matrix

Table form of the [Boundary Memo](./BOUNDARY-MEMO.md). Each user
action is mapped to what an outside observer (centralized exchange,
chain-analysis tool, regulator) can determine from public chain
state alone.

| Action | Visible | Hidden | Event |
|---|---|---|---|
| Deposit to CommitmentPool | depositor EOA, token, amount, commitment hash, timestamp | future settlement counterparties, future claim recipients | `CommitmentInserted` (+ ERC-20 `Transfer`) |
| Withdraw from CommitmentPool | recipient EOA, token, amount, nullifier, timestamp | provenance chain inside the pool | `Withdrawal` (+ ERC-20 `Transfer`) |
| settleAuth (OTC match) | relayer (msg.sender), claimsRoot, both nullifiers, both new commitments, fee routing, timestamp | which depositor produced each side, per-recipient amount detail inside the claimsRoot | `PrivateSettledAuth` |
| scatterDirectAuth (1:N) | issuer/relayer, claimsRoot, total locked, fee, timestamp | per-recipient amount detail until each recipient claims | `PrivateScatterDirectAuth` |
| settleWithDex (asset conversion) | relayer, external router address, AMM swap events on the router itself, claimsRoot, total locked, timestamp | per-recipient amount detail | `PrivateSettledDex` |
| claimWithProof | recipient EOA, token, amount, claim nullifier, claimsRoot, timestamp | which leaf index inside the claimsRoot, other unclaimed leaves of the same root | `PrivateClaim` |
| claimWithProofBatch | up to 20 (recipient, amount, token, nullifier) tuples plus the same metadata as claimWithProof | same as claimWithProof | `PrivateClaim` × N |
| cancelPrivate (commitment rotation) | submitter EOA, escrow nullifier, nonce nullifier, new commitment hash, timestamp | the user's identity beyond the submitter EOA | `PrivateCancel` |
| Relayer register / update / exit | relayer EOA, fee bps, API URL, bond amount, status | nothing additional | `RelayerRegistered` / etc. |
| IdentityGate registry mutation | subject hash, policy id, expiry, attesting CA root (registry-dependent) | the underlying X509 cert content, the legal-identity name | `IdentityRegistered` / per-registry event |

## How to read this table for a deposit-and-withdraw cycle

1. User X deposits to `CommitmentPool` → exchange-grade chain
   analytics observes "X put N USDC into the pool".
2. User X participates in `settleAuth` (or `scatterDirectAuth`,
   `settleWithDex`) → no link to X is published; only the relayer
   appears on-chain.
3. User Y (the recipient, possibly the same person or a different
   one) calls `claimWithProof` → analytics observes "Y received M
   USDC from the protocol".

The observable link from X to Y is **the protocol itself**: chain
analytics will mark Y's funds as having flowed through
ScatterDEX, exactly as if Y had received from any other smart
contract. ScatterDEX does not provide a primitive that hides this
fact.

What chain analytics cannot do without additional information:

- Tell which of the N recipients sharing a `claimsRoot` is Y.
- Tell who X was (the original depositor) for any specific Y.
- Tell what X's balance was at any point during the flow.

## Updating this matrix

This file is **the contract**: if a change to the protocol changes
what is visible vs. hidden, this matrix must be updated in the same
PR. Reviewers should reject changes that move an item from "visible"
to "hidden" without a written justification.
