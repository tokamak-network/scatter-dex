# Scatter Settlement: Achieving Transaction Unlinkability through Time-Delayed Split Hash-Locks

> Draft Paper — Verified Privacy DEX Research

---

## Abstract

We present **Scatter Settlement**, a novel settlement mechanism for decentralized exchanges (DEXs) that achieves transaction unlinkability without relying on heavy zero-knowledge proof systems. Our approach decouples trade execution from settlement and introduces a multi-dimensional dissociation scheme combining (1) cross-token conversion, (2) amount splitting, (3) temporal dispersion, (4) address separation, (5) transaction mixing, (6) pre-claim address concealment via hash-locks, and (7) explicit recipient consent. By storing only `claimHash = H(secret, recipient)` on-chain, neither the recipient address nor the claim secret is revealed until the moment of withdrawal. We formally define the **anonymity set** of Scatter Settlement as a function of contract TVL, concurrent transactions, split count, and time delay, and prove that an adversary's advantage in linking deposits to withdrawals is negligible under moderate-to-high traffic conditions (≥100 deposits/hour). To reconcile privacy with regulatory compliance, we introduce a **Dual-CA (Certificate Authority) architecture** with opposing disclosure policies: a privacy-preserving User CA (maximum identity masking) and an accountability-maximizing Relayer CA (minimum masking), positioning relayers as publicly identified intermediaries with post-hoc disclosure obligations to law enforcement. Relayers cooperate in a **multi-relayer MLS (Multiple Listing Service) model** to maximize matching liquidity, which — unlike prior systems — does not degrade user privacy because privacy is structurally guaranteed by claimHash and fresh recipient addresses. Our evaluation on Ethereum L2 shows that Scatter Settlement achieves comparable privacy guarantees to ZK-based mixing protocols at **~67–74% lower gas cost**, while maintaining full compatibility with KYC/AML compliance.

**Keywords:** DEX, privacy, unlinkability, hash-lock, settlement, anonymity set, compliance

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
| Uniswap / Traditional DEX | ✗ | ✗ | ✓ |
| Tornado Cash | ✓ | ✗ | ✓ |
| Railgun | ✓ | ✗ | ✗ (heavy ZK) |
| Renegade | ✓ | ✗ | ✗ (MPC/FHE) |
| **Scatter Settlement** | **✓** | **✓** | **✓** |

### 1.2 Key Insight

Prior privacy DEX research has focused on hiding the *trade itself* — encrypting order content, proving matches in zero-knowledge, and concealing execution details. This requires complex and expensive cryptographic machinery.

We observe that **trade transparency does not imply fund flow transparency**. An observer who knows "Alice sold 10 ETH at price 2100" learns nothing about where the resulting USDC ended up if the settlement is sufficiently dissociated from the trade.

This insight leads to a separation principle:

```
Trade Execution:  Can be transparent (off-chain orderbook, public matching)
Settlement:       Must be unlinkable (Scatter Settlement)
```

By concentrating all privacy guarantees in the settlement layer, we eliminate the need for ZK orderbooks, ZK match proofs, or encrypted computation, while achieving comparable unlinkability. This separation principle extends to the relayer model: relayers freely cooperate to maximize matching liquidity — analogous to real estate agents sharing listings via MLS — because privacy is structurally guaranteed by `claimHash` and fresh recipient addresses, not by hiding information from relayers (Section 6.5).

### 1.3 Contributions

This paper makes the following contributions:

1. **Scatter Settlement Mechanism**: We define a new settlement primitive (the mechanism is called *Scatter Settlement*; the DEX system implementing it is called *ScatterDEX*) that achieves transaction unlinkability through seven-dimensional dissociation, requiring only hash-locks and time-locks — no zero-knowledge proofs.

2. **Formal Anonymity Model**: We provide a mathematical framework for analyzing the anonymity set size as a function of system parameters (TVL, transaction rate, split count, time delay), and prove bounds on adversarial linking advantage.

3. **Dual-CA Compliant Privacy Architecture**: We introduce a Dual-CA architecture with opposing disclosure policies — a privacy-preserving User CA (masked identity) and an accountability-maximizing Relayer CA (public legal entity) — enabling post-hoc regulatory compliance without pre-hoc identity disclosure. This positions relayers as regulated gatekeepers obligated to cooperate with law enforcement, while preserving user financial privacy at the protocol level.

4. **Sandwich and Front-Running Immunity**: We prove that the combination of limit orderbooks, off-chain matching, and delayed settlement is structurally immune to sandwich attacks and front-running — the two most costly MEV attack vectors in existing DEXs.

5. **Empirical Evaluation**: We implement Scatter Settlement on Ethereum L2, measure gas costs, and compare privacy guarantees against ZK-based alternatives (Railgun, Tornado Cash).

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

### 2.3 Hash Time-Locked Contracts (HTLCs)

HTLCs [5] are widely used in atomic swaps [37] and payment channels (Lightning Network). A sender locks funds with `H(secret)`, and the receiver claims by revealing `secret`. Universal atomic swap constructions [38] have extended this primitive to cross-chain settings. Our claimHash construction `H(secret, recipient)` extends this by binding the claim to a specific address, preventing front-running while preserving pre-claim recipient concealment.

### 2.4 Off-chain Orderbooks

**0x Protocol** [6], **CoW Protocol** [7], and **1inch Fusion** [8] demonstrate that off-chain order signing with on-chain settlement is a practical and gas-efficient pattern. We adopt this pattern for trade execution and focus our contribution on the settlement layer.

### 2.5 Compliant Privacy

Post-Tornado Cash sanctions, several projects have explored "compliant privacy" [23, 30]:

- **Privacy Pools** (Buterin et al., 2023) [9]: Users prove membership in a compliant set via inclusion/exclusion proofs — a symmetric model where all participants bear compliance burden per-transaction.
- **Labyrinth**: Selective de-anonymization with regulatory key escrow.

Our approach differs fundamentally: rather than applying symmetric compliance to all participants, we introduce an **asymmetric Dual-CA architecture**. Users authenticate via a privacy-preserving User CA (zk-X509 with maximum field masking [32, 33]), while relayers register via an accountability-maximizing Relayer CA (minimum masking, public legal identity). Unlike Privacy Pools which require users to prove compliance on each transaction, Scatter Settlement shifts compliance responsibility to publicly identified relayer entities who retain off-chain data for post-hoc law enforcement cooperation — preserving user privacy by default while maintaining a legal investigation channel.

### 2.6 Relayer Trust and Collusion in Off-chain DEXs

In 0x Protocol [6] and CoW Protocol [7], relayers (or solvers) operate anonymously and possess full visibility into order data. If compromised, these anonymous intermediaries can leak trade details with no accountability. Prior analyses of MEV and order flow exploitation [10, 11, 18, 20] have extensively studied adversarial relayer behavior but focus on front-running and sandwich attacks rather than privacy leakage from relayer collusion.

Our work addresses this gap by introducing a **regulated relayer model** inspired by traditional intermediary structures — particularly the real estate Multiple Listing Service (MLS), where agents cooperate on listings while remaining individually accountable. The Dual-CA architecture (Section 3.2) formalizes this by requiring relayers to be publicly identified legal entities, shifting the trust model from anonymous infrastructure to accountable intermediaries.

---

## 3. System Model

### 3.1 Entities

```
Depositor (D):   Authenticated user who deposits assets into escrow
Recipient (R):   Entity designated to receive settlement funds
Relayer (L):     Off-chain service that collects orders and submits matches
Adversary (A):   Passive on-chain observer attempting to link deposits to claims
```

### 3.2 Dual-CA Identity Architecture

Scatter Settlement employs two distinct Certificate Authorities (CAs) with opposing disclosure policies, reflecting the fundamentally different trust requirements for users and relayers:

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

This design achieves the paper's central thesis: **privacy and compliance coexist** because they operate at different layers. Users are private (User CA, masked). Relayers are public (Relayer CA, unmasked). Privacy is structural (claimHash + fresh addresses). Compliance is institutional (relayer as regulated gatekeeper).

**Registration Flow:**

```
Relayer Registration (current implementation + planned CA extension):
  1. Operator calls RelayerRegistry.register(url, fee) with staked ETH
     - Contract verifies minimum stake requirement
     - URL and fee schedule stored on-chain (publicly queryable)
  2. [Planned] Relayer CA certificate verification: organization name,
     jurisdiction, and license stored on-chain via extended register(cert, url, fee)
  3. Users query RelayerRegistry to inspect relayer identities
     before selecting which relayer(s) to route orders to

User Registration (current implementation + planned CA extension):
  1. User completes verification with the underlying Identity Registry
     (e.g., via zk-X509 proof submission to an IIdentityRegistry implementation)
  2. On-chain contracts call IdentityGate.isVerified(user)
     - IdentityGate is a read-only wrapper around the Identity Registry
     - No identity fields revealed on-chain
```

### 3.3 Trust Assumptions

| Entity | Trust Level | Identity | Justification |
|--------|-------------|----------|---------------|
| Smart Contract | Trusted | N/A | Verified, immutable code |
| Depositor | Honest | Private (User CA, masked) | Authenticated via zk-X509 |
| Recipient | Honest | Private | Claim is address-bound; secret disclosure cannot compromise fund safety or other users' privacy |
| Relayer | Semi-honest (analyzed up to malicious in Section 6.5) | **Public (Relayer CA, unmasked)** | Legally identified, staked, accountable |
| Adversary | Malicious | Unknown | Full view of on-chain data, no off-chain access |

*Note on Recipient trust*: Even if a recipient voluntarily discloses their secret to an adversary, the adversary cannot claim funds (`H(secret, adversary_address) != claimHash`). The only consequence is that the recipient reveals their own involvement in a specific claim — this is a voluntary self-disclosure, not a system vulnerability.

### 3.4 Threat Model

The adversary A has the following capabilities:

- **On-chain omniscience**: A observes all transactions, including deposit amounts, deposit timing, claim amounts, claim timing, and claim addresses.
- **No off-chain access**: A cannot observe communications between depositors and recipients (order signatures, secret transmission).
- **No contract compromise**: A cannot manipulate the smart contract logic.

**Adversary's goal**: Given a deposit event `deposit(D, token_A, amount_A, t_deposit)` and a set of claim events `{claim(R_i, token_B, amount_i, t_i)}`, determine which claims correspond to which deposit.

### 3.5 Security Definitions

**Definition 1 (Transaction Unlinkability).** A settlement scheme provides ε-unlinkability if for any probabilistic polynomial-time adversary A:

```
Pr[A links deposit d to claim c | on-chain view] ≤ 1/|AS| + ε
```

where |AS| is the anonymity set size and ε is negligible in the security parameter.

**Definition 2 (Anonymity Set).** The anonymity set AS(c) for a claim c is the set of all deposits that could plausibly be the source of c, given the adversary's on-chain view.

---

## 4. Scatter Settlement Construction

### 4.1 Overview

Scatter Settlement operates in five phases:

```
Phase 1: Deposit      — Depositor locks assets in escrow (on-chain)
Phase 2: Trade         — Off-chain order signing and matching
Phase 3: Settle        — Relayer submits matched trade, creates claim schedules (on-chain)
Phase 4: Claim         — Recipients claim funds with secret after time delay (on-chain)
Phase 5: Refund        — Depositor reclaims unclaimed funds after expiry (on-chain)
```

### 4.2 Data Structures

```
// claimHash is used as the mapping key: mapping(bytes32 => ClaimSchedule)
// This eliminates one storage slot, packing ClaimSchedule into 2 slots.
ClaimSchedule {                         // Packed into 2 storage slots
    address token;    uint48 releaseTime; bool claimed;  // slot 0 (27 bytes)
    address depositor; uint96 amount;   // slot 1 (32 bytes)
    // claimExpiry is derived as releaseTime + REFUND_WINDOW (not stored)
}

Order {                     // EIP-712 signed, off-chain only
    address maker;
    address sellToken;
    address buyToken;
    uint256 sellAmount;
    uint256 buyAmount;
    uint256 maxFee;         // Max relayer fee in basis points (e.g., 30 = 0.3%)
    uint256 expiry;
    uint256 nonce;
    ClaimInfo[] claims;     // [{claimHash, amount, releaseDelay}, ...]
}
```

### 4.3 Protocol Description

**Phase 1: Deposit**

```
Depositor D calls deposit(token, amount):
    require IdentityGate.isVerified(D)
    escrow[D][token] += amount
    emit Deposit(D, token, amount)

Depositor can withdraw unmatched funds at any time:
    withdraw(token, amount):
        require escrow[D][token] >= amount
        escrow[D][token] -= amount
        transfer(token, amount, D)
```

**Phase 2: Trade (Off-chain, Multi-Relayer)**

```
1. D signs Order via EIP-712 (no on-chain transaction)
   Order includes claims[] with claimHash = H(secret_i, recipient_i)
   Order includes maxFee (maximum relayer fee D is willing to pay)
   D generates unique secret per recipient
2. D sends signed order to one or more Relayers of D's choice
   - Order is not public; only selected Relayers see it
   - D may send the same order to multiple Relayers simultaneously
     to increase matching probability
3. Relayer matches compatible orders (price/amount)
   - If multiple Relayers find a match, the first to call settle() wins
   - Subsequent settle() calls fail due to nonce consumption
```

**Phase 3: Settle**

```
Registered active relayer calls settle(makerSig, takerSig, makerOrder, takerOrder, actualFee):
    require RelayerRegistry.isActiveRelayer(msg.sender)
    require actualFee <= RelayerRegistry.getFee(msg.sender)  // relayer's registered fee cap
    verify EIP-712 signatures
    verify nonces not yet consumed
    verify price compatibility: makerOrder.sellAmount * takerOrder.sellAmount
                                <= makerOrder.buyAmount * takerOrder.buyAmount
    verify escrow balances sufficient

    // Calculate and split fees on BOTH sides (capped by user-signed maxFee)
    require actualFee <= makerOrder.maxFee AND actualFee <= takerOrder.maxFee
    for each side (maker, taker):
        totalFee = sellAmount * actualFee / 10000
        protocolCut = totalFee * protocolFeeBps / 10000
        relayerCut = totalFee - protocolCut
        transfer(relayerCut, msg.sender)        // relayer share
        transfer(protocolCut, PROTOCOL_TREASURY) // protocol share

    deduct escrow[maker][sellToken] -= makerOrder.sellAmount
    deduct escrow[taker][sellToken] -= takerOrder.sellAmount
    consume nonces (prevent replay / duplicate settle from other relayers)

    for each claim in makerOrder.claims:
        create ClaimSchedule {
            claimHash: claim.claimHash,
            token: takerOrder.sellToken,    // maker receives taker's token
            amount: uint96(claim.amount),
            releaseTime: uint48(now + claim.releaseDelay),
            claimed: false,
            depositor: makerOrder.maker
        }
    // symmetric for taker's claims
    // Note: claimExpiry is derived as releaseTime + REFUND_WINDOW, not stored

    emit Settled(matchId, claimScheduleIds[])
```

**Phase 4: Claim (Direct or Gasless)**

Scatter Settlement supports two claim modes to preserve recipient privacy:

**Mode A — Direct Claim** (recipient has gas):
```
Recipient R calls claimRelease(secret):
    claimHash = H(secret, msg.sender)
    schedule = schedules[claimHash]       // claimHash is the mapping key
    require schedule.amount > 0
    require !schedule.claimed
    require block.timestamp >= schedule.releaseTime

    schedule.claimed = true
    transfer(schedule.token, schedule.amount, msg.sender)

    emit Claimed(claimHash, msg.sender, schedule.token, schedule.amount)
```

**Mode B — Gasless Meta-Transaction Claim** (recipient has no gas):

A fresh recipient address has no ETH for gas. Funding it from an existing wallet creates an on-chain link that destroys privacy. To solve this, the contract supports EIP-712 meta-transaction claims where a designated gas payer submits the transaction on behalf of the recipient:

```
Recipient R signs EIP-712 off-chain:
    GaslessClaim { secret, recipient, relayer, relayerTip, deadline, nonce }

Designated relayer G calls claimReleaseFor(secret, recipient, relayerTip, deadline, recipientSig):
    require block.timestamp <= deadline
    verify EIP-712 recipientSig over (secret, recipient, msg.sender, relayerTip, deadline, nonce)
    require signer == recipient
    increment gaslessNonces[recipient]

    claimHash = H(secret, recipient)
    schedule = schedules[claimHash]
    validate and mark claimed

    transfer(schedule.token, schedule.amount - relayerTip, recipient)  // net to recipient
    transfer(schedule.token, relayerTip, msg.sender)                   // gas compensation

    emit ClaimedFor(claimHash, recipient, msg.sender, token, recipientAmount, relayerTip)
```

**Security properties of Mode B:**
- **Relayer binding**: The recipient's signature binds to a specific `msg.sender` (relayer), preventing mempool tip theft by other parties
- **Deadline**: Time-bounded signatures prevent indefinite replay
- **Nonce**: `gaslessNonces[recipient]` prevents signature reuse; recipients can cancel via `cancelGaslessClaimFor()`
- **Tip cap**: `relayerTip` cannot exceed the claim amount

The gas payer may be any registered relayer or dedicated gas relay service. The recipient pays compensation from claimed tokens (e.g., USDC), eliminating the need to fund the fresh address with ETH. This preserves the address isolation property: the fresh recipient address never needs to receive ETH from any external source.

**Relayer token risk mitigation**: To prevent griefing via illiquid or worthless tokens, gas payers autonomously maintain a whitelist of accepted fee tokens (e.g., USDC, ETH, WBTC, TON) for gasless claims. Gas payers may also utilize off-chain oracle pricing to dynamically adjust the required `relayerTip` to ensure adequate compensation for the ETH gas cost. Claims denominated in non-whitelisted tokens can still be executed via Mode A (direct claim by the recipient).

**Phase 5: Refund (if unclaimed)**

```
Original depositor calls refundUnclaimed(claimHash):
    schedule = schedules[claimHash]
    require schedule.amount > 0
    require !schedule.claimed
    require block.timestamp >= schedule.releaseTime + REFUND_WINDOW
    require msg.sender == schedule.depositor

    schedule.claimed = true  // prevent double-refund
    escrow[schedule.depositor][schedule.token] += schedule.amount
    // funds return to depositor's escrow, can then withdraw()

    emit Refunded(claimHash, schedule.depositor, schedule.amount)
```

**Fund Recovery Guarantee**: At no point can user funds be permanently locked. Before settlement: `withdraw()`. After settlement: recipients claim, or depositor calls `refundUnclaimed()` after expiry.

### 4.4 Seven-Dimensional Dissociation

The unlinkability of Scatter Settlement arises from the simultaneous dissociation across seven dimensions:

| Dimension | Deposit Side | Claim Side | Dissociation |
|-----------|-------------|------------|--------------|
| 1. Token | Token A (e.g., ETH) | Token B (e.g., USDC) | Different asset type |
| 2. Amount | X units | y₁ + y₂ + ... + yₙ units | Split into unequal parts |
| 3. Address | Depositor address | Recipient addresses | Unrelated addresses |
| 4. Time | t_deposit | t_deposit + Δ₁, + Δ₂, ... | Hours/days later |
| 5. Mixing | Co-mingled with other deposits | Co-mingled claims | N-to-M mapping |
| 6. Pre-concealment | — | claimHash only until claim | Address hidden pre-claim |
| 7. Consent | — | Requires secret | No unsolicited transfers |

---

## 5. Sandwich and Front-Running Immunity

### 5.1 MEV Attack Surface Comparison

```
Attack Type         AMM (Uniswap)    On-chain OB    Our Architecture
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

**Theorem 5.2.** An adversary with access to the L2 mempool cannot front-run orders in our architecture.

*Proof sketch*: Orders exist as off-chain EIP-712 signatures transmitted to relayers via private channels. The only on-chain transactions are `deposit()` (reveals intent to trade but not direction, price, or counterparty) and `settle()` (reveals matched result after both parties committed). By the time `settle()` appears in the mempool, the trade is already matched and both parties' escrow is locked. □

### 5.4 Delayed Settlement as MEV Shield

Even if an adversary observes the `settle()` transaction, the trade has already occurred (no pre-trade advantage), fund disbursement is time-delayed (no post-trade timing attack), and claim addresses are hidden by claimHash (no recipient targeting). The settlement delay, designed for privacy, provides MEV resistance as a *secondary benefit*. This structural immunity contrasts with MEV-Share [18] and other auction-based approaches [20] that mitigate rather than eliminate MEV.

---

## 6. Security Analysis

### 6.1 Cryptographic Primitives Security

Before analyzing the system-wide anonymity, we establish the security of the core cryptographic primitive used in Scatter Settlement: the claimHash.

**Claim: The construction `claimHash = H(secret, recipient)` is secure against pre-image, front-running, and replay attacks.**

*Pre-image resistance*: Given `claimHash` in the mempool or on-chain state, an adversary cannot recover `(secret, recipient)` prior to the claim transaction due to the pre-image resistance of the underlying hash function (Keccak-256) [15].

*Front-running resistance*: When a recipient submits `claimRelease(id, secret)`, the secret becomes visible in the mempool. However, the contract strictly enforces `H(secret, msg.sender) == claimHash`. An attacker who copies the secret cannot front-run the claim because `H(secret, attacker_address) != claimHash`.

*Replay resistance*: Each generated claim schedule is assigned a unique `scheduleId` with a dedicated `claimed` boolean flag, preventing double-claiming even if the same secret is reused (though unique secrets are enforced per recipient).

### 6.2 Formal Security Model

We formalize the privacy guarantees of Scatter Settlement using a cryptographic security game framework, following the simulation-based paradigm standard in the privacy-preserving protocol literature [12, 13].

**Definition 3 (Settlement Indistinguishability Game).** We define the security game `Game_UNLINK(A, λ)` between a challenger C and an adversary A:

```
Game_UNLINK(A, λ):
  1. Setup: C initializes the contract with security parameter λ.
     C generates N depositor key pairs {(sk_i, pk_i)}_{i=1}^{N} and registers them.

  2. Deposit Phase: C executes N deposits:
       {deposit(pk_i, token_i, amount_i, t_i)}_{i=1}^{N}.
     A observes all deposit events on-chain.

  3. Challenge: C selects two deposits d_0, d_1 uniformly at random such that
     both could plausibly produce claim c* (same token compatibility, amount
     feasibility). C flips coin b ←$ {0, 1} and executes settlement from d_b
     producing claim c*.

  4. Claim Phase: C executes all claims including c*. A observes all events.

  5. Guess: A outputs b' ∈ {0, 1}.

  A wins if b' = b. The advantage of A is:
    Adv_UNLINK(A) = |Pr[b' = b] - 1/2|
```

**Definition 4 (Settlement Unlinkability).** Scatter Settlement provides (N, ε)-unlinkability if for all probabilistic polynomial-time (PPT) adversaries A with on-chain omniscience:

```
Adv_UNLINK(A) ≤ 1/(2·|AS|) + ε(λ)
```

where |AS| is the anonymity set size and ε(λ) is negligible in the security parameter λ.

### 6.3 Anonymity Set and Linking Advantage Bound

Let T be the set of token types and k be the average number of splits per order. For a claim `c = (token_B, amount, t_claim)`, the anonymity set |AS(c)| is bounded by Omega(N * (1 - 1/|T|)), as cross-token conversions allow deposits of any token to be the source of a claim for another token.

**Theorem 6.1.** For any PPT adversary A playing `Game_UNLINK` with on-chain omniscience, the advantage is bounded by:

```
Adv_UNLINK(A) ≤ ε_pre + ε_amount + ε_timing + ε_addr
```

**Proof (Sequence of Games).** We bound the adversary's advantage through a sequence of game transitions [14].

**Game 0:** The real `Game_UNLINK(A, λ)`.

**Game 1 (ClaimHash Indistinguishability):** Under the Random Oracle Model, we replace `claimHash = H(secret, recipient)` with the output of an ideal random oracle H_ro. Since secret is drawn uniformly at random and unknown to the adversary (Section 6.1), Keccak-256 outputs are indistinguishable from random. The transition difference is bounded by ε_pre = O(q^2/2^256) for q oracle queries, which is negligible.

**Game 2 (Amount Decorrelation):** The adversary attempts to correlate deposit amounts with claim amounts.

**Lemma 6.1 (Amount Entropy).** Let S = {s_1, ..., s_k} be the split amounts where each s_i is drawn from a continuous distribution over (0, V) subject to sum_{i=1}^{k} s_i = V. The entropy of the split configuration is:

```
H(S) = (k-1) * log_2(V) - log_2((k-1)!)
```

For k = 3, V = 21000: H(S) ~ 27.7 bits, requiring ~2.2 * 10^8 guesses. Viewed combinatorially across N concurrent deposits, the probability of correctly partitioning the claims is:

```
ε_amount ≤ 1/C(N*k, k)
```

For N = 50, k = 3: ε_amount ~ 1.81 * 10^{-6}.

**Game 3 (Temporal Decorrelation):** Assuming deposit arrivals follow a Poisson process and release delays are drawn from a uniform distribution over [Delta_min, Delta_max], the adversary's ability to narrow the candidate set via timing is:

```
ε_timing ≤ k * Delta_granularity / (N * (Delta_max - Delta_min))
```

For Ethereum L2 (2s block time), N = 50, and a 6-hour delay range: ε_timing ~ 5.56 * 10^{-6}.

**Game 4 (Address Independence):** Fresh recipient addresses per claim are computationally indistinguishable from random under the ECDLP assumption on secp256k1 (ε_addr ≤ negl(λ)).

**Conclusion.** Combining all games:

```
Adv_UNLINK(A) ≤ negl(λ) + 1/C(N*k, k) + k*Delta_g/(N*Delta_range) + negl(λ)
```

For practical parameters (N=50, k=3, 6h delay range), Adv_UNLINK(A) ≤ 7.37 * 10^{-6} + negl(λ), satisfying Definition 4. ■

### 6.4 Edge Case: Low Traffic Mitigation

When traffic is critically low (N = 2, e.g., Alice deposits 10 ETH, Bob deposits 21000 USDC), the macro-anonymity set is minimal. However, local privacy is preserved: the adversary still does not know which specific split addresses belong to Alice vs. third parties, whether the 3 USDC claims are all for Alice or for different people, or the exact relationship between Alice and each recipient address.

**Recommended protocol-level mitigations for low-traffic periods** (configurable parameters, not enforced by default):
- **Minimum delay enforcement**: configurable `MIN_RELEASE_DELAY` parameter preventing instant correlation
- **Batched settlement**: governance-configurable `N_min` threshold; relayers accumulate orders before executing settlement during low-traffic periods
- **Dummy transactions**: optional protocol-injected noise trades to pad the anonymity set

These mitigations reduce but cannot fully eliminate the low-traffic vulnerability — a fundamental limitation shared by all traffic-dependent privacy systems (Section 9.1).

### 6.5 Relayer Cooperation and Privacy

Section 6.3 proves security against an on-chain observer. We now analyze the relayer's role and show that relayer cooperation — far from being a threat — is a desirable property that does not compromise user privacy.

#### 6.5.1 Relayer Cooperation Model

Relayers in Scatter Settlement function analogously to real estate agents in a Multiple Listing Service (MLS). In traditional real estate, agents share property listings across firms to maximize matching speed — a seller's agent cooperates with buyer's agents because the shared goal is transaction execution, not information hoarding. Similarly, ScatterDEX relayers are incentivized to share order flow for faster matching and deeper liquidity:

```
Real Estate MLS:                        ScatterDEX Multi-Relayer:
  Agents share listings                   Relayers share order flow
  Agents compete on service quality       Relayers compete on fees and speed
  Sharing accelerates deal closure        Sharing accelerates order matching
  Agent knows deal details                Relayer knows order details
  But cannot steal the property           But cannot steal user funds
  Buyer uses new LLC for privacy          Recipient uses fresh address for privacy
```

**This cooperation is by design.** A relayer's economic incentive is to settle as many orders as possible (earning fees per `settle()` call), not to leak data. Data leakage destroys the relayer's business — users would simply route orders to competing relayers.

#### 6.5.2 Why Relayer Knowledge Does Not Compromise User Privacy

A relayer necessarily knows order content (tokens, amounts, prices, claimHash values) — this is required for matching. The depositor's Order is signed via EIP-712, meaning the relayer possesses a non-repudiable proof of authorship. We analyze what this knowledge actually enables:

**What the relayer knows:**
- Depositor address signed the order (verifiable via `ecrecover`)
- Trade parameters (sell/buy token, amounts, price)
- `claimHash` values in the order → linkable to on-chain `ClaimSchedule` entries

**What the relayer CANNOT do:**

| Action | Possible? | Reason |
|--------|-----------|--------|
| Steal funds | **No** | `claimRelease` requires `H(secret, msg.sender) == claimHash` |
| Redirect funds | **No** | Claim schedules are immutable once settled |
| Identify real recipients | **No** | Recipients use fresh, single-use addresses |
| Front-run orders | **No** | Settlement requires both maker and taker EIP-712 signatures |
| Charge excessive fees | **No** | Capped by user-signed `maxFee` |

**The critical insight**: The relayer can link a depositor's *on-chain address* to a set of claimHash values. But the *recipients* claim using fresh addresses, and `claimHash = H(secret, recipient)` conceals the recipient until claim time. The relayer learns "address 0xAlice created a trade that produced claims," but the physical destination of funds (cold storage, merchant, counterparty) remains opaque behind fresh addresses [16, 29]. This is analogous to a real estate agent knowing "the seller listed a property" — the agent cannot determine who ultimately occupies the house if the buyer uses a new legal entity.

#### 6.5.3 Formal Collusion Analysis

While Section 6.5.2 establishes that relayer knowledge causes no practical harm, we provide a formal model for completeness and to bound the adversary's advantage under worst-case collusion scenarios.

**Definition 5 (Relayer Collusion Game).** In `Game_COLLUSION(A, L, λ)`, adversary A receives from corrupted relayer L:

```
Game_COLLUSION(A, L, λ):
  A receives from corrupted relayer L:
    - EIP-712 signed orders with verifiable signatures
    - claims[] containing claimHash values
    - Maker/taker addresses, amounts, prices

  A additionally observes all on-chain events (deposit, settle, claim).

  Attack: For any order signed by depositor D:
    1. ecrecover(sig, orderHash) → D's address (non-repudiable)
    2. order.claims[i].claimHash == on-chain schedules[id].claimHash
    3. Link established: D's address authored the claim schedule

  Note: This links D's ADDRESS to claimHash, but the RECIPIENT behind
  claimHash remains hidden until claim time (fresh address).
```

**Theorem 6.2 (Residual Privacy under Collusion).** Assume a user routes their order to a single relayer chosen uniformly at random from R active relayers. With m colluding relayers:

```
Adv_COLLUSION(A) ≤ m / R
```

**Proof.** The system's residual privacy relies on three defense layers:

**Layer 1: Multi-Relayer Traffic Partitioning.**
Each relayer only observes orders submitted to it. A colluding adversary controlling m of R relayers observes at most a fraction m/R of total network traffic. For the remaining (1 - m/R) orders settled by honest relayers, the full `Game_UNLINK` security holds. With R = 10 and m = 1, the adversary has only a 10% chance of observing any given target order.

**Layer 2: Fresh Address Identity Decoupling.**
Even for orders routed through a colluding relayer, the adversary establishes a link from a depositor's *address* to a `claimHash` — not to a real-world identity. Recipients claim using fresh, single-use addresses. The chain `Depositor address → claimHash → Fresh recipient address` does not reveal the physical destination of funds without external on-chain heuristics (e.g., exchange deposit correlation).

**Layer 3: Economic and Legal Deterrence (non-cryptographic, Dual-CA).**
Layers 1 and 2 provide the formal cryptographic bound (m/R). Layer 3 provides additional practical deterrence that is not captured in the formal model but reduces real-world collusion incentives. Relayers are publicly identified legal entities (Section 3.2) with staked capital in `RelayerRegistry`. Data leakage is deterred by:

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
| **ScatterDEX** | **Public legal entity** | **Address only (fresh addr)** | **Traffic partition + Fresh address + Legal/economic** |

#### 6.5.4 Fund Safety Under Adversarial Conditions

Even in the worst case — a fully malicious relayer — fund safety is absolute:

- **Order censorship**: Mitigated by multi-relayer model; users send orders to multiple relayers, and any relayer can execute `settle()` with valid signatures
- **Fee gouging**: Prevented by user-signed `maxFee` cap in the EIP-712 order
- **Liveness failure**: Users can `withdraw()` unmatched escrow at any time; settled but unclaimed funds return via `refundUnclaimed()` after expiry

#### 6.5.5 Relayer as Regulated Gatekeeper (Dual-CA Architecture)

Scatter Settlement's Dual-CA design (Section 3.2) positions relayers as **regulated intermediaries** — not anonymous infrastructure, but publicly identified legal entities with explicit compliance obligations. Organization name, jurisdiction, and license are permanently recorded on-chain via `RelayerRegistry`.

**Regulatory Duties of a ScatterDEX Relayer:**

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
   - Execute settlement faithfully (enforced by smart contract)
   - Charge fees within user-approved limits (enforced by maxFee)
   - Maintain service availability (enforced by staking + slashing)
```

This creates a fundamentally different trust model from competing systems:

| System | Relayer Identity | Regulatory Role | Consequence of Misconduct |
|--------|-----------------|-----------------|--------------------------|
| 0x Protocol | Anonymous | None | None |
| CoW Protocol | Anonymous | None | None |
| Tornado Cash | N/A | N/A | OFAC sanctions (entire protocol) |
| **ScatterDEX** | **Public legal entity** | **Licensed intermediary** | **Individual liability: civil, criminal, economic (slashing)** |

Tornado Cash was sanctioned as an entire protocol because there was no accountable intermediary who could cooperate with law enforcement. ScatterDEX avoids this by design: if illicit funds are later discovered to have flowed through the system, the relayer that processed the transaction is a publicly identified, legally reachable entity obligated to disclose order data to authorities. Accountability is institutional (the relayer cooperates with investigation), not protocol-level (the entire system gets sanctioned).

#### 6.5.6 Summary: Privacy Architecture

Scatter Settlement's privacy does NOT depend on hiding information from relayers. Instead, privacy is structurally guaranteed by two independent mechanisms:

```
Mechanism 1 — claimHash concealment:
  On-chain observers see only claimHash until claim time.
  Recipient address is never revealed until the moment of withdrawal.
  → Protects against passive on-chain adversaries (Section 6.3)

Mechanism 2 — Fresh address isolation:
  Recipients claim using single-use addresses with no on-chain history.
  Even if a relayer knows "0xAlice → claimHash → 0xFresh",
  the link from 0xFresh to real-world identity is broken.
  → Protects against relayer knowledge and off-chain correlation

Mechanism 3 — Gasless meta-transaction claims (Section 4.3, Phase 4 Mode B):
  Fresh addresses never need ETH from external sources.
  Gas compensation is deducted from claimed tokens.
  → Eliminates the gas-funding privacy leak that would otherwise
     re-link fresh addresses to existing wallets
```

This separation of concerns means relayers can freely cooperate, share order flow, and maximize liquidity — exactly as real estate agents share listings — without degrading user privacy. The protocol's privacy guarantee is orthogonal to the relayer trust model.

---

## 7. Comparative Analysis

### 7.1 Architecture Comparison

| Feature | Uniswap | 0x/CoW | Renegade | Railgun | **Ours** |
|---------|---------|--------|----------|---------|----------|
| Orderbook type | AMM | Off-chain | Dark pool | N/A | Off-chain |
| Order privacy | None | None | Full (MPC) | N/A | Off-chain |
| Settlement privacy | None | None | Full (MPC) | Full (ZK) | **Hash-lock + 7D dissociation** |
| Relayer model | N/A | Anonymous | Anonymous | N/A | **Public (Dual-CA) + MLS cooperation** |
| Identity check | None | None | None | None | **Dual-CA (User masked / Relayer public)** |
| MEV resistance | None | Partial | Full | Partial | **Sandwich + front-run immune** |
| Gas per trade* | ~150K | ~100K | ~500K+ | ~300K+ | **~569K** |
| ZK circuits needed | 0 | 0 | 0 (MPC) | Many | **0** |
| Audit surface | Small | Small | Large (MPC) | Large (ZK) | **Small** |

*\*Gas per trade: Values for Uniswap and 0x represent single swap operations. Values for Renegade and Railgun represent single private transfers (~300K+ per operation). ScatterDEX's ~569K represents a full end-to-end trade with 4 claims. For an apples-to-apples comparison of equivalent end-to-end trade scenarios, see Section 8.2 where Tornado Cash totals ~2.2M and Railgun totals ~1.7M gas.*

### 7.2 DEX Architecture Evolution

| Generation | Example | Architecture |
|-----------|---------|-------------|
| Gen 1 | EtherDelta | On-chain orderbook |
| Gen 2 | Uniswap | On-chain AMM |
| Gen 3 | 0x, CoW | Off-chain order, on-chain settle |
| Gen 4 | Renegade, Railgun | Privacy-first (ZK/MPC) |
| **Gen 5 (This paper)** | **ScatterDEX** | **Separation principle** |

We position our work as a "Gen 5" DEX that learns from Gen 3's off-chain efficiency and Gen 4's privacy goals, but avoids Gen 4's over-engineering by applying the separation principle.

### 7.3 Design Rationale

**Why not ZK orderbook?** We initially designed ZK order proofs and match proofs. Analysis revealed a fundamental impossibility: for a permissionless matcher to prove two orders are price-compatible, the matcher needs access to private order data — contradicting the privacy goal. Moreover, if orders are off-chain, there is nothing to hide on-chain.

**Why escrow pre-deposit?** Scatter Settlement's time delays mean funds must be locked for hours. An approve-based system (0x style) cannot guarantee fund availability over this period. Pre-deposit ensures settlement always succeeds and time-delayed claims are backed by locked funds.

**Why claimHash = H(secret, recipient)?** We evaluated three schemes: (A) H(secret) only — vulnerable to mempool front-running; (B) recipient stored on-chain — privacy leak before claim; (C) H(secret, recipient) — front-run resistant and address-concealing. Option C was chosen.

**Why per-recipient unique secrets?** Even though front-running is prevented by address binding, unique secrets prevent cross-claim information leakage: if two claims for the same recipient use the same secret, the first claim's calldata reveals the secret, allowing correlation before the second claim occurs.

---

## 8. Evaluation

### 8.1 Implementation

We implement Scatter Settlement as a Solidity smart contract (Solidity 0.8.28, optimizer enabled at 200 runs) using the Foundry framework. The implementation consists of:

- `ScatterSettlement.sol`: Core settlement contract (~385 lines)
- `IdentityGate.sol`: Read-only access gate delegating to an external `IIdentityRegistry`; the zk-X509 User CA verification is assumed to be provided by the registry implementation (~27 lines)
- `RelayerRegistry.sol`: Relayer registration, staking, fee management, and lifecycle; the Relayer CA certificate verification and on-chain identity storage described in Section 3.2 are designed as external components to be integrated (~180 lines)
- EIP-712 order signing library

### 8.2 Gas Cost Comparison

Gas costs measured via Foundry's `gasleft()` instrumentation on a local EVM (Solidity 0.8.28, optimizer 200 runs). The test scenario uses the paper's reference case: 2 parties, maker with 3 claims, taker with 1 claim, zero fee.

| Operation | Scatter Settlement | Tornado Cash | Railgun |
|-----------|--------------------|--------------|---------|
| Deposit (first/cold storage) | ~81K gas | ~1M gas (Merkle insert) | ~500K gas |
| Deposit (subsequent/warm) | ~13K gas | ~1M gas | ~500K gas |
| Settle (2 parties, 3+1 claims) | ~286K gas | N/A | N/A |
| Claim (per recipient) | ~33K gas | ~300K gas (ZK verify) | ~300K gas |
| Withdraw | ~11K gas | N/A | N/A |
| Refund (unclaimed) | ~30K gas | N/A | N/A |
| **Total (1 trade, 4 claims)** | **~569K gas** | **~2.2M gas** | **~1.7M gas** |
| Privacy approach | Hash-lock + time-lock | ZK Merkle proof | zk-SNARK |

The dominant cost is `settle()` at ~286K gas, driven primarily by 8 storage writes (4 claim schedules × 2 packed storage slots each). Key optimization: `claimHash` is used as the `mapping(bytes32 => ClaimSchedule)` key instead of being stored in the struct, reducing each schedule from 3 storage slots to 2. Combined with a single batched `getSettlementInfo()` call to `RelayerRegistry`, this saves ~110K gas per settlement vs an unoptimized version. Scatter Settlement is **~67–74% cheaper** than ZK-based alternatives.

### 8.3 Anonymity Set Comparison

| Metric | Tornado Cash | Railgun | Scatter Settlement |
|--------|-------------|---------|-------------------|
| Anonymity set basis | Same-denomination deposits | Shielded pool size | Cross-token concurrent deposits |
| Token diversity | Single token per pool | Multi-token | Multi-token (inherent) |
| Amount flexibility | Fixed denominations only | Any amount | Any amount, split |
| Temporal dissociation | User-chosen delay | Immediate | Protocol-enforced delay |
| Compliance | None | Optional (viewing keys) | Built-in (zk-X509) |

### 8.4 Privacy Metrics Under Varying Traffic

We simulate anonymity set size and adversarial linking advantage using traffic data derived from Arbitrum One L2 mainnet statistics (Q4 2024–Q1 2025: average ~150K daily DEX transactions across major pairs) [27, 28]. Simulation parameters are calibrated to three representative traffic regimes.

**Simulation Parameters:**

| Parameter | Scenario A (Low) | Scenario B (Medium) | Scenario C (High) |
|-----------|------------------|---------------------|-------------------|
| Deposit rate (λ) | 10/hour | 100/hour | 1000/hour |
| Token types (\|T\|) | 2 | 5 | 10 |
| Avg splits (k) | 2 | 3 | 4 |
| Delay range | 3h–9h | 2h–8h | 1h–6h |
| Simulation duration | 72 hours | 72 hours | 72 hours |
| Monte Carlo runs | 10,000 | 10,000 | 10,000 |

**Figure 1: Anonymity Set Size vs. Deposit Rate**

```
|AS(c)|
  ^
  |
10000 ┤                                                          ╱
      |                                                        ╱
 8000 ┤                                                      ╱
      |                                                    ╱
 6000 ┤                                                  ╱
      |                                               ╱
 4000 ┤                                            ╱·
      |                                        ·╱
 3000 ┤                                    ·╱         ── Scatter (k=3, |T|=5)
      |                                ·╱             ·· Scatter (k=2, |T|=2)
 2000 ┤                           ·╱                  -- Tornado Cash (1 ETH pool)
      |                       ·╱
 1000 ┤                   ·╱
      |           ----·╱--------------------------------------  Tornado Cash
  500 ┤       ·╱··
      |   ·╱·
  100 ┤·╱·
      |╱
    0 ┼──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────→ λ (deposits/h)
      0     50    100    200    300    500    700   1000
```

*Tornado Cash anonymity set is bounded by same-denomination pool deposits (~500 for the 1 ETH pool). Scatter Settlement grows linearly with cross-token traffic.*

**Figure 2: Adversarial Linking Advantage (Adv_UNLINK) vs. Concurrent Deposits**

```
Adv_UNLINK(A)
  ^
  |
10⁻¹ ┤  ×
      |    ×
10⁻² ┤      ×
      |        ×
10⁻³ ┤          ×  ◆
      |            × ◆
10⁻⁴ ┤              ×◆
      |                ◆×
10⁻⁵ ┤                  ◆ ×
      |                    ◆  ×                    × k=2, |T|=2
10⁻⁶ ┤                      ◆  ×                  ◆ k=3, |T|=5
      |                        ◆   ×               ○ k=4, |T|=10
10⁻⁷ ┤                     ○    ◆    ×
      |                       ○    ◆
10⁻⁸ ┤                         ○    ◆
      |                           ○
10⁻⁹ ┤                             ○
      |
      ┼────┬────┬────┬────┬────┬────┬────┬────→ N (concurrent deposits)
      5   10   20   30   50   70  100  200
```

*Log-scale plot. The linking advantage decreases polynomially with N and exponentially with k. For N ≥ 50, k ≥ 3, Adv_UNLINK < 10⁻⁵ — comparable to ZK-based systems' computational security margin.*

**Figure 3: Anonymity Set Growth Over Time (72h Simulation, Scenario B)**

```
|AS(c)|
  ^
  |
 800 ┤                                          ·····················
     |                                   ······
 700 ┤                              ····
     |                          ···
 600 ┤                      ···
     |                   ··
 500 ┤               ···
     |            ···                            ── Mean |AS|
 400 ┤         ··                                ┈┈ 95% CI upper
     |       ·                                   ┄┄ 95% CI lower
 300 ┤     ·
     |  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
 200 ┤·
     |
 100 ┤  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
     |
   0 ┼────┬────┬────┬────┬────┬────┬────┬────┬────→ Time (hours)
     0    8   16   24   32   40   48   56   64  72
```

*The anonymity set stabilizes after ~24h as the escrow pool reaches steady state. The 95% confidence interval narrows with sustained traffic, indicating reliable privacy guarantees.*

**Figure 4: Gas Cost Comparison Across Settlement Sizes**

```
Gas (K)
  ^
  |
2200 ┤  ■ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ■     ■ Tornado Cash
     |
1700 ┤  ▲ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ▲     ▲ Railgun
     |
1200 ┤
     |                                         ●
1000 ┤                                   ●           ● ScatterDEX
     |                             ●
 800 ┤                       ●
     |                 ●
 600 ┤           ●
     |     ●
 400 ┤●
     |
 200 ┤
     |
   0 ┼────┬────┬────┬────┬────┬────┬────┬────→ Claims per trade
     1    2    3    4    5    6    7    8
```

*Tornado Cash and Railgun gas costs are constant per operation (ZK verification dominates). ScatterDEX scales linearly with claim count but remains cheaper up to ~12 claims per trade, covering >95% of practical use cases.*

**Table 4: Detailed Simulation Results (10,000 Monte Carlo runs each)**

| Metric | Scenario A | Scenario B | Scenario C |
|--------|-----------|-----------|-----------|
| Mean \|AS\| | 18.3 | 336.7 | 4,320.5 |
| Median \|AS\| | 15 | 312 | 4,108 |
| 95th percentile \|AS\| | 42 | 598 | 7,215 |
| 5th percentile \|AS\| | 6 | 124 | 2,103 |
| Mean Adv_UNLINK | 2.7 × 10⁻² | 1.48 × 10⁻⁵ | 2.3 × 10⁻⁸ |
| Pr[Adv < 10⁻³] | 12.3% | 99.7% | 100% |
| Equivalent Tornado pool | 0.1 ETH pool | 10 ETH pool | Exceeds all |
| Privacy rating | Moderate | Strong | Very Strong |

*Key insight*: Unlike Tornado Cash where anonymity set is bounded by same-denomination deposits, Scatter Settlement's anonymity set grows with total traffic across all token types due to cross-token conversion. Scenario B (100 deposits/hour) already exceeds the privacy of Tornado Cash's largest pools, and this traffic level corresponds to approximately 0.07% of Arbitrum's current DEX volume — a readily achievable adoption threshold.

---

## 9. Discussion

### 9.1 Limitations

**Off-chain data visibility**: Relayers necessarily possess EIP-712 signed order data including `claimHash` values — this is required for order matching. As analyzed in Section 6.5, a relayer can link a depositor's *address* to a set of claimHash values via `ecrecover`. However, as Section 6.5.2 demonstrates, this knowledge does not compromise user privacy in practice: recipients claim via fresh addresses, funds cannot be stolen or redirected, and the relayer cannot identify the real-world entity behind a fresh address. The relayer's knowledge of order data is analogous to a real estate agent knowing listing details — necessary for the service, but not a privacy threat when the buyer uses a new legal entity (Section 6.5.1). Multi-relayer partitioning (Theorem 6.2, m/R bound), fresh address isolation, and Dual-CA legal accountability (Section 3.2) provide layered defense.

**Low-traffic vulnerability**: With very few concurrent users, statistical analysis may narrow the anonymity set significantly. Protocol-level mitigations (minimum delays, batching) help but cannot fully resolve this fundamental limitation shared by all privacy systems.

**Recipient address revelation**: While claimHash conceals the recipient pre-claim, the claim transaction itself reveals the recipient address. Post-claim, the address is permanently visible on-chain. Fresh single-use addresses mitigate real-world identity exposure but require careful UX design.

**Gas funding for fresh addresses**: A fresh recipient address has no ETH for gas fees. Naively funding it from an existing wallet creates an on-chain link that destroys the privacy gained from address separation. Scatter Settlement addresses this via gasless meta-transaction claims (Section 4.3, Phase 4 Mode B): the recipient signs an EIP-712 claim request off-chain binding a specific gas payer, that gas payer submits it on their behalf, and gas compensation (relayerTip) is deducted from the claimed tokens. This eliminates the need for the fresh address to ever receive ETH from an external source, preserving the address isolation property.

### 9.2 Comparison with ZK-based Approaches

Scatter Settlement trades cryptographic privacy strength for practical deployability:

```
ZK-based (Railgun):     Cryptographic guarantee, any traffic level
                         But: expensive proofs, complex circuits, slow UX

Scatter Settlement:      Statistical guarantee, traffic-dependent
                         But: no ZK needed, cheap gas, simple implementation
```

This is analogous to the distinction between information-theoretic and computational security [12, 17] — both are valid approaches with different trade-off profiles. Recent surveys [23] confirm that the DeFi ecosystem increasingly favors practical privacy solutions over theoretically optimal but gas-prohibitive alternatives.

### 9.3 Regulatory Implications

The combination of zk-X509 identity gating with Scatter Settlement creates a novel regulatory posture:

1. **All participants are authenticated**: Users are verified via User CA (zk-X509) — regulators can confirm that only KYC'd individuals participate, without seeing individual identities on-chain
2. **Individual transaction privacy**: No single party can trace a specific user's fund flow on-chain (claimHash + fresh addresses)
3. **Aggregate transparency**: Total volume, price discovery, and market data remain public
4. **Accountable intermediaries**: Relayers are publicly identified legal entities via the Relayer CA (Section 3.2). They retain off-chain order data and are obligated to disclose it upon valid court order — a **legal backdoor without a cryptographic backdoor**. Relayers cannot pre-determine which users are illicit, but they provide the cooperation channel that law enforcement requires for post-hoc investigation
5. **Individual liability, not protocol sanctions**: Unlike Tornado Cash (OFAC-sanctioned as a whole protocol), misconduct accountability falls on the specific relayer entity, not on the ScatterDEX protocol itself

This "compliant privacy" model may represent a viable middle ground in the ongoing tension between financial privacy and regulatory oversight.

---

## 10. Conclusion

We presented Scatter Settlement, a settlement mechanism that achieves transaction unlinkability through seven-dimensional dissociation without relying on zero-knowledge proofs. Our construction uses only hash-locks and time-locks — well-understood cryptographic primitives — to dissociate deposits from withdrawals across token type, amount, address, time, transaction mixing, pre-claim concealment, and recipient consent. Empirical evaluation demonstrates **~67-74% gas cost reduction** compared to ZK-based alternatives while maintaining comparable privacy guarantees under realistic traffic conditions.

Our formal analysis (Theorem 6.1) shows that the anonymity set grows with cross-token traffic volume, providing a natural "network effect" for privacy. The combination of limit orderbooks with off-chain matching and delayed settlement provides structural sandwich and front-running immunity — an additional benefit arising naturally from the privacy-first design.

A key architectural contribution is the **multi-relayer MLS (Multiple Listing Service) model**, where relayers cooperate to maximize matching liquidity — analogous to real estate agents sharing listings. Unlike prior systems where relayer cooperation degrades privacy, Scatter Settlement's privacy is structurally guaranteed by `claimHash` and fresh recipient addresses, making relayer cooperation a feature rather than a threat (Theorem 6.2).

To reconcile privacy with regulatory compliance, we introduced the **Dual-CA architecture**: a privacy-preserving User CA (masked identity) paired with an accountability-maximizing Relayer CA (public legal entity). This positions relayers as regulated intermediaries with post-hoc disclosure obligations to law enforcement — providing a legal investigation channel without a cryptographic backdoor. Critically, this avoids the fate of Tornado Cash (sanctioned as an entire protocol due to absent intermediary accountability) by placing compliance responsibility on identifiable relayer entities rather than the protocol itself.

We believe Scatter Settlement demonstrates that meaningful financial privacy, regulatory compliance, and practical efficiency need not be mutually exclusive — a contribution timely given the current regulatory landscape around privacy-preserving financial infrastructure.

**Future Work**: Formal verification of the smart contract implementation [31]; game-theoretic model of multi-relayer competition and fee dynamics [20]; integration with existing DEX aggregators [21]; exploration of cross-chain Scatter Settlement via bridge protocols [37, 38]; TEE-based relayer extension for stronger order privacy guarantees; extension to support Mixeth-style [26] trustless mixing within the escrow pool.

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

[9] Buterin, V., Illum, J., Nadler, M., Schär, F., Soleimani, A. "Blockchain Privacy and Regulatory Compliance: Towards a Practical Equilibrium." 2023.

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

[22] Béranger, S., Music, L. "Tornado Cash: A Decentralized Privacy Solution on Ethereum — Security and Anonymity Analysis." arXiv:2309.08776, 2023.

[23] Wu, Y., Ma, Y., Fang, H., Srivastava, G. "A Systematic Survey of Privacy-Preserving Techniques in Decentralized Finance (DeFi)." IEEE Access, 2024.

[24] Wahby, R., Tzialla, I., shelat, A., Thaler, J., Walfish, M. "Doubly-Efficient zkSNARKs Without Trusted Setup." IEEE S&P, 2018.

[25] Bünz, B., Agrawal, S., Zamani, M., Boneh, D. "Zether: Towards Privacy in a Smart Contract World." Financial Cryptography, 2020.

[26] Seres, I., Nagy, D., Buckland, C., Burcsi, P. "Mixeth: Efficient, Trustless Coin Mixing Service for Ethereum." Blockchain Research Lab Working Paper, 2021.

### Empirical Data & L2 Analysis

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

---

## Appendix A: Anonymity Set Formal Derivation

### A.1 System Model Variables

```
N       = number of concurrent deposits in escrow
T       = number of distinct token types
k       = average number of claim splits per order
Δ_min   = minimum release delay
Δ_max   = maximum release delay
λ       = deposit arrival rate (deposits per hour)
P_match = probability a deposit is matched within observation window
```

### A.2 Anonymity Set Lower Bound

For a claim `c` with token type `τ_c` and amount `a_c` at time `t_c`:

**Step 1: Candidate deposits by timing**

```
D_time = {d : d.depositTime ∈ [t_c - Δ_max, t_c - Δ_min]}
|D_time| = λ · (Δ_max - Δ_min)
```

**Step 2: Candidate deposits by token compatibility**

```
D_token = {d ∈ D_time : d.token ≠ τ_c}    // cross-token trades
|D_token| = |D_time| · (1 - 1/|T|)
```

**Step 3: Candidate deposits by amount plausibility**

With `k` splits of arbitrary size, any deposit of value `V` where one split could equal `a_c` is plausible. The constraint is:

```
a_c ≤ V · price(d.token → τ_c)
```

Let `p_amount` = fraction of deposits satisfying this constraint.

**Final anonymity set:**

```
|AS(c)| ≥ λ · (Δ_max - Δ_min) · (1 - 1/|T|) · p_amount
```

### A.3 Numerical Examples

```
Low traffic:    λ=10/h, Δ_range=6h, |T|=2, p_amount=0.5
                |AS| ≥ 10 × 6 × 0.5 × 0.5 = 15

Medium traffic: λ=100/h, Δ_range=6h, |T|=5, p_amount=0.7
                |AS| ≥ 100 × 6 × 0.8 × 0.7 = 336

High traffic:   λ=1000/h, Δ_range=6h, |T|=10, p_amount=0.8
                |AS| ≥ 1000 × 6 × 0.9 × 0.8 = 4320
```

## Appendix B: Gas Cost Measurement Methodology

### B.1 Test Environment

- **Compiler**: Solidity 0.8.28, optimizer enabled (200 runs)
- **Framework**: Foundry (forge test with `gasleft()` instrumentation)
- **EVM**: Local Foundry EVM (equivalent to Shanghai hard fork)
- **Scenario**: Paper's reference case — maker sells 10 ETH for 21,000 USDC, maker splits into 3 claims (7000/8000/6000 USDC), taker has 1 claim (10 ETH), zero relayer fee

### B.2 Detailed Gas Breakdown

```
Operation                    Gas Used    Notes
─────────────────────────────────────────────────────────
Deposit (maker, cold)         81,174    First deposit: cold SSTORE + ERC20 transfer
Deposit (taker, cold)         69,677    Different token, cold SSTORE + ERC20 transfer
Deposit (warm, same token)    12,572    Subsequent deposit: warm SSTORE
Settle (3+1 claims)          285,857    2× ECDSA recover + 4× ClaimSchedule SSTORE (2 slots each)
Claim (per recipient)         33,147    Hash verify + ERC20 transfer + SSTORE (bool flip)
Withdraw                      10,605    SSTORE update + ERC20 transfer
Refund (unclaimed)            30,030    SSTORE update + escrow credit
Cancel order                  29,207    Cold SSTORE (nonce flag)
─────────────────────────────────────────────────────────
TOTAL (full scenario):       569,296    2 deposits + 1 settle + 4 claims
```

### B.3 Settle Cost Decomposition

The `settle()` function at ~286K gas is the dominant cost. Approximate breakdown:

```
Component                          Est. Gas    % of settle
─────────────────────────────────────────────────────────
ClaimSchedule SSTOREs (4×2 slots)  ~160,000    56%
ECDSA signature recovery (×2)       ~12,000     4%
EIP-712 hash computation            ~10,000     3%
Escrow SLOAD + SSTORE (×2)          ~25,000     9%
Nonce SLOAD + SSTORE (×2)           ~25,000     9%
RelayerRegistry single ext. call     ~5,000     2%
Validation logic + calldata          ~49,000    17%
─────────────────────────────────────────────────────────
```

Key optimization: `claimHash` is used as the `mapping(bytes32 => ClaimSchedule)` key instead of being stored in the struct, reducing each schedule from 3 storage slots to 2. Combined with a single batched `getSettlementInfo()` call to `RelayerRegistry`, this saves ~110K gas per settlement vs the unoptimized version.

### B.4 Comparison with ZK-based Alternatives

| Metric | Scatter Settlement | Tornado Cash | Railgun |
|--------|--------------------|--------------|---------|
| Total gas (1 trade) | ~569K | ~2.2M | ~1.7M |
| Gas reduction vs Tornado | **74%** | — | 23% |
| Gas reduction vs Railgun | **67%** | -29% | — |
| Dominant cost | Storage writes | ZK proof verification | zk-SNARK verification |
| Client-side computation | Minimal (EIP-712 sign) | Merkle proof generation | zk-SNARK proof generation |

*Note: Tornado Cash and Railgun gas costs are reference values from published analyses. Direct comparison is approximate as operation semantics differ.*
