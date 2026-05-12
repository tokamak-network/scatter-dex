# Boundary Memo

This memo explains what a third-party observer — including a
centralized exchange running standard chain-analysis tooling — can
see at every step of a ScatterDEX flow, and what stays private.

The goal is to position ScatterDEX correctly: the **boundary
(deposit, withdraw, settlement) is transparent and indexable on
L1/L2 explorers**. What is private is the **per-recipient amount,
the maker/taker pairing during matching, and the leaf-level
association between a settlement and a future claim**. This is
materially different from a mixer.

## Public surface

Every action below emits an indexable event on the chain ScatterDEX
is deployed to. The contract addresses, ABIs, and event schemas live
in the contracts repo and are linked from the docs site.

| User action | Public information |
|---|---|
| Deposit to `CommitmentPool` | Depositor address, token, amount, commitment hash, timestamp |
| Withdraw from `CommitmentPool` | Recipient address, token, amount, nullifier, timestamp |
| `settleAuth` (OTC match) | Relayer (msg.sender), claimsRoot, both nullifiers, both new commitments, fee routing, timestamp |
| `scatterDirectAuth` (single-issuer 1:N) | Issuer/relayer, claimsRoot, total locked, fee, timestamp |
| `settleWithDex` (asset conversion) | Relayer, external router address, AMM swap events on the router itself, claimsRoot, total locked, timestamp |
| `claimWithProof` / `claimWithProofBatch` | Recipient address, token, amount, claim nullifier, claimsRoot, timestamp |
| `cancelPrivate` (commitment rotation) | Submitter address, escrow nullifier, nonce nullifier, new commitment, timestamp |
| Relayer registry mutation | Relayer address, fee bps, API URL, status |
| Identity registry mutation | Subject hash, policy id, expiry (registry-dependent) |

## Private surface

The information below is not derivable from the public chain state
without breaking standard cryptographic assumptions or possessing
the user's secrets.

| Private item | Why it stays private |
|---|---|
| Sender identity at the original settle | The settle event references nullifiers and commitments, not the depositor's EOA. The link is hidden by the Poseidon commitment scheme. |
| Per-recipient amount within a `claimsRoot` | The claims tree is a Merkle root; only the recipient holding their leaf preimage knows which entry is theirs and for how much. Individual leaves are revealed only at the moment that specific recipient claims. |
| Pairing of maker and taker | Cross-side constraints are enforced in the ZK circuits; the on-chain event does not link a specific maker to a specific taker beyond the matching transaction's success. |
| Future intent before settlement | Orders sit off-chain at relayers until matched. The order book content is not on-chain. |
| User's full balance | Balances live as Poseidon commitments; the wallet UI computes them locally from the user's seed. |

## What an exchange sees when funds reach them

When a ScatterDEX user withdraws to their exchange deposit address,
the exchange sees:

1. The withdrawing EOA (the recipient address in `claimWithProof` or
   the depositor in a subsequent `CommitmentPool` withdrawal flow).
2. The previous on-chain history of that EOA — including any prior
   `claimWithProof` events, deposits, and any non-ScatterDEX activity.
3. The token and amount.

The exchange does **not** automatically obtain the original
counterparty in the matching that produced the funds, the
per-recipient amounts of other claims that shared the same
`claimsRoot`, or the user's pre-settlement balance. Those are
private by construction.

## What this is not

ScatterDEX is not designed to break the deposit/withdrawal trail at
the boundary. The pool entry (deposit) and the pool exit (claim or
withdrawal) both publish the EOA and the amount. Users wanting to
move funds to a centralized exchange will appear in the exchange's
own AML pipeline on receipt, with provenance traceable back to the
`PrivateSettlement` or `CommitmentPool` contract.

The protocol does not provide a primitive that severs the link
between a public on-ramp and a different public off-ramp. Pool
rotation (`cancelPrivate`) replaces a user's *own* commitment with a
new commitment owned by the *same* spending key and does not move
funds between users.

## What we explicitly do not support

- Operator-held viewing keys or global auditor backdoors. The
  protocol is non-custodial and does not store user spending or
  viewing secrets.
- A primitive that claims into a third party's commitment without
  that third party's authorization. (The previously proposed
  `claimToPool` redirect path was removed for design and security
  reasons.)
- A primitive that allows the recipient address bound to a claim
  leaf to be substituted at claim time. The claim circuit binds the
  recipient inside the leaf preimage; substituting it fails Merkle
  membership.

## How to verify

- Contract addresses and ABIs: see `CONTRACT-ADDRESSES.json` (added
  per network).
- Event schemas: linked from the contracts directory in the main
  repo.
- Indexed event listing: standard L1/L2 explorer queries on the
  `PrivateSettlement` and `CommitmentPool` addresses.
