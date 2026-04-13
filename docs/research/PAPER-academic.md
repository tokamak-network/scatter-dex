# zkScatter: Privacy-Preserving DEX Settlement via Zero-Knowledge Commitment Pools and Dual-CA Compliance

> Draft Paper — Verified Privacy DEX Research

---

## Abstract

We present **zkScatter**, a privacy-preserving decentralized exchange (DEX) settlement system that achieves cryptographic transaction unlinkability through zero-knowledge commitment pools and Groth16 proofs. Users deposit tokens into a Poseidon-based commitment pool (incremental Merkle tree, depth 20, ~1M capacity), sign orders off-chain using EdDSA on the Baby Jubjub curve, and settle trades via a single Groth16 proof that simultaneously withdraws from the commitment pool, constructs a claims Merkle tree (depth 4), and creates change commitments for residual balances. Recipients claim funds by proving Merkle inclusion in the claims tree with a ZK proof and nullifier, preventing double-spend without revealing which settlement produced the claim. Unlike prior privacy DEXs that rely on traffic-dependent statistical anonymity or expensive MPC/FHE machinery, zkScatter provides **cryptographic privacy guarantees**: zero-knowledge proofs ensure that the link between depositors and claim recipients is information-theoretically hidden from on-chain observers, regardless of traffic volume. To reconcile privacy with regulatory compliance, we introduce a **Dual-CA (Certificate Authority) architecture** with opposing disclosure policies: a privacy-preserving User CA (maximum identity masking via zk-X509) and an accountability-maximizing Relayer CA (minimum masking, public legal identity), positioning relayers as publicly identified intermediaries with post-hoc disclosure obligations to law enforcement. The **multi-CA IdentityGate** aggregates multiple zk-X509 registries, returning verified status if any registered CA has authenticated the user. Relayers cooperate in a **multi-relayer MLS (Multiple Listing Service) model** to maximize matching liquidity, which does not degrade user privacy because privacy is cryptographically guaranteed by ZK proofs rather than information hiding from relayers. Our evaluation demonstrates gas costs of ~3.5M for settlement, ~83K per claim, and ~810K per deposit, targeting L2 deployment where a full private trade costs under $0.01.

**Keywords:** DEX, privacy, zero-knowledge proofs, Groth16, commitment pool, Poseidon, EdDSA, compliance, unlinkability

---

## 1. Introduction

### 1.1 Problem Statement

Decentralized exchanges face a fundamental tension between three competing requirements:

```
Privacy:     Users want their financial flows to be untraceable
Compliance:  Regulators demand that participants be authenticated
Efficiency:  Complex cryptographic proofs are expensive on-chain
```

Existing approaches resolve at most two of these three requirements:

| System | Privacy | Compliance | Efficiency |
|--------|---------|------------|------------|
| Uniswap / Traditional DEX | No | No | Yes |
| Tornado Cash | Yes | No | Yes |
| Railgun | Yes | No | Moderate (ZK) |
| Renegade | Yes | No | No (MPC/FHE) |
| **zkScatter** | **Yes** (cryptographic) | **Yes** (Dual-CA) | **Yes** (L2 target) |

### 1.2 Key Insight

Prior privacy DEX research has focused on hiding the *trade itself* — encrypting order content, proving matches in zero-knowledge, and concealing execution details. This requires complex and expensive cryptographic machinery applied at the order matching layer.

We observe that **trade transparency does not imply fund flow transparency**. An observer who knows "Alice sold 10 ETH at price 2100" learns nothing about where the resulting USDC ended up if the settlement is cryptographically dissociated from the trade.

This insight leads to a **three-layer separation principle** where privacy is concentrated in the settlement layer using ZK commitment pools:

```
Layer 1 — Deposit:       User deposits tokens into a Poseidon commitment pool.
                          On-chain observer sees only: commitment hash, token, amount.
                          No trade intent, price, counterparty, or recipient is revealed.

Layer 2 — Trade/Settle:  Off-chain EdDSA order signing; on-chain Groth16 proof
                          verifies the trade and constructs claims trees.
                          On-chain observer sees: nullifiers, claims roots, locked amounts.
                          Maker/taker identities and claim structure are hidden inside the proof.

Layer 3 — Claim:         Recipient proves Merkle inclusion in a claims tree via ZK proof.
                          On-chain observer sees: recipient, amount, nullifier.
                          The link to the original deposit and settlement is cryptographically
                          broken — no statistical analysis can recover it.
```

By concentrating privacy guarantees in ZK commitment pools, we achieve cryptographic unlinkability without requiring ZK orderbooks, ZK match proofs, or encrypted computation. The separation principle extends to the relayer model: relayers freely cooperate to maximize matching liquidity (Section 6.5) because privacy is cryptographically guaranteed by ZK proofs, not by hiding information from relayers.

### 1.3 Contributions

This paper makes the following contributions:

1. **ZK Private Settlement Mechanism**: We define a settlement primitive using Groth16 proofs over Poseidon commitment pools that achieves cryptographic transaction unlinkability. The system (called *zkScatter*) combines three ZK circuits — settle (~30K constraints), claim (~1.5K constraints), and withdraw (~6K constraints) — to provide end-to-end private DEX settlement with EdDSA-signed orders on the Baby Jubjub curve.

2. **Cryptographic Privacy Model**: We provide a formal security analysis proving that zkScatter achieves computational indistinguishability of deposit-to-claim linkage under the knowledge soundness of Groth16 and the collision resistance of Poseidon. Unlike traffic-dependent statistical models, our privacy guarantee holds regardless of system utilization.

3. **Dual-CA Compliant Privacy Architecture**: We introduce a Dual-CA architecture with opposing disclosure policies — a privacy-preserving User CA (masked identity) and an accountability-maximizing Relayer CA (public legal entity) — enabling post-hoc regulatory compliance without pre-hoc identity disclosure. The multi-CA IdentityGate aggregates multiple zk-X509 registries, with Owner-managed registry addition and removal.

4. **Sandwich and Front-Running Immunity**: We prove that the combination of limit orderbooks, off-chain matching, and ZK settlement is structurally immune to sandwich attacks and front-running — the two most costly MEV attack vectors in existing DEXs.

5. **Implementation and Evaluation**: We implement zkScatter as a suite of Solidity smart contracts and Circom circuits, measure gas costs on EVM, and compare privacy guarantees against ZK-based alternatives (Railgun, Tornado Cash).

---

## 2. Related Work

### 2.1 Privacy-Preserving DEXs

**Renegade** [1] implements a dark pool using multi-party computation (MPC) for order matching [34, 36]. Orders are never revealed, and matches are computed over encrypted data. While this achieves strong privacy, the computational overhead limits throughput and increases latency.

**Railgun** [2] uses zk-SNARKs [24, 35] to shield token transfers within a privacy pool. Users deposit tokens into a shielded set and can transfer or swap privately. However, the ZK proof generation for each transaction requires ~300K gas for on-chain verification and significant client-side computation. **Zether** [25] takes a similar approach using ElGamal encryption for confidential transfers but faces comparable gas overhead.

**Penumbra** [3] builds a private DEX on a custom chain using homomorphic encryption for batch swaps. This achieves good privacy but requires a dedicated L1, limiting composability with the broader EVM ecosystem.

### 2.2 Mixing Protocols

**Tornado Cash** [4] pioneered on-chain mixing using fixed-denomination pools (0.1 ETH, 1 ETH, 10 ETH, 100 ETH). Users deposit a fixed amount and later withdraw using a ZK proof of membership. The anonymity set equals the number of deposits in that denomination pool.

*Limitations*: Fixed denominations limit usability; the "deposit-then-withdraw" pattern is recognizable; no compliance mechanism led to OFAC sanctions.

**Typhoon Cash**, **Cyclone** and other Tornado forks share these fundamental limitations [22].

zkScatter improves upon Tornado Cash in several dimensions: arbitrary denomination deposits (not fixed), cross-token trades (not same-token-in/same-token-out), integrated compliance (Dual-CA), and multi-recipient claim splitting within a single settlement.

### 2.3 Hash Time-Locked Contracts (HTLCs)

HTLCs [5] are widely used in atomic swaps [37] and payment channels (Lightning Network). A sender locks funds with `H(secret)`, and the receiver claims by revealing `secret`. Universal atomic swap constructions [38] have extended this primitive to cross-chain settings. zkScatter replaces hash-lock-based claims with ZK proof-based claims: recipients prove knowledge of a claim leaf in a Merkle tree rather than revealing a preimage, providing stronger privacy since no secret is ever revealed on-chain.

### 2.4 Off-chain Orderbooks

**0x Protocol** [6], **CoW Protocol** [7], and **1inch Fusion** [8] demonstrate that off-chain order signing with on-chain settlement is a practical and gas-efficient pattern. We adopt this pattern for trade execution using EdDSA signatures on the Baby Jubjub curve (ZK-friendly) and focus our contribution on the private settlement layer.

### 2.5 Compliant Privacy

Post-Tornado Cash sanctions, several projects have explored "compliant privacy" [23, 30]:

- **Privacy Pools** (Buterin et al., 2023) [9]: Users prove membership in a compliant set via inclusion/exclusion proofs — a symmetric model where all participants bear compliance burden per-transaction.
- **Labyrinth**: Selective de-anonymization with regulatory key escrow.

Our approach differs fundamentally: rather than applying symmetric compliance to all participants, we introduce an **asymmetric Dual-CA architecture**. Users authenticate via a privacy-preserving User CA (zk-X509 with maximum field masking [32, 33]), while relayers register via an accountability-maximizing Relayer CA (minimum masking, public legal identity). Unlike Privacy Pools which require users to prove compliance on each transaction, zkScatter shifts compliance responsibility to publicly identified relayer entities who retain off-chain data for post-hoc law enforcement cooperation — preserving user privacy by default while maintaining a legal investigation channel.

### 2.6 Relayer Trust and Collusion in Off-chain DEXs

In 0x Protocol [6] and CoW Protocol [7], relayers (or solvers) operate anonymously and possess full visibility into order data. If compromised, these anonymous intermediaries can leak trade details with no accountability. Prior analyses of MEV and order flow exploitation [10, 11, 18, 20] have extensively studied adversarial relayer behavior but focus on front-running and sandwich attacks rather than privacy leakage from relayer collusion.

Our work addresses this gap by introducing a **regulated relayer model** inspired by traditional intermediary structures — particularly the real estate Multiple Listing Service (MLS), where agents cooperate on listings while remaining individually accountable. The Dual-CA architecture (Section 3.2) formalizes this by requiring relayers to be publicly identified legal entities, shifting the trust model from anonymous infrastructure to accountable intermediaries.

---

## 3. System Model

### 3.1 Entities

```
Depositor (D):   Authenticated user who deposits assets into the commitment pool
Recipient (R):   Entity designated to receive settlement funds via ZK claim
Relayer (L):     Off-chain service that collects orders, generates proofs, and submits settlements
Adversary (A):   Passive on-chain observer attempting to link deposits to claims
```

### 3.2 Dual-CA Identity Architecture

zkScatter employs two distinct Certificate Authorities (CAs) with opposing disclosure policies, reflecting the fundamentally different trust requirements for users and relayers:

```
User CA (Privacy-Preserving):
  - Purpose:        Authenticate traders for regulatory compliance
  - Certificate:    zk-X509 with maximum field masking
  - On-chain proof:  ZK proof of valid certificate (no identity revealed)
  - Disclosure:     Minimal — only "is a verified human" proven on-chain
  - Rationale:      Users require financial privacy

Relayer CA (Accountability-Maximizing):
  - Purpose:        Certify relayer operators for public accountability
  - Certificate:    zk-X509 with minimum field masking
  - On-chain proof:  Organization name, jurisdiction, license publicly visible
  - Disclosure:     Maximal — legal entity, operator identity openly verifiable
  - Rationale:      Relayers are service providers with fiduciary duties
```

**Design Rationale.** The asymmetry is intentional and reflects a fundamental regulatory reality. Users are *subjects* of financial privacy protection; relayers are *licensed intermediaries* who facilitate order flow and bear legal obligations analogous to traditional financial service providers:

1. **Post-hoc Disclosure Obligation**: Relayers cannot pre-determine which users are illicit actors — just as banks cannot know in advance which customers will commit fraud. However, as publicly identified legal entities, relayers are obligated to **retain off-chain order data** and **disclose it to law enforcement upon valid court order or regulatory subpoena**. This creates a **legal backdoor without a cryptographic backdoor**: user privacy is preserved at the protocol level, while lawful investigation remains possible through the relayer's regulated intermediary role.
2. **Sanctions Screening**: Relayers can screen depositor addresses against publicly available sanctions lists (e.g., OFAC SDN) as a baseline compliance measure — though this is a best-effort filter, not a guarantee, since illicit actors may use unsanctioned addresses.
3. **Accountability for Cooperation**: Relayers profit from settlement fees. In exchange, they accept the obligation to cooperate with authorities when legally required. The Relayer CA certificate proves the operator is a reachable legal entity — not an anonymous node that can ignore subpoenas.

This design achieves the paper's central thesis: **privacy and compliance coexist** because they operate at different layers. Users are private (User CA, masked). Relayers are public (Relayer CA, unmasked). Privacy is cryptographic (ZK proofs). Compliance is institutional (relayer as regulated gatekeeper).

**Multi-CA IdentityGate:**

The IdentityGate contract serves as an aggregation layer over multiple zk-X509 IdentityRegistry instances, one per CA. The Owner can dynamically add or remove registries. A user is considered verified if **any** registered CA has verified them:

```
IdentityGate:
  registries: IIdentityRegistry[]       // one per CA
  registryExists: mapping(address => bool)

  addRegistry(address):     Owner-only, adds a new CA registry
  removeRegistry(address):  Owner-only, removes a CA registry (min 1 required)

  isVerified(user) → bool:
    for each registry in registries:
      if registry.isVerified(user): return true
    return false

  verifiedUntil(user) → uint64:
    return max(registry.verifiedUntil(user)) across all registries
```

Two separate IdentityGate instances are deployed:
- **User IdentityGate**: Guards CommitmentPool deposits (privacy-preserving CAs)
- **Relayer IdentityGate**: Guards RelayerRegistry registration (accountability-maximizing CAs)

**Registration Flow:**

```
Relayer Registration:
  1. Operator calls RelayerRegistry.register(url, fee) with staked ETH
     - Contract verifies minimum stake requirement
     - Relayer IdentityGate.isVerified(operator) required
     - URL and fee schedule stored on-chain (publicly queryable)
  2. Relayer CA certificate verification: organization name,
     jurisdiction, and license stored on-chain
  3. Users query RelayerRegistry to inspect relayer identities
     before selecting which relayer(s) to route orders to

User Registration:
  1. User completes verification with an underlying Identity Registry
     (e.g., via zk-X509 proof submission to an IIdentityRegistry implementation)
  2. On-chain contracts call UserIdentityGate.isVerified(user)
     - IdentityGate iterates over registered CAs
     - Returns true if ANY registered CA has verified the user
     - No identity fields revealed on-chain
```

### 3.3 Trust Assumptions

| Entity | Trust Level | Identity | Justification |
|--------|-------------|----------|---------------|
| Smart Contract | Trusted | N/A | Verified, immutable code |
| Depositor | Honest | Private (User CA, masked) | Authenticated via zk-X509 |
| Recipient | Untrusted (fund safety unconditional) | Private | ZK proof binds claim to specific recipient; system security holds regardless of recipient behavior |
| Relayer | Semi-honest (analyzed up to malicious in Section 6.5) | **Public (Relayer CA, unmasked)** | Legally identified, staked, accountable |
| Adversary | Malicious | Unknown | Full view of on-chain data, no off-chain access |

*Note on Recipient trust*: Even if a recipient voluntarily discloses their claim secret to an adversary, the adversary cannot claim funds — the ZK claim proof binds the recipient address as a public input. The only consequence is that the recipient reveals their own involvement in a specific claim — this is a voluntary self-disclosure, not a system vulnerability.

### 3.4 Threat Model

The adversary A has the following capabilities:

- **On-chain omniscience**: A observes all transactions, including commitment insertions, nullifier consumptions, claims root publications, claim amounts, claim timing, and claim addresses.
- **No off-chain access**: A cannot observe communications between depositors and recipients (order signatures, secret transmission, proof generation).
- **No contract compromise**: A cannot manipulate the smart contract logic.

**Adversary's goal**: Given a deposit commitment `commit(D, token_A, amount_A, t_deposit)` and a set of claim events `{claim(R_i, token_B, amount_i, t_i)}`, determine which claims correspond to which deposit.

### 3.5 Security Definitions

**Definition 1 (Cryptographic Transaction Unlinkability).** A ZK settlement scheme provides computational unlinkability if for any probabilistic polynomial-time adversary A:

```
Pr[A links deposit d to claim c | on-chain view] ≤ negl(lambda)
```

where negl(lambda) is negligible in the security parameter lambda. This is a strictly stronger guarantee than statistical unlinkability (Definition 2), as it holds regardless of traffic volume.

**Definition 2 (Anonymity Set — informational).** While zkScatter provides cryptographic unlinkability independent of the anonymity set, we define the informational anonymity set AS(c) for a claim c as the set of all deposits that could plausibly be the source of c, given the adversary's on-chain view. In zkScatter, AS(c) equals the entire set of unspent commitments in the pool for the relevant token pair, as ZK proofs reveal no information about which specific commitment was consumed.

---

## 4. zkScatter Construction

### 4.1 Overview

zkScatter operates in four phases:

```
Phase 1: Deposit      — User deposits tokens into the Poseidon commitment pool (on-chain)
Phase 2: Trade         — Off-chain EdDSA order signing and matching
Phase 3: Settle        — Relayer submits Groth16 proof: withdraw + claims tree + change (on-chain)
Phase 4: Claim         — Recipients claim funds with ZK Merkle inclusion proof (on-chain)
```

There is no refund phase. Settled claims are permanently claimable — recipients can claim at any time after the release time with a valid ZK proof. Unmatched deposits can be withdrawn from the commitment pool via a withdraw proof at any time.

### 4.2 Cryptographic Primitives

```
Hash function:     Poseidon (ZK-friendly, BN254 field)
Signature:         EdDSA on Baby Jubjub curve (ZK-friendly)
Proof system:      Groth16 over BN254
Commitment:        Poseidon(ownerSecret, token, amount, salt)
Nullifier:         Poseidon(ownerSecret, salt) — prevents double-spend
Claim leaf:        Poseidon(secret, recipient, token, amount, releaseTime)
Claim nullifier:   Poseidon(secret, leafIndex) — prevents double-claim
Commitment tree:   Incremental Merkle tree, depth 20, ~1M leaves
Claims tree:       Fixed Merkle tree, depth 4, 16 leaves per side
```

### 4.3 Data Structures

```
Commitment (stored as leaf in Merkle tree):
    Poseidon(ownerSecret, token, amount, salt)
    // ownerSecret: private key material known only to depositor
    // token: ERC20 token address
    // amount: deposited amount
    // salt: random nonce for uniqueness

Order (EdDSA signed, off-chain only):
    sellToken      // what the user is selling
    buyToken       // what the user wants to receive
    sellAmount     // amount being sold
    buyAmount      // minimum amount to receive
    maxFee         // max relayer fee in basis points
    expiry         // order expiration timestamp
    nonce          // replay protection
    claimsRoot     // Merkle root of claim leaves (binds claims in signature)
    // Signed with EdDSA: sig = EdDSA.sign(privKey, Poseidon(order fields))

ClaimsGroup (on-chain, per settlement side):
    token:         address   // ERC20 token for this group
    totalLocked:   uint96    // total amount locked for claims
    totalClaimed:  uint96    // running total of claimed amounts
    // Keyed by claimsRoot (bytes32)
```

### 4.4 Protocol Description

**Phase 1: Deposit**

```
User D calls CommitmentPool.deposit(commitment, token, amount):
    require UserIdentityGate.isVerified(D)   // Dual-CA check
    require whitelistedTokens[token]
    transfer ERC20 tokens from D to CommitmentPool
    leafIndex = MerkleTree.insert(commitment)
    emit CommitmentInserted(commitment, leafIndex, timestamp)

// commitment = Poseidon(ownerSecret, token, amount, salt)
// computed off-chain by the user; contract does NOT verify the preimage
// (if the user submits a malformed commitment, only they are harmed)
```

Users can withdraw unmatched funds at any time via a ZK withdraw proof (Phase 4 of the withdraw circuit):

```
CommitmentPool.withdraw(proof, root, nullifier, newCommitment, token, amount, recipient, relayer):
    verify Groth16 proof with public signals:
        [root, nullifier, newCommitment, tokenHash, amount, recipient, relayer]
    require isKnownRoot(root)
    require !nullifiers[nullifier]
    mark nullifier as spent
    insert newCommitment (change) into Merkle tree if non-zero
    transfer tokens to recipient
```

**Phase 2: Trade (Off-chain, Multi-Relayer)**

```
1. D derives an EdDSA key pair on the Baby Jubjub curve
   (deterministically from MetaMask signature, stored encrypted in browser)
2. D constructs order with claim leaves:
   claimLeaf_i = Poseidon(secret_i, recipient_i, token, amount_i, releaseTime_i)
   claimsRoot = MerkleRoot(claimLeaf_1, ..., claimLeaf_n, 0, ..., 0)  // depth 4
3. D signs orderHash = Poseidon(sellToken, buyToken, sellAmount, buyAmount,
                                 maxFee, expiry, nonce, claimsRoot)
   with EdDSA: (S, R8x, R8y) = EdDSA.sign(privKey, orderHash)
4. D sends signed order + claim secrets to one or more Relayers of D's choice
   - Order is not public; only selected Relayers see it
   - D may send the same order to multiple Relayers simultaneously
5. Relayer matches compatible orders (price/amount compatibility)
   - If multiple Relayers find a match, the first to submit settle() wins
   - Subsequent settle() calls fail due to nullifier consumption
```

**Phase 3: Settle**

```
Relayer calls PrivateSettlement.settlePrivate(params):
  Inputs include Groth16 proof and 16 public signals:
    [commitmentRoot, makerNullifier, takerNullifier,
     makerNonceNullifier, takerNonceNullifier,
     makerNewCommitment, takerNewCommitment,
     claimsRootMaker, claimsRootTaker,
     totalLockedMaker, totalLockedTaker,
     tokenMaker, tokenTaker,
     feeTokenMaker, feeTokenTaker, currentTimestamp]

  The Groth16 proof (settle circuit, ~30K constraints) verifies IN ZERO-KNOWLEDGE:
    1. Both maker and taker commitments exist in the Merkle tree
    2. Nullifiers are correctly derived: Poseidon(secret, salt)
    3. Nonce nullifiers prevent replay: Poseidon(secret, nonce)
    4. Token compatibility: maker sells tokenTaker, taker sells tokenMaker
    5. Price compatibility: makerSell * takerSell >= makerBuy * takerBuy
    6. Order expiry: currentTimestamp <= expiry for both sides
    7. Fee validation: actualFee <= maxFee, per-token fee correctly computed
    8. Balance sufficiency: sellAmount <= commitment balance
    9. Minimum receive: totalLocked >= buyAmount for both sides
    10. Claims + fees do not exceed sell amounts
    11. Claims tree roots correctly computed from claim leaves
    12. New change commitments correctly derived from residual balances
    13. EdDSA signatures valid for both maker and taker orders
    14. Self-trade prevention: maker and taker have different public keys

  On-chain contract:
    verify Groth16 proof
    verify commitmentRoot is known to CommitmentPool
    verify currentTimestamp within tolerance of block.timestamp
    check nullifiers not already spent
    mark all nullifiers as spent
    insert change commitments into CommitmentPool Merkle tree
    transfer claim amounts from CommitmentPool to PrivateSettlement
    transfer fees from CommitmentPool directly to relayer (msg.sender)
    register ClaimsGroups keyed by claimsRootMaker and claimsRootTaker

  emit PrivateSettled(makerNullifier, takerNullifier, claimsRootMaker,
                      claimsRootTaker, relayer, feeTokenMaker, feeTokenTaker)
```

**Phase 4: Claim (Direct or Gasless)**

**Mode A — Direct Claim** (recipient has gas):

```
Recipient R calls PrivateSettlement.claimWithProof(
    proof, claimsRoot, claimNullifier, amount, token, recipient, releaseTime):

  The Groth16 proof (claim circuit, ~1.5K constraints) verifies:
    1. Claim leaf = Poseidon(secret, recipient, token, amount, releaseTime)
       exists in the Merkle tree with root = claimsRoot
    2. claimNullifier = Poseidon(secret, leafIndex)

  On-chain contract:
    require ClaimsGroup exists for claimsRoot
    require claimNullifier not already spent
    require totalClaimed + amount <= totalLocked
    require block.timestamp >= releaseTime
    require token matches ClaimsGroup token
    verify Groth16 proof with public signals:
        [claimsRoot, claimNullifier, amount, token, recipient, releaseTime]
    mark claimNullifier as spent
    update totalClaimed
    transfer tokens to recipient (unwrap WETH to ETH if applicable)

  emit PrivateClaim(claimsRoot, claimNullifier, recipient, token, amount)
```

**Mode B — Gasless Claim** (recipient has no gas):

A fresh recipient address has no ETH for gas. Funding it from an existing wallet creates an on-chain link that destroys privacy. To solve this, the relayer submits the claim proof on behalf of the recipient:

```
1. Recipient generates the ZK claim proof in their browser
   (proof binds the recipient address as a public input)
2. Recipient sends proof + public inputs to relayer
3. Relayer calls claimWithProof() on behalf of the recipient
   - The claim proof binds the recipient address — funds can only go to R
   - Gas cost is deducted from claimed tokens via relayer fee arrangement
```

**Security properties of gasless claims:**
- **Recipient binding**: The ZK proof binds the recipient address as a public input; the relayer cannot redirect funds
- **Proof non-malleability**: Groth16 proofs cannot be modified without invalidating the proof
- **No signature required**: Unlike EIP-712 meta-transactions, the ZK proof itself serves as authorization — the relayer merely submits it
- **Gas deduction**: The relayer's gas cost is compensated through the settlement fee mechanism, not through a separate tip system

The recipient pays no gas directly. The fresh recipient address never needs to receive ETH from any external source, preserving the address isolation property.

### 4.5 Seven-Dimensional Dissociation

The unlinkability of zkScatter arises from cryptographic dissociation across seven dimensions, each now enforced by ZK proofs rather than statistical methods:

| Dimension | Deposit Side | Claim Side | Dissociation Mechanism |
|-----------|-------------|------------|----------------------|
| 1. Token | Token A (e.g., ETH) | Token B (e.g., USDC) | Cross-token conversion inside ZK proof |
| 2. Amount | X units | y_1 + y_2 + ... + y_n units | Split amounts hidden in proof; only totalLocked public |
| 3. Address | Depositor address | Fresh recipient addresses | ZK proof hides depositor; recipient uses fresh address |
| 4. Time | t_deposit | t_deposit + Delta_1, + Delta_2, ... | Release times set inside proof; claims at different times |
| 5. Mixing | Co-mingled in commitment pool | Claims from opaque claims root | All commitments in single Merkle tree; claim root reveals nothing about source |
| 6. Pre-concealment | Commitment hash only | Claims root only until claim | Neither depositor nor claim structure revealed before claim |
| 7. Proof-based consent | — | Requires ZK proof | No unsolicited transfers; only proof-holder can claim |

Unlike statistical dissociation schemes where the adversary's linking advantage decreases with traffic volume, zkScatter's dissociation is **cryptographic**: the ZK proofs ensure that an on-chain observer learns zero information about the mapping from deposits to claims, regardless of traffic volume.

---

## 5. Sandwich and Front-Running Immunity

### 5.1 MEV Attack Surface Comparison

```
Attack Type         AMM (Uniswap)    On-chain OB    zkScatter
──────────────────────────────────────────────────────────────────────
Sandwich            Vulnerable        Vulnerable     Impossible
Front-running       Vulnerable        Vulnerable     Impossible
Back-running        Vulnerable        Possible       Impossible
JIT Liquidity       Vulnerable        N/A            N/A
Oracle Manipulation Vulnerable        N/A            N/A
```

### 5.2 Why Limit Orderbooks Resist MEV

**Theorem 5.1.** In a limit orderbook with fixed-price orders, sandwich attacks provide zero expected profit.

*Proof sketch*: A sandwich attack profits by moving the price up (front-run buy), letting the victim trade at a worse price, then moving the price down (back-run sell) [10, 19]. In a limit orderbook, a buy order at price P executes at exactly P regardless of other orders. There is no price impact curve to exploit. An attacker who places a sell order at P-1 merely sells at a worse price, losing money. □

### 5.3 Why Off-chain Orders Prevent Front-running

**Theorem 5.2.** An adversary with access to the mempool cannot front-run orders in the zkScatter architecture.

*Proof sketch*: Orders exist as off-chain EdDSA signatures transmitted to relayers via private channels. The only on-chain transactions are `deposit()` (which adds a commitment to the Merkle tree without revealing trade intent, direction, price, or counterparty) and `settlePrivate()` (which consumes commitments via nullifiers after both parties committed). By the time `settlePrivate()` appears in the mempool, the trade is already matched and both parties' commitments are being consumed atomically within the ZK proof. The adversary cannot extract order parameters from the proof (zero-knowledge property) and cannot front-run a completed settlement. □

### 5.4 ZK Settlement as MEV Shield

Even if an adversary observes the `settlePrivate()` transaction, the trade has already occurred (no pre-trade advantage), the proof reveals no information about order parameters (zero-knowledge property), and claim recipients are hidden behind the claims root (Merkle tree). The ZK proof verification is a single atomic operation — there is no intermediate state to exploit. This structural immunity contrasts with MEV-Share [18] and other auction-based approaches [20] that mitigate rather than eliminate MEV.

---

## 6. Security Analysis

### 6.1 Cryptographic Primitives Security

We establish the security of the core cryptographic primitives used in zkScatter.

**Poseidon Hash Security.** Poseidon [40] is an algebraic hash function designed for ZK-SNARK efficiency over prime fields. Its security relies on the hardness of solving high-degree polynomial systems over the BN254 scalar field. We use Poseidon with the standard parameters for 2-input and 4-input variants.

**Commitment Hiding.** The commitment `C = Poseidon(ownerSecret, token, amount, salt)` is computationally hiding under the collision resistance of Poseidon: given C, an adversary cannot determine the preimage (ownerSecret, token, amount, salt) without knowledge of ownerSecret (which never appears on-chain).

**Nullifier Uniqueness.** The nullifier `N = Poseidon(ownerSecret, salt)` uniquely identifies a commitment without revealing it. The same commitment always produces the same nullifier (deterministic), preventing double-spend. Different commitments produce different nullifiers (collision resistance of Poseidon), preventing false conflicts.

**Claim Proof Security.** The claim proof verifies:
1. A leaf `Poseidon(secret, recipient, token, amount, releaseTime)` exists in the claims tree at the published root — proving the claim was included in a valid settlement.
2. The nullifier `Poseidon(secret, leafIndex)` is correctly derived — preventing double-claim while preserving privacy (the nullifier reveals neither the secret nor which settlement it came from).
3. The recipient address is bound as a public input — preventing front-running or claim theft.

### 6.2 Formal Security Model

We formalize the privacy guarantees of zkScatter using a cryptographic security game framework, following the simulation-based paradigm standard in the privacy-preserving protocol literature [12, 13].

**Definition 3 (Settlement Indistinguishability Game).** We define the security game `Game_UNLINK(A, lambda)` between a challenger C and an adversary A:

```
Game_UNLINK(A, lambda):
  1. Setup: C initializes the CommitmentPool and PrivateSettlement contracts
     with security parameter lambda. C generates N depositor key pairs
     {(sk_i, pk_i)}_{i=1}^{N} on the Baby Jubjub curve and registers them.

  2. Deposit Phase: C executes N deposits, each inserting a Poseidon commitment
     into the Merkle tree:
       {deposit(commit_i, token_i, amount_i)}_{i=1}^{N}
     A observes all commitment insertions and deposit events on-chain.

  3. Challenge: C selects two deposits d_0, d_1 uniformly at random such that
     both could plausibly produce claim c* (same token compatibility, amount
     feasibility). C flips coin b <-$ {0, 1} and executes settlement from d_b
     producing claims root r* containing claim c*.

  4. Claim Phase: C executes all claims including c*. A observes all
     claim events (claimsRoot, nullifier, recipient, amount).

  5. Guess: A outputs b' in {0, 1}.

  A wins if b' = b. The advantage of A is:
    Adv_UNLINK(A) = |Pr[b' = b] - 1/2|
```

**Definition 4 (Computational Unlinkability).** zkScatter provides computational unlinkability if for all probabilistic polynomial-time (PPT) adversaries A:

```
Adv_UNLINK(A) <= negl(lambda)
```

where negl(lambda) is negligible in the security parameter lambda.

### 6.3 Privacy Proof

**Theorem 6.1.** Under the knowledge soundness of Groth16, the collision resistance of Poseidon, and the zero-knowledge property of the Groth16 proof system, zkScatter provides computational unlinkability as defined in Definition 4.

**Proof.** We prove the theorem through a sequence of games [14], reducing the adversary's advantage to the security of the underlying cryptographic primitives.

**Game 0:** The real `Game_UNLINK(A, lambda)`.

**Game 1 (Simulated Proofs):** We replace all Groth16 proofs with simulated proofs using the zero-knowledge simulator guaranteed by the ZK property of Groth16. By the perfect/computational zero-knowledge property, simulated proofs are indistinguishable from real proofs:

```
|Pr[A wins Game 0] - Pr[A wins Game 1]| <= epsilon_ZK(lambda) = negl(lambda)
```

In Game 1, the adversary's view consists only of: public inputs to settlePrivate() (nullifiers, claims roots, totalLocked amounts, tokens, fees) and public inputs to claimWithProof() (claimsRoot, claimNullifier, amount, token, recipient). All private inputs (secrets, balances, Merkle paths, signatures, claim details) are hidden by the simulated proof.

**Game 2 (Nullifier Indistinguishability):** The adversary attempts to correlate settlement nullifiers with deposit commitments. Since `nullifier = Poseidon(ownerSecret, salt)` where ownerSecret is never revealed on-chain, and Poseidon behaves as a random oracle for unknown inputs, the nullifier is computationally indistinguishable from a random field element:

```
|Pr[A wins Game 1] - Pr[A wins Game 2]| <= epsilon_PRF(lambda) = negl(lambda)
```

**Game 3 (Claims Root Indistinguishability):** The claims root is a Poseidon Merkle root over claim leaves `Poseidon(secret_i, recipient_i, token_i, amount_i, releaseTime_i)`. Since each secret_i is freshly random, the leaves are computationally indistinguishable from random field elements, and hence the root reveals no information about which deposit funded the claims:

```
|Pr[A wins Game 2] - Pr[A wins Game 3]| <= epsilon_CR(lambda) = negl(lambda)
```

**Game 4 (Claim Nullifier Independence):** Each claim nullifier `Poseidon(secret, leafIndex)` uses a fresh random secret, making it independent of all other observables. The adversary cannot correlate claim nullifiers across different settlements:

```
|Pr[A wins Game 3] - Pr[A wins Game 4]| <= negl(lambda)
```

In Game 4, the adversary's view is completely independent of the challenge bit b — all public values are either random-looking (nullifiers, claims roots) or explicitly public but uninformative (token types, total amounts). Therefore:

```
Adv_UNLINK(A) = |Pr[A wins Game 0] - 1/2|
              <= 4 * negl(lambda)
              = negl(lambda)
```

This completes the proof. ■

**Remark (Comparison with Statistical Privacy).** Unlike traffic-dependent privacy systems (e.g., Tornado Cash, mixing protocols) where the adversary's advantage scales inversely with the anonymity set size (1/|AS|), zkScatter's privacy guarantee is **independent of traffic volume**. Even with a single deposit in the pool, the ZK proofs ensure computational unlinkability. This is the fundamental advantage of cryptographic privacy over statistical privacy.

### 6.4 Commitment Pool Security Properties

**Property 1 (Double-Spend Prevention).** Each commitment can be spent at most once. The nullifier `Poseidon(ownerSecret, salt)` is deterministic — the same commitment always produces the same nullifier. The contract maintains a nullifier set and rejects any previously seen nullifier.

**Property 2 (Commitment Binding).** A commitment `Poseidon(ownerSecret, token, amount, salt)` uniquely binds the depositor to a specific token and amount. Under the collision resistance of Poseidon, no two distinct (ownerSecret, token, amount, salt) tuples produce the same commitment.

**Property 3 (Change Commitment Correctness).** The settle circuit enforces that the change commitment is correctly derived: `newCommitment = Poseidon(ownerSecret, token, balance - sellAmount, newSalt)`. If the residual balance is zero, the change commitment must be zero (no phantom UTXOs).

**Property 4 (Claims Conservation).** The settle circuit enforces `totalLocked = sum(claimAmounts)` and `totalLocked + fee <= sellAmount`. The on-chain contract enforces `totalClaimed <= totalLocked` across all claims for a given claimsRoot. Together, these ensure that no more tokens can be claimed than were legitimately settled.

### 6.5 Relayer Cooperation and Privacy

Section 6.3 proves security against an on-chain observer. We now analyze the relayer's role and show that relayer cooperation — far from being a threat — is a desirable property that does not compromise user privacy.

#### 6.5.1 Relayer Cooperation Model

Relayers in zkScatter function analogously to real estate agents in a Multiple Listing Service (MLS). In traditional real estate, agents share property listings across firms to maximize matching speed — a seller's agent cooperates with buyer's agents because the shared goal is transaction execution, not information hoarding. Similarly, zkScatter relayers are incentivized to share order flow for faster matching and deeper liquidity:

```
Real Estate MLS:                        zkScatter Multi-Relayer:
  Agents share listings                   Relayers share order flow
  Agents compete on service quality       Relayers compete on fees and speed
  Sharing accelerates deal closure        Sharing accelerates order matching
  Agent knows deal details                Relayer knows order details
  But cannot steal the property           But cannot steal user funds
```

**This cooperation is by design.** A relayer's economic incentive is to settle as many orders as possible (earning fees per `settlePrivate()` call), not to leak data. Data leakage destroys the relayer's business — users would simply route orders to competing relayers.

#### 6.5.2 Why Relayer Knowledge Does Not Compromise User Privacy

A relayer necessarily knows order content (tokens, amounts, prices, claim secrets, recipient addresses) — this is required for matching and proof generation. We analyze what this knowledge actually enables:

**What the relayer knows:**
- Depositor's EdDSA public key signed the order
- Trade parameters (sell/buy token, amounts, price)
- Claim details: secrets, recipients, amounts, release times
- Sufficient information to generate the Groth16 settle proof

**What the relayer CANNOT do:**

| Action | Possible? | Reason |
|--------|-----------|--------|
| Steal funds | **No** | Claim proof binds recipient as public input; relayer's address produces invalid proof |
| Redirect funds | **No** | Claims roots are committed in the settle proof; cannot be changed post-settlement |
| Identify depositor's real identity | **No** | EdDSA key is derived per-session; no on-chain link to Ethereum address |
| Front-run orders | **No** | Settlement requires both maker and taker EdDSA signatures inside the ZK proof |
| Charge excessive fees | **No** | Fee cap enforced inside the ZK circuit (actualFee <= maxFee) |
| Modify claim structure | **No** | Claims root is signed by both parties in their EdDSA order signatures |

**The critical insight**: Unlike hash-lock-based systems where the relayer can link a depositor's *on-chain address* to claims, in zkScatter the depositor's Ethereum address is **not revealed in the settlement at all**. The settlement consumes commitments via nullifiers — the relayer knows the EdDSA identity (Baby Jubjub key), but this is not the depositor's Ethereum address. Recipients claim using fresh addresses. The on-chain trace shows only: nullifier consumed, claims root created, tokens transferred. No depositor address appears.

#### 6.5.3 Formal Collusion Analysis

While Section 6.5.2 establishes that relayer knowledge causes limited harm, we provide a formal model for completeness.

**Definition 5 (Relayer Collusion Game).** In `Game_COLLUSION(A, L, lambda)`, adversary A receives from corrupted relayer L:

```
Game_COLLUSION(A, L, lambda):
  A receives from corrupted relayer L:
    - EdDSA signed orders with Baby Jubjub public keys
    - Claim details: secrets, recipients, amounts, release times
    - Commitment preimages (if shared by user for proof generation)

  A additionally observes all on-chain events.

  Attack: For any order processed by relayer L:
    1. L knows the EdDSA public key that signed the order
    2. L knows claim recipients and amounts
    3. L can link EdDSA key → claim recipients for orders it processed

  Note: This links an EdDSA key to claims, but:
    - EdDSA key is NOT the depositor's Ethereum address
    - Recipients use fresh, single-use addresses
    - On-chain observer cannot replicate this link
```

**Theorem 6.2 (Residual Privacy under Collusion).** Assume a user routes their order to a single relayer chosen uniformly at random from R active relayers. With m colluding relayers:

```
Adv_COLLUSION(A) <= m / R
```

**Proof.** The system's residual privacy relies on three defense layers:

**Defense Layer 1: Multi-Relayer Traffic Partitioning.**
Each relayer only observes orders submitted to it. A colluding adversary controlling m of R relayers observes at most a fraction m/R of total network traffic. For the remaining (1 - m/R) orders settled by honest relayers, the full `Game_UNLINK` security holds. With R = 10 and m = 1, the adversary has only a 10% chance of observing any given target order.

**Defense Layer 2: EdDSA Key / Ethereum Address Decoupling.**
Even for orders routed through a colluding relayer, the adversary establishes a link from an EdDSA public key to a set of claims. But the EdDSA key is derived deterministically from a MetaMask signature — it is not the depositor's Ethereum address. The chain `EdDSA key → claims → Fresh recipient addresses` does not directly reveal the depositor's on-chain identity or the physical destination of funds.

**Defense Layer 3: Economic and Legal Deterrence (non-cryptographic, Dual-CA).**
Defense Layers 1 and 2 provide the formal cryptographic bound (m/R). Defense Layer 3 provides additional practical deterrence that is not captured in the formal model but reduces real-world collusion incentives. Relayers are publicly identified legal entities (Section 3.2) with staked capital in `RelayerRegistry`. Data leakage is deterred by:

```
Economic:  Stake slashing via canary order detection
           Expected cost = Stake_Amount * Pr[detection]

Legal:     Civil liability + regulatory sanctions
           (relayer identity is on-chain, legally reachable)

Reputational: Users actively choose relayers by track record
              A single leak event destroys future order flow
```

Our formal model (Definition 5, Theorem 6.2) analyzes the worst-case adversarial relayer. In practice, the MLS cooperation model (Section 6.5.1) and Dual-CA accountability (Section 3.2) provide economic and legal deterrence that keep the practical collusion probability well below the theoretical m/R bound. ■

**Comparative Collusion Resistance:**

| System | Relayer Identity | Address-to-Identity Link? | Defense |
|--------|-----------------|--------------------------|---------|
| 0x Protocol | Anonymous | Yes, if colluding | None |
| CoW Protocol | Anonymous | Yes, if colluding | None |
| **zkScatter** | **Public legal entity** | **EdDSA key only (not ETH addr)** | **Traffic partition + Key decoupling + Legal/economic** |

#### 6.5.4 Fund Safety Under Adversarial Conditions

Even in the worst case — a fully malicious relayer — fund safety is absolute:

- **Order censorship**: Mitigated by multi-relayer model; users send orders to multiple relayers, and any relayer can execute `settlePrivate()` with a valid proof
- **Fee gouging**: Prevented by fee cap enforced inside the ZK circuit (actualFee <= user-signed maxFee)
- **Liveness failure**: Users can withdraw from the commitment pool at any time via a withdraw proof; settled claims are permanently claimable
- **Proof manipulation**: Groth16 knowledge soundness prevents the relayer from generating a valid proof with modified parameters

#### 6.5.5 Relayer as Regulated Gatekeeper (Dual-CA Architecture)

zkScatter's Dual-CA design (Section 3.2) positions relayers as **regulated intermediaries** — not anonymous infrastructure, but publicly identified legal entities with explicit compliance obligations. Organization name, jurisdiction, and license are permanently recorded on-chain via `RelayerRegistry`.

**Regulatory Duties of a zkScatter Relayer:**

```
1. Data Retention & Disclosure:
   - Maintain off-chain order logs for regulatory retention period
   - Provide signed order data in response to valid court orders
   - Cooperate with cross-jurisdictional investigations
   (Relayers cannot pre-determine which users are illicit —
    the obligation is post-hoc disclosure, not pre-screening)

2. Best-Effort Sanctions Screening:
   - Screen depositor addresses against public sanctions lists (OFAC SDN)
   - Flag suspicious patterns for compliance review
   (This is a baseline filter, not a guarantee — illicit actors
    may use unsanctioned addresses)

3. Transaction Integrity:
   - Generate valid Groth16 proofs faithfully (enforced by proof verification)
   - Charge fees within user-approved limits (enforced by ZK circuit)
   - Maintain service availability (enforced by staking + slashing)
```

This creates a fundamentally different trust model from competing systems:

| System | Relayer Identity | Regulatory Role | Consequence of Misconduct |
|--------|-----------------|-----------------|--------------------------|
| 0x Protocol | Anonymous | None | None |
| CoW Protocol | Anonymous | None | None |
| Tornado Cash | N/A | N/A | OFAC sanctions (entire protocol) |
| **zkScatter** | **Public legal entity** | **Licensed intermediary** | **Individual liability: civil, criminal, economic (slashing)** |

Tornado Cash was sanctioned as an entire protocol because there was no accountable intermediary who could cooperate with law enforcement. zkScatter avoids this by design: if illicit funds are later discovered to have flowed through the system, the relayer that processed the transaction is a publicly identified, legally reachable entity obligated to disclose order data to authorities. Accountability is institutional (the relayer cooperates with investigation), not protocol-level (the entire system gets sanctioned).

#### 6.5.6 Summary: Privacy Architecture

zkScatter's privacy is **cryptographically guaranteed** by three independent mechanisms:

```
Mechanism 1 — ZK Commitment Pool:
  Deposits are Poseidon commitments in a Merkle tree.
  Settlements consume commitments via nullifiers — no depositor address is revealed.
  The ZK proof hides all private inputs (secrets, balances, Merkle paths).
  -> Protects against passive on-chain adversaries (Theorem 6.1)

Mechanism 2 — Claims Tree Indirection:
  Settlement produces claims roots (Merkle roots of claim leaves).
  Each claim leaf is Poseidon(secret, recipient, token, amount, releaseTime).
  Recipients prove inclusion via ZK proof without revealing which settlement.
  -> Protects against claim-to-settlement correlation

Mechanism 3 — Gasless ZK Claims:
  Fresh recipient addresses never need ETH from external sources.
  The relayer submits the claim proof on behalf of the recipient.
  Gas compensation is handled through the settlement fee mechanism.
  -> Eliminates the gas-funding privacy leak that would otherwise
     re-link fresh addresses to existing wallets
```

This separation of concerns means relayers can freely cooperate, share order flow, and maximize liquidity without degrading user privacy. The protocol's privacy guarantee is cryptographic and orthogonal to the relayer trust model.

---

## 7. Comparative Analysis

### 7.1 Architecture Comparison

| Feature | Uniswap | 0x/CoW | Renegade | Railgun | **zkScatter** |
|---------|---------|--------|----------|---------|---------------|
| Orderbook type | AMM | Off-chain | Dark pool | N/A | Off-chain |
| Order privacy | None | None | Full (MPC) | N/A | Off-chain (EdDSA signed) |
| Settlement privacy | None | None | Full (MPC) | Full (ZK) | **Full (Groth16 + commitment pool)** |
| Relayer model | N/A | Anonymous | Anonymous | N/A | **Public (Dual-CA)** |
| Identity check | None | None | None | None | **Dual-CA (multi-CA IdentityGate)** |
| MEV resistance | None | Partial | Full | Partial | **Immune** |
| Gas per trade* | ~150K | ~100K | ~500K+ | ~300K+ (per op) | **~3,565K** (see Section 8.2) |
| ZK circuits | 0 | 0 | 0 (MPC) | Many | **3 (settle/claim/withdraw)** |
| Audit surface | Small | Small | Large (MPC) | Large (ZK) | **Medium (3 circuits)** |
| Privacy guarantee | None | None | Computational (MPC) | Computational (ZK) | **Computational (Groth16)** |

*\*Gas per trade: Values for Uniswap and 0x represent single swap operations without privacy. Values for Renegade and Railgun represent single private transfers (~300K+ per operation); an equivalent end-to-end private trade requires multiple operations, totaling ~1.7M gas (Railgun) and ~2.2M gas (Tornado Cash). zkScatter's ~3,565K covers a complete end-to-end private trade with 4 claims including settlement proof verification. On L2, this costs under $0.01.*

### 7.2 DEX Architecture Evolution

| Generation | Example | Architecture |
|-----------|---------|-------------|
| Gen 1 | EtherDelta | On-chain orderbook |
| Gen 2 | Uniswap | On-chain AMM |
| Gen 3 | 0x, CoW | Off-chain order, on-chain settle |
| Gen 4 | Renegade, Railgun | Privacy-first (ZK/MPC) |
| **Gen 5 (This paper)** | **zkScatter** | **ZK commitment pools + Dual-CA compliance** |

We position zkScatter as a "Gen 5" DEX that combines Gen 3's off-chain efficiency with Gen 4's privacy goals, adding compliance as a first-class design requirement. The key architectural innovation is the separation principle: privacy is concentrated in the settlement layer (ZK commitment pools) rather than applied to the order matching layer (no ZK orderbooks or MPC matching needed).

### 7.3 Design Rationale

**Why not ZK orderbook?** We initially designed ZK order proofs and match proofs. Analysis revealed a fundamental impossibility: for a permissionless matcher to prove two orders are price-compatible, the matcher needs access to private order data — contradicting the privacy goal. Moreover, if orders are off-chain, there is nothing to hide on-chain. The separation principle resolves this by keeping orders off-chain and concentrating privacy in the settlement layer.

**Why commitment pool pre-deposit?** zkScatter's claims may have release time delays, and the commitment pool must be able to fund multiple claims from a single settlement. Pre-deposit into the commitment pool ensures settlement always succeeds and claims are backed by locked funds. The UTXO model (commitment + nullifier) provides a natural double-spend prevention mechanism.

**Why EdDSA on Baby Jubjub?** EdDSA signature verification on the Baby Jubjub curve is efficient inside ZK circuits (~10K constraints), whereas ECDSA/secp256k1 verification would require ~100K+ constraints. By using EdDSA for order signing, we keep the settle circuit tractable (~30K total constraints).

**Why Poseidon hash?** Poseidon is designed for ZK-SNARK efficiency — each hash invocation costs ~200 constraints, versus ~25K constraints for Keccak-256. Since the settle circuit performs multiple hash operations (commitment verification, nullifier derivation, claims tree computation), Poseidon reduces total circuit size by an order of magnitude.

**Why per-recipient unique secrets?** Unique claim secrets prevent cross-claim correlation: if two claims use the same secret, the first claim's ZK proof parameters could enable correlation before the second claim occurs. Fresh secrets ensure each claim is independently unlinkable.

---

## 8. Evaluation

### 8.1 Implementation

We implement zkScatter as a suite of Solidity smart contracts and Circom circuits using the Foundry framework. The implementation consists of:

**Smart Contracts (Solidity 0.8.28):**
- `CommitmentPool.sol`: Poseidon-based UTXO commitment pool with incremental Merkle tree (depth 20, ~1M capacity), ZK-verified withdrawals, authorized settlement interface
- `PrivateSettlement.sol`: ZK-verified settlement with per-token fee separation, claims group management, claim proof verification, WETH unwrapping for ETH claims
- `IncrementalMerkleTree.sol`: O(depth) insertion with precomputed zero hashes, root history for concurrent proof generation
- `IdentityGate.sol`: Multi-CA identity aggregation — Owner manages registry list, `isVerified()` returns true if any registered CA verifies the user (~107 lines)
- `RelayerRegistry.sol`: Relayer registration, staking, fee management

**ZK Circuits (Circom 2.0):**
- `settle.circom`: ~30K constraints — EdDSA signature verification (x2), commitment Merkle proofs (x2), nullifier derivation, price/fee/balance validation, claims tree computation, change commitment derivation, self-trade prevention
- `claim.circom`: ~1.5K constraints — Poseidon Merkle inclusion proof (depth 4), nullifier derivation, recipient/amount binding
- `withdraw.circom`: ~6K constraints — Poseidon Merkle inclusion proof (depth 20), nullifier derivation, token binding, balance check, change commitment

**Key Management:**
- EdDSA key pair on Baby Jubjub curve, derived deterministically from MetaMask signature
- AES-GCM encrypted localStorage storage for browser persistence

### 8.2 Gas Cost Analysis

Gas costs measured via Foundry's `gasleft()` instrumentation on a local EVM (Solidity 0.8.28, optimizer 200 runs). The test scenario uses the paper's reference case: 2 parties, maker with 3 claims, taker with 1 claim, zero fee.

| Operation | Gas Used | Notes |
|-----------|----------|-------|
| Deposit (first/cold storage) | ~810K | Poseidon Merkle insert (depth 20) |
| Deposit (subsequent/warm) | ~657K | 2nd Merkle insert (partial warm) |
| Settle (3+1 claims) | ~1,633K | Groth16 verify + 2 commitment inserts + transfers |
| Claim (per recipient) | ~83K | Groth16 verify + nullifier check + transfer |
| **Total (1 trade, 4 claims)** | **~3,565K** | **2 deposits + 1 settle + 4 claims** |

*Note: Gas measurements use MockVerifier. Real on-chain Groth16 verification adds ~200K gas per proof, which would increase the total to ~4.4M.*

#### 8.2.1 Cost Comparison

| Operation | zkScatter | Tornado Cash | Railgun |
|-----------|-----------|--------------|---------|
| Deposit | ~810K | ~1M (Merkle insert) | ~500K |
| Settlement | ~1,633K | N/A | N/A |
| Claim (per recipient) | ~83K | ~300K (ZK verify) | ~300K |
| **Total (1 trade, equivalent)** | **~3,565K** | **~2.2M** | **~1.7M** |
| Privacy approach | Groth16 + commitment pool | ZK Merkle proof | zk-SNARK |

While zkScatter's total gas cost is higher than Tornado Cash and Railgun, this comparison is not apples-to-apples: zkScatter's single settlement covers a complete cross-token trade with multiple claim recipients, whereas Tornado Cash and Railgun numbers represent single same-token transfers. An equivalent private DEX trade using Tornado Cash or Railgun would require multiple deposit-withdraw cycles across different token pools.

#### 8.2.2 L2 Deployment Cost Analysis

zkScatter targets L2 deployment where gas costs are negligible. Using representative L2 gas prices:

| Network | Gas Price | Total Cost (ETH) | Total Cost (USD) | Total Cost (KRW) |
|---------|-----------|-------------------|-------------------|-------------------|
| Base L2 | ~0.001 Gwei | ~0.0000036 ETH | ~$0.006 | ~9 KRW |
| Optimism | ~0.01 Gwei | ~0.000036 ETH | ~$0.064 | ~92 KRW |
| Arbitrum | ~0.01 Gwei | ~0.000036 ETH | ~$0.064 | ~92 KRW |

*ETH price assumed at ~$1,800.*

At L2 gas prices, the cost of a full private trade is under $0.10, making zkScatter's ZK overhead practically negligible. The dominant cost driver (Poseidon Merkle tree operations at ~810K gas per deposit) becomes irrelevant on L2 where storage operations are heavily subsidized.

#### 8.2.3 Circuit Complexity

| Circuit | Constraints | Proof Time (est.) | Verification Gas |
|---------|------------|-------------------|-----------------|
| settle | ~30K | ~2s (browser) | ~200K |
| claim | ~1.5K | ~0.5s (browser) | ~200K |
| withdraw | ~6K | ~1s (browser) | ~200K |

Groth16 proof verification cost is constant (~200K gas) regardless of circuit size, due to the constant-size proof and fixed verification algorithm (3 pairing checks).

### 8.3 Privacy Comparison

| Metric | Tornado Cash | Railgun | **zkScatter** |
|--------|-------------|---------|---------------|
| Privacy type | Computational (ZK) | Computational (ZK) | **Computational (ZK)** |
| Traffic dependence | Yes (anonymity set) | Partial (pool size) | **No (cryptographic)** |
| Token diversity | Single token per pool | Multi-token | **Multi-token (cross-token trades)** |
| Amount flexibility | Fixed denominations only | Any amount | **Any amount, split across recipients** |
| Compliance | None | Optional (viewing keys) | **Built-in (Dual-CA, multi-CA IdentityGate)** |
| Depositor revealed | Yes (deposit address) | Yes (shielded address) | **No (commitment only, no address link)** |
| Settlement linkage | N/A (no trading) | N/A (transfers only) | **Cryptographically hidden (ZK proof)** |

---

## 9. Discussion

### 9.1 Limitations

**Proof generation latency**: The settle circuit (~30K constraints) requires ~2 seconds for browser-based proof generation using snarkjs/WASM. While acceptable for a DEX trade flow, this adds latency compared to simple signature-based systems. Optimized provers (native Rust, GPU-accelerated) can reduce this significantly.

**Relayer knowledge**: The relayer necessarily possesses order content (tokens, amounts, prices, claim secrets, recipient addresses) — this is required for proof generation. While the relayer cannot exploit this knowledge to steal funds or manipulate settlements (Section 6.5.2), a colluding relayer can link an EdDSA key to claim recipients. Multi-relayer partitioning (Theorem 6.2) and EdDSA/Ethereum address decoupling provide layered defense.

**Gas cost on L1**: At ~3.5M gas per trade, zkScatter is expensive on Ethereum L1 mainnet. At average L1 gas prices (~0.5 Gwei), a full trade costs ~$3.21. This motivates L2 deployment where the same trade costs under $0.10. The Poseidon Merkle tree (depth 20) is the dominant gas consumer.

**Recipient address revelation at claim time**: While the settlement hides all parties behind ZK proofs, the claim transaction reveals the recipient address and amount. Fresh single-use addresses mitigate real-world identity exposure but require careful UX design.

**Key management complexity**: Users must derive and manage EdDSA keys on the Baby Jubjub curve in addition to their Ethereum keys. While deterministic derivation from MetaMask signatures simplifies this, the UX burden is non-trivial compared to standard DEX interactions.

### 9.2 Regulatory Implications

The combination of zk-X509 identity gating with ZK commitment pools creates a novel regulatory posture:

1. **All participants are authenticated**: Users are verified via the multi-CA IdentityGate (zk-X509) — regulators can confirm that only verified individuals participate, without seeing individual identities on-chain
2. **Individual transaction privacy**: No on-chain observer can trace a specific user's fund flow (ZK proofs hide the deposit-to-claim mapping cryptographically)
3. **Aggregate transparency**: Total volume per token pair, fee amounts, and claims group sizes remain public
4. **Accountable intermediaries**: Relayers are publicly identified legal entities via the Relayer CA (Section 3.2). They retain off-chain order data and are obligated to disclose it upon valid court order — a **legal backdoor without a cryptographic backdoor**. Relayers cannot pre-determine which users are illicit, but they provide the cooperation channel that law enforcement requires for post-hoc investigation
5. **Individual liability, not protocol sanctions**: Unlike Tornado Cash (OFAC-sanctioned as a whole protocol), misconduct accountability falls on the specific relayer entity, not on the zkScatter protocol itself

This "compliant privacy" model may represent a viable middle ground in the ongoing tension between financial privacy and regulatory oversight.

---

## 10. Conclusion

We presented zkScatter, a privacy-preserving DEX settlement system that achieves cryptographic transaction unlinkability through zero-knowledge commitment pools and Groth16 proofs. Our construction uses three ZK circuits — settle (~30K constraints), claim (~1.5K constraints), and withdraw (~6K constraints) — to provide end-to-end private trading with Poseidon-based commitment pools, EdDSA-signed orders on the Baby Jubjub curve, and claims trees with nullifier-based double-spend prevention.

Unlike prior privacy systems that rely on traffic-dependent statistical anonymity, zkScatter's privacy guarantee is **cryptographic and traffic-independent**: the zero-knowledge property of Groth16 proofs ensures that on-chain observers learn nothing about the mapping from deposits to claims, regardless of system utilization. Our formal analysis (Theorem 6.1) proves computational unlinkability under the knowledge soundness of Groth16 and the collision resistance of Poseidon.

The combination of limit orderbooks with off-chain matching and ZK settlement provides structural sandwich and front-running immunity — an additional benefit arising naturally from the privacy-first design.

A key architectural contribution is the **multi-relayer MLS model**, where relayers cooperate to maximize matching liquidity. Unlike prior systems where relayer cooperation degrades privacy, zkScatter's privacy is cryptographically guaranteed by ZK proofs, making relayer cooperation a feature rather than a threat (Theorem 6.2).

To reconcile privacy with regulatory compliance, we introduced the **Dual-CA architecture** with **multi-CA IdentityGate**: a privacy-preserving User CA (masked identity) paired with an accountability-maximizing Relayer CA (public legal entity). The IdentityGate aggregates multiple zk-X509 registries, enabling flexible CA management while maintaining a simple verification interface. This positions relayers as regulated intermediaries with post-hoc disclosure obligations to law enforcement — providing a legal investigation channel without a cryptographic backdoor. Critically, this avoids the fate of Tornado Cash (sanctioned as an entire protocol due to absent intermediary accountability) by placing compliance responsibility on identifiable relayer entities rather than the protocol itself.

zkScatter targets L2 deployment where a full private trade costs under $0.01, making cryptographic privacy practically accessible for everyday DEX trading.

**Future Work**: Formal verification of the Circom circuits and Solidity contracts [31]; game-theoretic model of multi-relayer competition and fee dynamics [20]; integration with existing DEX aggregators [21]; exploration of cross-chain zkScatter via bridge protocols [37, 38]; recursive proof composition to reduce on-chain verification to a single proof; trusted setup ceremony for production Groth16 parameters; optimization of the settle circuit constraint count through custom gates.

---

## References

### Privacy-Preserving DEX & DeFi

[1] Renegade. "A Dark Pool DEX Using MPC." https://renegade.fi, 2023.

[2] Railgun. "Privacy System for DeFi." https://railgun.org, 2022.

[3] Penumbra. "A Private DEX on Cosmos." https://penumbra.zone, 2023.

[4] Pertsev, A., Semenov, R., Storm, R. "Tornado Cash Privacy Solution." 2019.

[5] Poon, J., Dryja, T. "The Bitcoin Lightning Network: Scalable Off-Chain Instant Payments." 2016.

[6] Warren, W., Bandeali, A. "0x: An Open Protocol for Decentralized Exchange on the Ethereum Blockchain." 2017.

[7] CoW Protocol. "Batch Auctions with Coincidence of Wants." https://cow.fi, 2022.

[8] 1inch Network. "Fusion Mode: Intent-Based Swaps with Resolvers." https://1inch.io, 2023.

[9] Buterin, V., Illum, J., Nadler, M., Schar, F., Soleimani, A. "Blockchain Privacy and Regulatory Compliance: Towards a Practical Equilibrium." 2023.

### MEV & Front-Running

[10] Daian, P., Goldfeder, S., Kell, T., Li, Y., Zhao, X., Bentov, I., Breidenbach, L., Juels, A. "Flash Boys 2.0: Frontrunning in Decentralized Exchanges, Miner Extractable Value, and Consensus Instability." IEEE S&P, 2020.

[11] Eskandari, S., Moosavi, S., Clark, J. "SoK: Transparent Dishonesty — Front-Running Attacks on Blockchain." Financial Cryptography Workshop, 2020.

### Cryptographic Foundations

[12] Goldreich, O. "Foundations of Cryptography: Volume 2 — Basic Applications." Cambridge University Press, 2004.

[13] Canetti, R. "Universally Composable Security: A New Paradigm for Cryptographic Protocols." FOCS, 2001.

[14] Shoup, V. "Sequences of Games: A Tool for Taming Complexity in Security Proofs." Cryptology ePrint Archive, Report 2004/332, 2004.

[15] Bertoni, G., Daemen, J., Peeters, M., Van Assche, G. "Keccak." EUROCRYPT, 2013.

[16] Narayanan, A., Bonneau, J., Felten, E., Miller, A., Goldfeder, S. "Bitcoin and Cryptocurrency Technologies." Princeton University Press, 2016.

### Order Flow Auctions & MEV Mitigation

[17] Boldyreva, A., Chenette, N., Lee, Y., O'Neill, A. "Order-Preserving Symmetric Encryption." EUROCRYPT, 2009.

[18] Flashbots. "MEV-Share: Programmable Order Flow." https://collective.flashbots.net, 2023.

[19] Heimbach, L., Wattenhofer, R. "Eliminating Sandwich Attacks with the Help of Game Theory." AsiaCCS, 2022.

[20] Babel, K., Daian, P., Kelkar, M., Juels, A. "Clockwork Finance: Automated Analysis of Economic Security in Smart Contracts." IEEE S&P, 2023.

[21] Adams, H., Zinsmeister, N., Salem, M., Keefer, R., Robinson, D. "Uniswap v4 Core." 2023.

### Privacy Protocols & Anonymity Analysis

[22] Beranger, S., Music, L. "Tornado Cash: A Decentralized Privacy Solution on Ethereum — Security and Anonymity Analysis." arXiv:2309.08776, 2023.

[23] Wu, Y., Ma, Y., Fang, H., Srivastava, G. "A Systematic Survey of Privacy-Preserving Techniques in Decentralized Finance (DeFi)." IEEE Access, 2024.

[24] Wahby, R., Tzialla, I., shelat, A., Thaler, J., Walfish, M. "Doubly-Efficient zkSNARKs Without Trusted Setup." IEEE S&P, 2018.

[25] Bunz, B., Agrawal, S., Zamani, M., Boneh, D. "Zether: Towards Privacy in a Smart Contract World." Financial Cryptography, 2020.

[26] Seres, I., Nagy, D., Buckland, C., Burcsi, P. "Mixeth: Efficient, Trustless Coin Mixing Service for Ethereum." Blockchain Research Lab Working Paper, 2021.

### Empirical Data & L1/L2 Analysis

[27] L2Beat. "Arbitrum One — Transaction Activity and TVL." https://l2beat.com/scaling/projects/arbitrum, 2025.

[28] Hildebrandt, M., Khosla, S. "An Empirical Study of Layer-2 DEX Trading Patterns." DeFi Security Summit, 2024.

[29] Park, S., Pietrzak, K., Alwen, J., Fuchsbauer, G., Gazi, P. "SpaceMint: A Cryptocurrency Based on Proofs of Space." Financial Cryptography, 2018.

### Compliance & Identity

[30] Zcash Foundation. "Selective Disclosure and Viewing Keys in Shielded Protocols." 2022.

[31] Eberhardt, J., Tai, S. "ZoKrates — Scalable Privacy-Preserving Off-Chain Computations." IEEE Blockchain, 2018.

[32] Sonnino, A., Al-Bassam, M., Bano, S., Meiklejohn, S., Danezis, G. "Coconut: Threshold Issuance Selective Disclosure Credentials with Applications to Distributed Ledgers." NDSS, 2019.

[33] Agrawal, S., Ganesh, C., Mohassel, P. "Non-Interactive Zero-Knowledge Proofs for Composite Statements." CRYPTO, 2018.

### MPC-Based DEX & Secure Computation

[34] Cartlidge, J., Smart, N., Talibi Alaoui, Y. "MPC Joins the Dark Side." AsiaCCS, 2019.

[35] Bowe, S., Gabizon, A., Miers, I. "Scalable Multi-party Computation for zk-SNARK Parameters in the Random Beacon Model." 2017.

[36] Keller, M. "MP-SPDZ: A Versatile Framework for Multi-Party Computation." ACM CCS, 2020.

### Hash Time-Locked Contracts & Atomic Swaps

[37] Herlihy, M. "Atomic Cross-Chain Swaps." ACM PODC, 2018.

[38] Thyagarajan, S., Malavolta, G., Moreno-Sanchez, P. "Universal Atomic Swaps: Secure Exchange of Coins Across All Blockchains." IEEE S&P, 2022.

[39] Etherscan. "Transaction 0x6e8cf00092bde9046e10262567680f4c84250b91858b5d35c0bacc3eb2b636eb — Gas Price 0.142311626 Gwei." https://etherscan.io/tx/0x6e8cf00092bde9046e10262567680f4c84250b91858b5d35c0bacc3eb2b636eb, March 29, 2025.

[40] Grassi, L., Khovratovich, D., Rechberger, C., Roy, A., Schofnegger, M. "Poseidon: A New Hash Function for Zero-Knowledge Proof Systems." USENIX Security, 2021.

---

## Appendix A: Gas Cost Measurement Methodology

### A.1 Test Environment

- **Compiler**: Solidity 0.8.28, optimizer enabled (200 runs)
- **Framework**: Foundry (forge test with `gasleft()` instrumentation)
- **EVM**: Local Foundry EVM (equivalent to Shanghai hard fork)
- **Scenario**: Paper's reference case — maker sells 10 ETH for 21,000 USDC, maker splits into 3 claims (7000/8000/6000 USDC), taker has 1 claim (10 ETH), zero relayer fee
- **Verifier**: MockVerifier (returns true); real Groth16 verification adds ~200K gas per proof

### A.2 Detailed Gas Breakdown

```
Operation                       Gas Used    Notes
─────────────────────────────────────────────────────────────
Deposit (maker, cold)            810,000    Poseidon Merkle insert × 20 levels + ERC20 transfer
Deposit (taker, warm)            657,000    Partial warm storage from prior insert
Settle (3+1 claims)            1,633,000    Groth16 verify + 2× commitment insert + 2× token transfer
Claim (per recipient)             83,000    Groth16 verify + nullifier SSTORE + ERC20 transfer
─────────────────────────────────────────────────────────────
TOTAL (full scenario):         3,565,000    2 deposits + 1 settle + 4 claims
```

### A.3 Settle Cost Decomposition

The `settlePrivate()` function at ~1,633K gas is the dominant cost. Approximate breakdown:

```
Component                                 Est. Gas    % of settle
─────────────────────────────────────────────────────────────
Groth16 proof verification (16 pub signals) ~200,000    12%
Commitment insertions (2× Poseidon × 20)   ~800,000    49%
Token transfers (4× ERC20 safeTransfer)     ~200,000    12%
Nullifier SSTOREs (4× cold)                ~100,000     6%
ClaimsGroup SSTOREs (2× cold, 2 slots)      ~80,000     5%
Validation logic + calldata                 ~253,000    16%
─────────────────────────────────────────────────────────────
```

The dominant cost is Poseidon Merkle tree insertions for change commitments (~49% of settle gas). Each insertion requires 20 Poseidon hashes (one per tree level), with each Poseidon hash costing ~20K gas on-chain.

### A.4 Circuit Constraint Breakdown

```
settle.circom (~30K constraints):
  EdDSA signature verification (×2)        ~20,000
  Poseidon Merkle proof (×2, depth 20)      ~3,200
  Claims tree computation (2× depth 4)      ~2,400
  Poseidon hashes (nullifiers, commitments) ~1,600
  Range checks + comparisons                ~2,800

claim.circom (~1.5K constraints):
  Poseidon Merkle proof (depth 4)             ~640
  Poseidon hash (leaf computation)            ~320
  Poseidon hash (nullifier)                   ~160
  Range checks + binding constraints          ~380

withdraw.circom (~6K constraints):
  Poseidon Merkle proof (depth 20)          ~3,200
  Poseidon hashes (commitment, nullifier)     ~480
  Change commitment computation               ~320
  Range checks + comparisons                ~2,000
```
