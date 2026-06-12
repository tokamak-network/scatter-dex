# zkScatter Architecture v2: Federated Relayers + Client-side Proving

> **Status**: Design phase. Three sibling design documents specify the next-generation zkScatter architecture. This document is the **entry point** that ties them together.

## TL;DR

zkScatter is evolving from a **single-relayer custodial-witness model** (current) to a **federated relayer + client-side proving + fair-exchange** model. The change consists of three coordinated sub-designs:

1. **[circuit-split/design.md](../design/circuit-split/design.md)** — the **Half-proof** primitive: replace the monolithic `settle.circom` with `authorize.circom`, so each user independently proves their own side in the browser. The relayer matches two `authorize` proofs and submits them as a single `settleAuth(makerProof, takerProof)` transaction. Relayers stop seeing witness data entirely.
2. **[relayer-protocol/design.md](../design/relayer-protocol/design.md)** — replace HTTP Trade Offer with a Waku v2-based gossip + commit-reveal protocol. Relayers communicate directly with each other.
3. **[dispute-registry/design.md](../design/dispute-registry/design.md)** — record cryptographic dispute evidence on-chain (no slashing); reputation built off-chain from event log; users avoid bad relayers via frontend display. Closes the L-3 TODO in `RelayerRegistry.sol` without bond manipulation.

These three are **mutually dependent** and must be designed and rolled out together. Each one alone is incomplete:

- The split is pointless without a relayer protocol that transports two proofs
- The relayer protocol's commit-reveal needs the dispute registry to make abort detectable
- The dispute registry has nothing to record without commit-reveal messages from the protocol

## Why this is happening

### Problem 1: Witness data exposure
Today, relayers receive `ownerSecret`, `salt`, `balance`, `claimSecrets`, EdDSA private keys for every order they handle. This is documented in `docs/operations/relayer-security.md` §Data Classification as critical-sensitivity data, and the entire current threat model (§1-§3) revolves around protecting it. The whole problem disappears if relayers never see the witness in the first place.

### Problem 2: HTTP Trade Offer is unauditable
The current cross-relayer matching protocol (`docs/architecture/shared-orderbook.md` Phase 2) sends full orders with secrets between relayers over HTTPS. There's no on-chain commitment to a trade before settlement. A misbehaving relayer can simply ignore a Trade Offer with no consequences. This blocks the deployment of any meaningful slashing mechanism.

### Problem 3: No bond slashing
`RelayerRegistry.sol` line 11 explicitly notes:
> NOTE (L-3): No bond slashing mechanism — malicious relayers lose only gas on failed settle() attempts. Consider adding slashing for repeated violations.

The current bond is purely a registration deposit, not an economic security primitive.

## How the three documents fit together

```
┌─────────────────────────────────────────────────────────────────┐
│                      USER (browser)                              │
│   - Generates own ZK proof in browser (snarkjs WASM)           │
│   - Submits proof + fee to chosen relayer                       │
│   - Goes offline                                                │
│                                                                  │
│   Defined in:  circuit-split/design.md                          │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼ HTTPS (proof only, no witness)
                               │
┌──────────────────────────────┴───────────────────────────────────┐
│                  RELAYER FEDERATION                              │
│   - Each relayer runs Waku v2 node                              │
│   - Gossips public order announcements                          │
│   - Cross-matches orders deterministically                      │
│   - Commit-reveal exchange for fair settlement                  │
│                                                                  │
│   Defined in:  relayer-protocol/design.md                       │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼ Ethereum L1 (mainnet)
                               │
┌──────────────────────────────┴───────────────────────────────────┐
│                     ON-CHAIN LAYER                               │
│   - PrivateSettlement.settleAuth(makerProof, takerProof)        │
│   - Cross-party arithmetic checks in Solidity                   │
│   - DisputeRegistry records misbehavior (no slashing)           │
│   - Reputation indexer reads events; frontend displays scores   │
│                                                                  │
│   Defined in:  dispute-registry/design.md                       │
│                                                                  │
│   (Existing: PrivateSettlement.sol, RelayerRegistry.sol,        │
│    FeeVault.sol, IdentityGate.sol — extended, not replaced)     │
└──────────────────────────────────────────────────────────────────┘
```

## Cross-document anchor reference

These three values are referenced across all three documents and must remain consistent:

| Anchor | Defined in | Used in |
|---|---|---|
| `orderId` derivation: `Poseidon(makerSellToken, tokenMaker, makerSellAmount, makerBuyAmount, makerNonce, makerRelayer)` (6 inputs, normative form in circuit-split §5.2) | circuit-split §5.2 | relayer-protocol §4.2 (`ORDER_ANNOUNCE` carries the six binding fields), dispute-registry §"Evidence Schemas" |
| `RelayerCommit` EIP-712 schema | dispute-registry §"Evidence Schemas" | relayer-protocol §4.3 (`COMMIT` message) |
| `RelayerReveal` EIP-712 schema | dispute-registry §"Evidence Schemas" | relayer-protocol §4.3 (`REVEAL` message) |
| `MAX_CLOCK_SKEW` = 5 min | relayer protocol parameter: tolerance for message timestamp sanity / clock drift between relayers (independent from the strict per-order `expiry` check in `settleAuth`) | relayer-protocol §4.4 message validation |
| `REVEAL_WINDOW` = 5 min | dispute-registry contract constant | relayer-protocol §13 |

If any of these change, **all three documents must be updated together**.

## Project scope alignment

These designs respect the project's stated scope constraints:

- ✅ **Mainnet deployment only** — gas estimates assume mainnet pricing; no L2-specific optimizations baked in
- ✅ **No Account Abstraction** — settlement remains EOA-relayer-driven
- ✅ **No dynamic fees** — static fee binding via existing Phase 3.6 mechanism
- ✅ **Compliance preserved** — `IdentityGate` + dual-CA model continues to gate relayer registration; user privacy preserved at maximum masking

## Design decisions

### D1 — Self-trade is intentionally **not** prevented at the protocol layer

Earlier `settle.circom` exposed a `pubKeyHash` public output and used it for an on-chain `makerPubKeyHash != takerPubKeyHash` check. This has been **removed from the Half-proof design**. Rationale:

1. **A rational user has no reason to self-trade.** Half-proof uses static fees with no rebates. Both legs pay gas + fee. There is no incentive structure that rewards self-matching.
2. **A malicious user is economically penalised.** Wash-trading against oneself burns fees and gas with zero gain. The market punishes the behaviour without protocol intervention.
3. **A user who self-trades by mistake learns from it.** The protocol does not need to babysit this case.
4. **Fund integrity is already guaranteed by nullifiers.** `escrow_nullifier` and `nonce_nullifier` make double-spend cryptographically impossible regardless of who is on the other side.
5. **Regulatory wash-trading concerns are handled by the dual-CA layer.** Authorised auditors can reconstruct trader identity off-chain via the user CA and detect wash trading post-hoc — the same mechanism every regulated venue uses. On-chain prevention would require leaking trader linkability to *every* observer, which directly contradicts zkScatter's privacy positioning.

**Privacy consequence (the load-bearing reason)**: any on-chain mechanism for self-trade detection requires a per-trader linkability tag visible to all observers. That tag enables global trade clustering by chain-analysis tooling, breaking trader anonymity entirely. Removing the check restores full unlinkability — `authorize.circom` exposes only nullifiers (one-time use, unlinkable across trades) and trade parameters (token/amount/price), never anything tied to trader identity.

This is a deliberate, documented architectural commitment: **`authorize.circom` must never expose any per-trader-stable value as a public output.** Any future change that re-introduces such a value (link tag, identity nullifier, ring tag, etc.) must justify why it does not undo this property.

## Roadmap dependencies

Implementation order matters because the three pieces depend on each other:

```
Phase 0 — Specification (this design phase)
   │
   ├─ All three docs reach review-ready state ──┐
   │                                             │
Phase 1 — Half-proof                             │
   │                                             │
   ├─ Build authorize.circom (Half-proof primitive)
   ├─ AuthorizeVerifier contract deployed
   ├─ settleAuth(makerProof, takerProof) added to PrivateSettlement
   ├─ Browser proving benchmarked (≤ 2s target)
   ├─ Frontend updated to generate Half-proofs
   │   (legacy settle path still active)
   ▼
Phase 2 — Relayer protocol
   │
   ├─ Waku v2 integration in zk-relayer
   ├─ Gossip + direct messaging working
   ├─ Commit-reveal state machine implemented
   ├─ Two relayers can match cross-federation
   │   (legacy HTTP Trade Offer still active in parallel)
   ▼
Phase 3 — Dispute registry + reputation
   │
   ├─ DisputeRegistry.sol deployed (~150 LOC, no slashing)
   ├─ PrivateSettlement.orderSettled mapping added
   ├─ Reference reputation indexer (off-chain) deployed
   ├─ Frontend reputation display integrated
   ├─ Relayer SDK auto-files disputes for abort/mismatch
   ▼
Phase 4 — Migration & deprecation
   │
   ├─ Default flips to Half-proof protocol
   ├─ HTTP Trade Offer deprecated
   ├─ Legacy settlePrivate removed (circuits/settle.circom, ISettleVerifier, settlePrivate() deleted)
   ▼
Phase 5 — Optimization
   │
   ├─ rapidsnark-wasm + SIMD + multithreading tuned
   ├─ Maker pre-proving in background Web Worker
   ├─ Reputation system (off-chain) consumes dispute history
   └─ (Future) Nova folding for partial fills
```

## Key differentiators (vs. other private DEX projects)

The combination delivered by these three designs is, to our knowledge, unique. The matrix below covers both pure-privacy DEXes (Renegade, Aztec, Penumbra, Railgun) and intent/compliance-adjacent projects (CoW Swap, Panther Protocol) that occupy nearby design space:

| Property | Renegade | Aztec | Penumbra | Railgun | CoW Swap | Panther | **zkScatter v2** |
|---|---|---|---|---|---|---|---|
| Continuous orderbook | ✅ | ❌ | ❌ (batch) | ❌ | ❌ (batch) | ❌ (AMM) | ✅ |
| **Half-proof (async two-sided)** | ❌ (MPC) | N/A | N/A | N/A | N/A | N/A | ✅ |
| **Federated relayer network** | ❌ | ❌ | ✅ (validators) | ❌ | ✅ (solvers) | ❌ | ✅ |
| **No witness exposure to relayer** | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| **Cryptographic dispute records + reputation** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Trader anonymity | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Public price/amount (standard UX) | ❌ | N/A | partial | N/A | ✅ | ❌ | ✅ |
| Compliance gating | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (KYC) | ✅ (dual-CA) |
| L1 mainnet (no new chain) | ✅ | rollup | own chain | ✅ | ✅ | own chain | ✅ |
| Client-side proving | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| User offline after submit | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**Note on table stakes vs. load-bearing differentiators**: "Client-side proving" and "User offline after submit" are now table stakes for private DEX projects — they no longer differentiate zkScatter from anyone except Renegade. The load-bearing combination is **continuous orderbook + Half-proof matching + federated relayers + dual-CA compliance**, which no other project currently delivers.

**Positioning**: *The only continuous-orderbook DEX combining **Half-proof matching** (each user proves their own side in the browser; the relayer matches two `authorize` proofs into one `settleAuth` transaction) with institutional dual-CA compliance gating, deployable on Ethereum mainnet without a new chain.*

### Closest competitor: Panther Protocol

Panther is the most direct competitor in the "privacy + compliance" quadrant — it combines zk-asset privacy with KYC gating, which is the same problem space zkScatter occupies. The differences are architectural, not aspirational:

| Aspect | Panther | zkScatter v2 |
|---|---|---|
| Deployment | Own L1 (Panther Chain) + cross-chain bridges | Ethereum L1 mainnet, no new chain |
| Matching engine | AMM-style zAsset pools | Continuous orderbook + cross-relayer matching |
| Compliance model | Single-tier KYC provider | Dual-CA: privacy-preserving user CA + accountability relayer CA |
| Asset flow | Wrap to zAsset → trade → unwrap | Direct ERC-20 settlement on mainnet |
| Trust assumption | Panther Chain validators | Federated relayers + record-only dispute registry |
| Liquidity model | Pooled (LP-driven) | Bilateral (orderbook-driven) |

zkScatter's edge: **mainnet-native, orderbook-native, dual-CA compliance**. Panther optimizes for the *own-chain zAsset wrapping* point in the design space; zkScatter optimizes for *minimum trust assumptions on existing Ethereum L1*. The two are not interchangeable for an institutional desk that cannot bridge to a new chain.

### Closest competitor in the intent-based camp: CoW Protocol

CoW Swap and similar intent-based DEXes (UniswapX, Brink, Anoma) share the *off-chain solver/relayer + on-chain settlement* shape but make a different privacy trade-off: they hide **price** (via batch auction CoWs) but **not trader identity**. zkScatter inverts this — prices are public (standard orderbook UX), traders are anonymous. For institutional users who need to trade size without front-running but cannot accept batch-auction latency, this is a meaningful architectural divergence.

## Open architectural questions

These cut across multiple documents and need a unified decision:

1. **Folding scheme adoption timing** — Nova/HyperNova would help with partial fills but adds significant complexity. Defer to Phase 5+ unless partial fills become a critical bottleneck.
2. **Plonkish vs Groth16** — switching to Halo2/PLONK removes trusted setup but increases prover cost. Decision deferred; current designs assume Groth16.
3. **Mobile fallback** — if browser proving is infeasible on iOS Safari, do we offer server-side proving as opt-in (sacrificing the privacy gain)? Decision needed before Phase 1 ships.
4. **Watchdog incentive model** — third parties can file disputes but there is no on-chain reward (the design is record-only). Reputation systems may emerge that reward indexers off-chain. Defer to Phase 4.

## Where to start reading

If you only have time for one document, read in this order based on your role:

- **Cryptography / circuit reviewer** → start with **circuit-split/design.md** §2 (current state analysis) and §5 (binding)
- **Smart contract auditor** → start with **dispute-registry/design.md** §"Contract API"
- **Relayer operator / SRE** → start with **relayer-protocol/design.md** §3 (architecture) and §10 (security considerations)
- **Product / strategy** → start with §"Key differentiators" above, then `PAPER.md`

## File map

```
docs/
├── architecture-v2.md             ← THIS FILE (entry point)
│
├── circuit-split/
│   └── design.md                  ← Half-proof primitive (Phase 1)
│
├── relayer-protocol/
│   └── design.md                  ← Waku v2 federated protocol (Phase 2)
│
├── dispute-registry/
│   └── design.md                  ← Record-only dispute + reputation (Phase 3)
│
├── design-shared-orderbook.md     ← LEGACY: current HTTP Trade Offer (deprecated by Phase 2)
├── relayer-security.md            ← Operational threat model (sections §1-§3 obsoleted by Phase 1)
├── gas-cost-analysis.md           ← Gas baseline (referenced by all v2 docs)
├── PAPER.md                       ← Overall research paper + compliance model
├── PAPER-ko.md                    ← Korean translation
├── papers/                        ← Academic versions of PAPER.md
├── zk-private-trading.md          ← User-facing flow (mostly unchanged in v2)
├── design-zk-escrow.md            ← Escrow design (unchanged)
├── design-zk-settle-stealth.md    ← Stealth address settlement (unchanged)
├── design-stealth-address-claim.md ← Stealth address claim (unchanged)
├── deployment.md
├── local-setup.md
├── test-scenarios.md
├── demo-script-en.md
└── demo-script-ko.md
```
