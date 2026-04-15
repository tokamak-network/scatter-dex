# zkScatter: Private DEX Settlement with Zero-Knowledge Proofs and Regulatory Compliance

> Technical Whitepaper — v1.0
>
> **Implementation update (2026-04)**: The settlement path described throughout this paper as `PrivateSettlement.settlePrivate()` with a single monolithic `settle.circom` proof has been superseded by the **Half-proof architecture**: each user proves their own side in the browser with `circuits/authorize.circom` and the relayer submits both proofs together via `PrivateSettlement.settleAuth(makerProof, takerProof)`. The legacy `settle.circom`, `ISettleVerifier.sol`, `settlePrivate()`, and `PrivateSettled` event have been removed from the repository. The paper's arguments about privacy, compliance, and gas cost all carry over — the on-chain settlement function name is the main observable difference. See `docs/architecture/architecture-v2.md` and `docs/design/circuit-split/design.md` for details.

---

## 1. Executive Summary

zkScatter is a privacy-preserving decentralized exchange (DEX) settlement system that makes fund flows cryptographically untraceable while maintaining regulatory compliance. Users deposit tokens into a zero-knowledge commitment pool, trade via off-chain signed orders, and settle through Groth16 proofs that break the on-chain link between depositors and recipients. Unlike mixing protocols or MPC-based dark pools, zkScatter's privacy is **cryptographic, not statistical** — it holds regardless of trading volume. A Dual-CA identity architecture separates user privacy (masked identity via zk-X509) from relayer accountability (public legal entity), creating a compliance model where law enforcement can investigate through regulated intermediaries without any cryptographic backdoor. Deployable on both Ethereum L1 (under $3 at current gas prices) and L2 (under $0.01).

---

## 2. Problem

Decentralized exchanges face a trilemma between three competing requirements:

```
Privacy:     Users want their financial flows to be untraceable
Compliance:  Regulators demand that participants be authenticated
Efficiency:  Complex cryptographic proofs are expensive on-chain
```

Existing systems resolve at most two of these three:

| System | Privacy | Compliance | Efficiency |
|--------|---------|------------|------------|
| Uniswap / Traditional DEX | No | No | Yes |
| Tornado Cash | Yes | No | Yes |
| Railgun | Yes | No | Moderate |
| Renegade | Yes | No | No (MPC/FHE) |
| Jigsaw [23] | Yes | No | Yes |
| **zkScatter** | **Yes** (cryptographic) | **Yes** (Dual-CA) | **Yes** (L1 + L2) |

Tornado Cash was sanctioned by OFAC because it had no accountable intermediary. Renegade achieves privacy through expensive multi-party computation. Railgun provides ZK privacy but no compliance mechanism. Jigsaw [23], the most recent privacy-trade primitive in this space, achieves "doubly private" (on-chain + off-chain) execution by extending Collaborative zkSNARKs across a group of mutually-untrusting servers, but likewise leaves accountability and a regulator-facing audit surface outside of its scope and requires a server group rather than per-user client-side proving. No existing system solves all three.

---

## 3. Solution Overview

### The Core Insight

Prior privacy DEX designs try to hide the *trade itself* — encrypting orders, proving matches in zero-knowledge, concealing execution. This requires expensive cryptographic machinery at the matching layer.

zkScatter takes a different approach: **trade transparency does not imply fund flow transparency**. An observer who knows "someone sold 10 ETH at price 2100" learns nothing about where the resulting USDC ended up if the settlement is cryptographically dissociated from the trade.

### Three-Layer Separation

Privacy is concentrated in the settlement layer using ZK commitment pools:

```
+──────────────────────────────────────────────────────────────────+
|  Layer 1 — DEPOSIT                                               |
|  User deposits tokens into a Poseidon commitment pool.           |
|  On-chain: commitment hash, token, amount.                       |
|  Hidden: trade intent, price, counterparty, recipient.           |
+──────────────────────────────────────────────────────────────────+
                              |
                              v
+──────────────────────────────────────────────────────────────────+
|  Layer 2 — TRADE & SETTLE                                        |
|  Off-chain EdDSA order signing; on-chain Groth16 settlement.     |
|  On-chain: nullifiers, claims roots, locked amounts.             |
|  Hidden: maker/taker identities, claim structure, order params.  |
+──────────────────────────────────────────────────────────────────+
                              |
                              v
+──────────────────────────────────────────────────────────────────+
|  Layer 3 — CLAIM                                                 |
|  Recipient proves Merkle inclusion via ZK proof.                 |
|  On-chain: recipient address, amount, nullifier.                 |
|  Hidden: link to original deposit and settlement — no            |
|  statistical analysis can recover it.                            |
+──────────────────────────────────────────────────────────────────+
```

This separation means relayers can freely cooperate to maximize matching liquidity without degrading user privacy — because privacy comes from ZK proofs, not from hiding data from relayers.

---

## 4. System Architecture

### 4.1 Entities

```
Depositor:   Authenticated user who deposits assets into the commitment pool
Recipient:   Entity designated to receive settlement funds via ZK claim
Relayer:     Off-chain service that collects orders, generates proofs, submits settlements
```

### 4.2 Dual-CA Identity

zkScatter uses two distinct Certificate Authorities with opposing disclosure policies:

```
+─────────────────────────────────────────────────────────────────+
|  User CA (Privacy-Preserving)                                    |
|  - zk-X509 certificate with maximum field masking                |
|  - On-chain: only "is a verified human" proven via ZK proof      |
|  - No identity fields revealed                                   |
|  - Rationale: users require financial privacy                    |
+─────────────────────────────────────────────────────────────────+

+─────────────────────────────────────────────────────────────────+
|  Relayer CA (Accountability-Maximizing)                           |
|  - zk-X509 certificate with minimum field masking                |
|  - On-chain: organization name, jurisdiction, license visible    |
|  - Legal entity publicly verifiable                              |
|  - Rationale: relayers are service providers with legal duties   |
+─────────────────────────────────────────────────────────────────+
```

The asymmetry is intentional. Users are *subjects* of financial privacy protection; relayers are *licensed intermediaries* with fiduciary obligations analogous to traditional financial service providers.

**Multi-CA IdentityGate**: The IdentityGate contract aggregates multiple zk-X509 registries (one per CA). The Owner can add or remove registries. A user is verified if **any** registered CA has authenticated them. Two separate IdentityGate instances are deployed — one for user deposits (privacy-preserving CAs) and one for relayer registration (accountability CAs).

### 4.3 Commitment Pool

The commitment pool is an incremental Merkle tree (depth 20, ~1M capacity) using Poseidon hashes:

```
Commitment = Poseidon(ownerSecret, token, amount, salt)
Nullifier  = Poseidon(ownerSecret, salt)
```

- **ownerSecret**: private key material known only to the depositor (never on-chain)
- **token**: ERC20 token address
- **amount**: deposited amount
- **salt**: random nonce for uniqueness

The commitment hides all details. The nullifier enables double-spend prevention — consuming a commitment reveals only a hash that cannot be linked back to the original deposit.

### 4.4 ZK Circuits

zkScatter uses three Groth16 circuits:

**Settle Circuit (~30K constraints)**
Verifies a complete trade inside a single ZK proof:
- Both maker and taker commitments exist in the Merkle tree
- Nullifiers correctly derived (prevents replay)
- EdDSA signatures valid for both orders (Baby Jubjub curve)
- Token compatibility and price compatibility
- Fee validation (actual fee <= user-signed maxFee)
- Balance sufficiency
- Claims tree roots correctly computed from up to **N claim leaves per side**, where N is an implementation parameter set to 16 in the reference circuit (see §13 "Implementation parameters")
- Change commitments correctly derived from residual balances
- Self-trade prevention (different public keys)

**Claim Circuit (~1.5K constraints)**
Verifies that a recipient can claim funds:
- Claim leaf exists in the claims Merkle tree (depth 4)
- Claim nullifier correctly derived (prevents double-claim)
- Recipient address bound as public input (prevents redirection)

**Withdraw Circuit (~6K constraints)**
Allows users to withdraw unmatched deposits:
- Commitment exists in the Merkle tree (depth 20)
- Nullifier correctly derived
- Token and amount binding
- Change commitment for residual balance

### 4.5 Multi-Relayer Network

Relayers operate like agents in a real estate Multiple Listing Service (MLS) — they cooperate on order flow to maximize matching speed while competing on service quality:

```
Real Estate MLS:                        zkScatter Multi-Relayer:
  Agents share listings                   Relayers share order flow
  Agents compete on service quality       Relayers compete on fees and speed
  Sharing accelerates deal closure        Sharing accelerates order matching
  Agent knows deal details                Relayer knows order details
  But cannot steal the property           But cannot steal user funds
```

This cooperation is by design. A relayer's economic incentive is to settle as many orders as possible (earning fees per settlement), not to leak data. Data leakage destroys the relayer's business — users simply route orders to competing relayers.

---

## 5. How It Works

### Phase 1: Identity Verification

Users verify their identity with a registered Certificate Authority via zk-X509. The on-chain contracts call `UserIdentityGate.isVerified(user)`, which returns true if any registered CA has verified the user. No identity fields are revealed on-chain.

Relayers register via `RelayerRegistry.register(url, fee)` with staked ETH. The Relayer IdentityGate verifies their CA certificate, and their organization name, jurisdiction, and license are stored on-chain.

### Phase 2: Deposit

```
User calls CommitmentPool.deposit(commitment, token, amount):
  1. IdentityGate verifies the user is authenticated
  2. ERC20 tokens transfer from user to the pool
  3. Commitment is inserted into the Merkle tree
  4. CommitmentInserted event emitted (commitment hash, leaf index, timestamp)
```

The commitment is `Poseidon(ownerSecret, token, amount, salt)`, computed off-chain. The contract does not verify the preimage — if a user submits a malformed commitment, only they are harmed.

### Phase 3: Order Signing (Off-chain)

```
1. User derives an EdDSA key pair on the Baby Jubjub curve
   (deterministically from MetaMask signature, stored encrypted in browser)

2. User constructs order with claim leaves:
   claimLeaf = Poseidon(secret, recipient, token, amount, releaseTime)
   claimsRoot = MerkleRoot(claimLeaf_1, ..., claimLeaf_n, 0, ..., 0)

3. User signs the order hash with EdDSA

4. User sends signed order + claim secrets to chosen Relayer(s)
   - Order is not public; only selected Relayers see it
   - User may send to multiple Relayers simultaneously
```

### Phase 4: Settlement

The Relayer matches compatible orders and generates a Groth16 proof:

```
Relayer calls PrivateSettlement.settlePrivate(proof, publicSignals):

  The proof verifies (in zero-knowledge):
    - Both commitments exist in the pool
    - Both EdDSA signatures are valid
    - Prices are compatible, fees are within limits
    - Claims trees are correctly constructed
    - Change commitments are correctly derived

  The contract:
    - Verifies the Groth16 proof
    - Marks nullifiers as spent (prevents replay)
    - Inserts change commitments into the pool
    - Transfers claim amounts to PrivateSettlement
    - Transfers fees directly to the relayer
    - Registers ClaimsGroups (keyed by claims root)
```

If multiple Relayers find a match for the same order, the first to submit wins — subsequent attempts fail because the nullifier is already consumed.

### Phase 5: Claim

**Direct Claim** (recipient has gas):

```
Recipient calls claimWithProof(proof, claimsRoot, nullifier, amount, token, recipient, releaseTime):

  The proof verifies:
    - Claim leaf exists in the claims tree
    - Nullifier correctly derived (prevents double-claim)

  The contract:
    - Verifies proof and checks nullifier
    - Confirms totalClaimed + amount <= totalLocked
    - Confirms block.timestamp >= releaseTime
    - Transfers tokens to recipient
```

**Gasless Claim** (recipient has no gas):

A fresh recipient address has no ETH for gas. Funding it from an existing wallet creates an on-chain link that destroys privacy. Instead:

1. Recipient generates the ZK claim proof in their browser (proof binds recipient address as public input)
2. Recipient sends proof to the relayer
3. Relayer submits `claimWithProof()` on behalf of the recipient
4. Gas cost is compensated through the settlement fee mechanism

The relayer cannot redirect funds — the proof cryptographically binds the recipient address. The fresh address never needs ETH from any external source, preserving address isolation.

### Withdrawal (Unmatched Deposits)

Users can withdraw unmatched funds at any time via a ZK withdraw proof. The proof verifies commitment ownership and derives a nullifier. An optional change commitment handles partial withdrawals.

---

## 6. Privacy Guarantees

### What Is Hidden

zkScatter provides **cryptographic unlinkability** — on-chain observers cannot determine which deposit funded which claim. This is enforced across seven dimensions:

| Dimension | Deposit Side | Claim Side | How It Is Hidden |
|-----------|-------------|------------|-----------------|
| Token | Token A (e.g., ETH) | Token B (e.g., USDC) | Cross-token conversion inside ZK proof |
| Amount | X units | y1 + y2 + ... + yn units | Split amounts hidden in proof |
| Address | Depositor address | Fresh recipient addresses | ZK proof hides depositor; recipient uses fresh address |
| Time | t_deposit | Multiple claim times | Release times set inside proof |
| Mixing | Co-mingled in commitment pool | Claims from opaque root | All commitments in single tree |
| Pre-concealment | Commitment hash only | Claims root only until claim | Nothing revealed before claim |
| Authorization | -- | Requires ZK proof | Only proof-holder can claim |

### Why This Is Stronger Than Statistical Privacy

Mixing protocols like Tornado Cash provide **statistical** privacy: the adversary's advantage scales inversely with the anonymity set size (1/N where N is the number of deposits in the pool). With low traffic, privacy degrades significantly.

zkScatter's privacy is **cryptographic**: the zero-knowledge property of Groth16 proofs ensures that on-chain observers learn *nothing* about the deposit-to-claim mapping, regardless of traffic volume. Even with a single deposit in the pool, the ZK proof reveals no information about which commitment was consumed.

The key mechanisms:

1. **ZK Commitment Pool**: Deposits are Poseidon commitments. Settlements consume them via nullifiers — no depositor address appears in the settlement transaction.

2. **Claims Tree Indirection**: Settlement produces claims roots (Merkle roots of claim leaves). Each claim leaf uses a fresh random secret, making it computationally indistinguishable from random data.

3. **Gasless ZK Claims**: Fresh recipient addresses never need external ETH, eliminating the gas-funding link that would re-connect fresh addresses to existing wallets.

---

## 7. MEV Immunity

zkScatter is structurally immune to sandwich attacks and front-running — the two most costly MEV vectors in existing DEXs.

```
Attack Type         AMM (Uniswap)    On-chain OB    zkScatter
──────────────────────────────────────────────────────────────
Sandwich            Vulnerable        Vulnerable     Impossible
Front-running       Vulnerable        Vulnerable     Impossible
Back-running        Vulnerable        Possible       Impossible
JIT Liquidity       Vulnerable        N/A            N/A
Oracle Manipulation Vulnerable        N/A            N/A
```

**Why sandwich attacks fail**: In a limit orderbook, a buy order at price P executes at exactly P regardless of other orders. There is no price impact curve to exploit. An attacker who places a sell order at P-1 merely sells at a worse price, losing money.

**Why front-running fails**: Orders exist as off-chain EdDSA signatures transmitted to relayers via private channels. The only on-chain transactions are `deposit()` (which reveals no trade intent) and `settlePrivate()` (which executes an already-matched trade atomically). By the time settlement appears in the mempool, the trade is complete — the adversary cannot extract order parameters from the ZK proof and cannot front-run a completed settlement.

**Why the ZK proof is an additional shield**: Even if an adversary observes `settlePrivate()`, the proof reveals no information about order parameters (zero-knowledge property), and claim recipients are hidden behind the claims root. The verification is a single atomic operation with no intermediate state to exploit.

---

## 8. Compliance Model

### How Privacy and Compliance Coexist

Privacy and compliance operate at **different layers**:

- **Users are private**: User CA, masked identity, ZK proofs
- **Relayers are public**: Relayer CA, unmasked legal entity, on-chain identity
- **Privacy is cryptographic**: enforced by ZK proofs at the protocol level
- **Compliance is institutional**: enforced by relayer as regulated gatekeeper

### Relayer as Regulated Intermediary

Relayers are publicly identified legal entities with explicit compliance obligations:

**Data Retention and Disclosure**: Relayers maintain off-chain order logs and provide signed order data in response to valid court orders. They cannot pre-determine which users are illicit — the obligation is post-hoc disclosure, not pre-screening.

**Sanctions Screening**: Relayers screen depositor addresses against public sanctions lists (e.g., OFAC SDN) as a baseline compliance measure.

**Transaction Integrity**: Relayers generate valid proofs faithfully (enforced by proof verification), charge fees within user-approved limits (enforced by the ZK circuit), and maintain service availability (enforced by staking and slashing).

### How Law Enforcement Works

If illicit funds are discovered to have flowed through zkScatter:

1. Law enforcement identifies the relayer that processed the transaction (relayer identity is public on-chain)
2. A valid court order or regulatory subpoena compels the relayer to disclose off-chain order data
3. The relayer provides the signed order details, claim recipients, and associated data

This is a **legal backdoor without a cryptographic backdoor**. User privacy is preserved at the protocol level; lawful investigation proceeds through the relayer's regulated intermediary role.

### Why This Avoids the Tornado Cash Problem

Tornado Cash was sanctioned as an entire protocol because there was no accountable intermediary who could cooperate with law enforcement. zkScatter avoids this by design: misconduct accountability falls on the specific relayer entity, not the protocol itself.

| System | Relayer Identity | Regulatory Role | Consequence of Misconduct |
|--------|-----------------|-----------------|--------------------------|
| 0x Protocol | Anonymous | None | None |
| CoW Protocol | Anonymous | None | None |
| Tornado Cash | N/A | N/A | OFAC sanctions (entire protocol) |
| **zkScatter** | **Public legal entity** | **Licensed intermediary** | **Individual liability** |

---

## 9. Security Properties

### Double-Spend Prevention

Each commitment can be spent at most once. The nullifier `Poseidon(ownerSecret, salt)` is deterministic — the same commitment always produces the same nullifier. The contract rejects any previously seen nullifier.

### Commitment Hiding

A commitment `Poseidon(ownerSecret, token, amount, salt)` is computationally hiding under the collision resistance of Poseidon. Given only the commitment hash, an adversary cannot determine the preimage without knowledge of ownerSecret, which never appears on-chain.

### Commitment Binding

Under Poseidon's collision resistance, no two distinct (ownerSecret, token, amount, salt) tuples produce the same commitment. A depositor is cryptographically bound to a specific token and amount.

### Claims Conservation

The settle circuit enforces `totalLocked = sum(claimAmounts)` and `totalLocked + fee <= sellAmount`. The on-chain contract enforces `totalClaimed <= totalLocked`. Together, these ensure no more tokens can be claimed than were legitimately settled.

### Change Commitment Correctness

The settle circuit enforces that change commitments are correctly derived from residual balances. If the residual balance is zero, the change commitment must be zero (no phantom UTXOs).

### Front-Running Resistance

Claim proofs bind the recipient address as a public input. Even if an adversary intercepts the proof, they cannot redirect funds — the contract only sends tokens to the address embedded in the proof.

### Fund Safety Under Adversarial Relayers

Even a fully malicious relayer cannot compromise fund safety:

| Action | Possible? | Reason |
|--------|-----------|--------|
| Steal funds | No | Claim proof binds recipient as public input |
| Redirect funds | No | Claims roots are committed in the settle proof |
| Identify depositor's real identity | No | EdDSA key is derived per-session; not linked to Ethereum address |
| Front-run orders | No | Settlement requires both parties' EdDSA signatures inside the ZK proof |
| Charge excessive fees | No | Fee cap enforced inside the ZK circuit |
| Modify claim structure | No | Claims root is signed by both parties |

### Relayer Privacy Implications

A relayer necessarily knows order content (tokens, amounts, prices, claim secrets, recipient addresses) — this is required for proof generation. However:

- The relayer knows the user's EdDSA public key, but this is **not** the user's Ethereum address. The EdDSA key is derived per-session from a MetaMask signature.
- On-chain, the settlement shows only: nullifier consumed, claims root created, tokens transferred. No depositor address appears.
- Multi-relayer traffic partitioning limits what any single relayer can observe. With R relayers and m colluding, the adversary observes at most m/R of network traffic.

---

## 10. Comparison

### Architecture Comparison

| Feature | Uniswap | 0x/CoW | Renegade | Railgun | **zkScatter** |
|---------|---------|--------|----------|---------|---------------|
| Orderbook type | AMM | Off-chain | Dark pool | N/A | Off-chain |
| Order privacy | None | None | Full (MPC) | N/A | Off-chain (EdDSA) |
| Settlement privacy | None | None | Full (MPC) | Full (ZK) | **Full (Groth16)** |
| Relayer model | N/A | Anonymous | Anonymous | N/A | **Public (Dual-CA)** |
| Identity check | None | None | None | None | **Dual-CA** |
| MEV resistance | None | Partial | Full | Partial | **Immune** |
| Gas per trade | ~150K | ~100K | ~500K+ | ~300K+ | ~3,565K* |
| ZK circuits | 0 | 0 | 0 (MPC) | Many | 3 |
| Privacy guarantee | None | None | Computational | Computational | **Computational** |

*Gas comparison note: Uniswap/0x numbers are single swaps without privacy. An equivalent end-to-end private trade requires multiple operations, totaling ~1.7M (Railgun) and ~2.2M (Tornado Cash). zkScatter's ~3,565K covers a complete private trade with 4 claims. On L2, this costs under $0.01.*

### Privacy Comparison

| Metric | Tornado Cash | Railgun | **zkScatter** |
|--------|-------------|---------|---------------|
| Privacy type | Computational (ZK) | Computational (ZK) | **Computational (ZK)** |
| Traffic dependence | Yes (anonymity set) | Partial (pool size) | **No (cryptographic)** |
| Token diversity | Single token per pool | Multi-token | **Cross-token trades** |
| Amount flexibility | Fixed denominations | Any amount | **Any amount, multi-recipient** |
| Compliance | None | Optional (viewing keys) | **Built-in (Dual-CA)** |
| Depositor revealed | Yes (deposit address) | Yes (shielded address) | **No (commitment only)** |

### DEX Architecture Evolution

| Generation | Example | Architecture |
|-----------|---------|-------------|
| Gen 1 | EtherDelta | On-chain orderbook |
| Gen 2 | Uniswap | On-chain AMM |
| Gen 3 | 0x, CoW | Off-chain order, on-chain settle |
| Gen 4 | Renegade, Railgun, Jigsaw [23] | Privacy-first (ZK/MPC) |
| **Gen 5** | **zkScatter** | **ZK commitment pools + Dual-CA compliance** |

### Closest Prior Art: Jigsaw [23]

Jigsaw (Garg, Goel, Kolonelos, Sinha; *Jigsaw: Doubly Private Smart Contracts*; Cryptology ePrint Archive Paper 2025/1147; first published 2025-06-18, last revised 2025-10-15) is the nearest published construction in the privacy-trade design space and is identified here as the closest prior art to the present disclosure. Jigsaw proposes a framework for **doubly private smart contracts** that addresses both on-chain *and* off-chain privacy, in which clients submit privacy-preserving requests to a group of mutually-untrusting servers that **collaboratively match** those requests "without learning any information about the data or identities of the clients" (Jigsaw abstract). The realization builds on the ZEXE architecture (Bowe et al., S&P 2020) and extends Collaborative zkSNARKs (Ozdemir and Boneh, USENIX 2022) to enable **proof generation by a group of servers**. The Jigsaw paper demonstrates the framework on sample applications including a decentralized exchange, auctions, and voting.

zkScatter differs from Jigsaw in ways that are each load-bearing, and none of these differences are incidental to the present disclosure:

1. **Single-prover client-side proving versus collaborative multi-server proving.** Jigsaw's proofs are produced by a *group* of (mutually-untrusting) servers running a Collaborative zkSNARK; the privacy guarantee depends on no majority of those servers colluding. zkScatter under the Half-proof primitive (`circuits/authorize.circom`, see [docs/circuit-split/design.md](circuit-split/design.md)) places the entire proving step on the **end user's own device**: each user proves their own side in the browser, and the relayer only ever sees public proof outputs. The trust assumption reduces from "no collusion across the server group" to "the user's own local device is uncompromised", which is dramatically more deployable for browser/mobile end users and is *the* architectural reason zkScatter does not need the Collaborative zkSNARK machinery Jigsaw relies on.

2. **Dual-CA compliance layer.** Jigsaw, like Tornado Cash, Railgun, Renegade, and Penumbra, has no integrated compliance or accountability layer; the abstract makes no mention of identity, audit, or regulator cooperability. zkScatter's Dual-CA identity model (§4.2, §8) is what the present disclosure claims as the mechanism that lets per-user privacy and regulator-facing cooperability co-exist without forcing users to surrender either, and is what addresses the Tornado Cash regulatory failure mode (§8 "Why This Avoids the Tornado Cash Problem").

3. **Layer 3 trade-and-claim dissociation.** Jigsaw's collaborative-server pipeline produces a *single* settlement step per trade. zkScatter inserts a third, separately-provable step (§4.4 claim circuit, §5 Phase 5) that proves Merkle inclusion of a recipient in a claims tree committed at settlement time, **without revealing which claim is being redeemed**. This decoupling turns computational privacy into traffic-independent cryptographic privacy at the recipient layer — a property that is not present in any single-step settlement primitive, including Jigsaw.

4. **Federated relayer accountability vs. collaborative server model.** Jigsaw's "mutually untrusting" servers are accountable only for liveness and correctness (the Collaborative zkSNARK protocol detects deviations). They are not accountable to a regulator and have no on-chain identity. zkScatter's federated relayer model — public Dual-CA identity in `RelayerRegistry`, record-only `DisputeRegistry`, reputation enforcement — is a co-designed accountability layer that Jigsaw does not provide.

5. **Multi-recipient claim distribution (implementation parameter, not a claim element).** Jigsaw's sample DEX application settles a single output per party. zkScatter's settle / authorize circuit authorises a *set* of claims per side, bounded by an implementation parameter N (set to 16 in the reference circuit; see §13 for the parameterisation note). This enables atomic fan-out to multiple recipients in a single trade, used in the §11 reference scenario (3 maker claims + 1 taker claim). N is not itself a claim-narrowing element.

The present disclosure is filed in full acknowledgement of Jigsaw as the closest prior art. Claims covering points 1 (single-prover client-side proving with non-collaborative server requirement), 2 (Dual-CA coupling), 3 (Layer 3 trade-and-claim dissociation), and 4 (federated relayer accountability) are each written narrowly enough to be patentable over Jigsaw. Point 5 is described as an implementation feature only.

---

## 11. Gas Costs and Performance

### Gas Measurements

Measured via Foundry on a local EVM (Solidity 0.8.28, optimizer 200 runs). Reference scenario: maker sells 10 ETH for 21,000 USDC, maker splits into 3 claims, taker has 1 claim, zero fee.

| Operation | Gas Used | Notes |
|-----------|----------|-------|
| Deposit (first/cold) | ~810K | Poseidon Merkle insert (depth 20) |
| Deposit (subsequent/warm) | ~657K | 2nd insert (partial warm storage) |
| Settle (3+1 claims) | ~1,633K | Groth16 verify + 2 commitment inserts + transfers |
| Claim (per recipient) | ~83K | Groth16 verify + nullifier check + transfer |
| **Total (1 trade, 4 claims)** | **~3,565K** | **2 deposits + 1 settle + 4 claims** |

Note: Gas measurements use MockVerifier. Real on-chain Groth16 verification adds ~200K gas per proof (~4.4M total).

### Settle Cost Breakdown

The `settlePrivate()` function at ~1,633K gas is the dominant cost:

```
Component                                  Est. Gas    % of settle
──────────────────────────────────────────────────────────────────
Groth16 proof verification (16 signals)     ~200,000    12%
Commitment insertions (2x Poseidon x 20)    ~800,000    49%
Token transfers (4x ERC20)                  ~200,000    12%
Nullifier storage (4x cold SSTORE)          ~100,000     6%
ClaimsGroup storage (2x cold, 2 slots)       ~80,000     5%
Validation logic + calldata                 ~253,000    16%
```

### Deployment Costs

Thanks to historically low Ethereum L1 gas prices (as low as ~0.36 Gwei observed in April 2025 [21]), zkScatter is practically deployable on Ethereum mainnet:

| Network | Gas Price | Cost per Trade (USD) |
|---------|-----------|---------------------|
| Ethereum L1 | ~0.36 Gwei | ~$2.35 |
| Ethereum L1 | ~1.0 Gwei | ~$6.50 |
| Base L2 | ~0.001 Gwei | ~$0.006 |
| Optimism | ~0.01 Gwei | ~$0.064 |
| Arbitrum | ~0.01 Gwei | ~$0.064 |

At current L1 gas prices, a full private trade (deposit + settle + claim) costs under $3 — affordable for high-value privacy-sensitive trades. L2 deployment brings costs under $0.10 for everyday use.

### Circuit Complexity

| Circuit | Constraints | Proof Time (est.) | Verification Gas |
|---------|------------|-------------------|-----------------|
| settle | ~30K | ~2s (browser) | ~200K |
| claim | ~1.5K | ~0.5s (browser) | ~200K |
| withdraw | ~6K | ~1s (browser) | ~200K |

Groth16 verification cost is constant (~200K gas) regardless of circuit size, due to the constant-size proof and fixed verification algorithm.

---

## 12. Design Rationale

**Why not a ZK orderbook?** For a permissionless matcher to prove two orders are price-compatible, the matcher needs access to private order data — contradicting the privacy goal. If orders are off-chain, there is nothing to hide on-chain. The separation principle resolves this by keeping orders off-chain and concentrating privacy in the settlement layer.

**Why a commitment pool with pre-deposit?** Claims may have release time delays, and the pool must fund multiple claims from a single settlement. Pre-deposit ensures settlement always succeeds. The UTXO model (commitment + nullifier) provides natural double-spend prevention.

**Why EdDSA on Baby Jubjub?** EdDSA verification on Baby Jubjub costs ~10K constraints inside ZK circuits, versus ~100K+ for ECDSA/secp256k1. This keeps the settle circuit tractable at ~30K total constraints.

**Why Poseidon?** Poseidon costs ~200 constraints per hash invocation versus ~25K for Keccak-256. Since the settle circuit performs multiple hashes, Poseidon reduces circuit size by an order of magnitude.

**Why per-recipient unique secrets?** Unique claim secrets prevent cross-claim correlation. If two claims used the same secret, the first claim's parameters could enable correlation before the second claim occurs.

---

## 13. Limitations and Future Work

### Known Limitations

- **Proof generation latency**: The settle circuit (~30K constraints) requires ~2 seconds for browser-based proof generation. Optimized native or GPU provers can reduce this.
- **Gas cost on L1**: At ~3.5M gas per trade, zkScatter costs ~$2.35 on Ethereum mainnet at current gas prices (~0.36 Gwei). This is affordable for high-value trades; L2 deployment further reduces costs for everyday use.
- **Relayer knowledge**: Relayers know order content for proof generation, but this does not compromise security. They cannot steal funds (ZK proof + contract enforcement), modify orders (EdDSA signature), or overcharge fees (user-signed maxFee cap). EdDSA keys are decoupled from Ethereum addresses, so order data does not reveal real-world identity.
- **Recipient address revelation at claim time**: The claim transaction reveals the recipient address and amount. Fresh single-use addresses mitigate real-world identity exposure.
- **Key management**: Users must manage EdDSA keys in addition to Ethereum keys. Deterministic derivation from MetaMask signatures simplifies this but adds UX complexity.

### Implementation parameters (not claim-limiting)

The following numerical values appear in the reference implementation and throughout this disclosure. They are **implementation parameters** and are not intended to limit the scope of the disclosed invention. A practitioner of ordinary skill in the art may vary any of them without departing from the inventive concept; the specific values below are chosen to balance circuit size, proof-generation time, and typical usage patterns observed in the reference scenario (§11). Any variation that preserves the inventive architecture (Layer 1/2/3 separation, dual-CA identity, ZK commitment pools, nullifier-based double-spend prevention) falls within the disclosure and does not require a continuation filing.

| Parameter | Reference value | Where set | Variation without inventive change |
|---|---|---|---|
| **N** — maximum claims per side in a single settlement | **16** | `settle.circom` / `authorize.circom` — `maxClaimsPerSide = 16`, claims tree depth `ceil(log2(N)) = 4` | Any power-of-two `N ∈ {2, 4, 8, 16, 32, 64, …}` is valid. Changing `N` requires regenerating the circuit and re-running the trusted setup ceremony, but introduces no new inventive step. `N = 16` is chosen because the reference scenario in §11 (3 maker + 1 taker claims = 4 total per side) comfortably fits under it and the resulting claims tree depth (4) is negligible relative to the 30K-constraint total. A future production deployment targeting batch-distribution use cases may select `N = 32` or `N = 64`; this disclosure is intended to cover all such variations. |
| **D** — commitment Merkle tree depth | **20** (capacity 2²⁰ ≈ 1M commitments) | `CommitmentPool` / `settle.circom` — `commitTreeDepth = 20` | Any `D ∈ {16, 20, 24, 28, 32}` is valid, trading off tree capacity against per-insertion constraint cost (≈ D Poseidon hashes per insert). `D = 20` is chosen to support ~1M lifetime commitments per pool, which matches Tornado Cash's reference depth and fits comfortably in the 30K-constraint budget. |
| **ROOT_HISTORY_SIZE** — number of historical roots retained in the on-chain ring buffer | **30** (reference) | `IncrementalMerkleTree.sol` constructor argument | Any positive integer is valid. Larger values lengthen the asynchronous matching window (§circuit-split); smaller values save an equivalent number of storage slots. The specific value is a deployment-time choice. |
| **Amount range check** — bit-width of trade amount signals | **126 bits** | `settle.circom` / `authorize.circom` — `Num2Bits(126)` on `sell/buy amounts` | **This value is NOT freely variable** — see `docs/circuit-split/bit-width-audit.md`. 126 bits is the maximum width at which the 252-bit price product fits the `LessEqThan(252)` internal representation without wrapping the BN254 scalar field. Narrower values (e.g., 125 bits) are safe; wider values (127+) are unsafe. This is a correctness constraint, not a parameter choice. |
| **Fee bps precision** | **16 bits** (max 65535, 100% = 10000) | `settle.circom` — `Num2Bits(16)` on `makerFee`, `takerFee` | Any width `≤ 126` is safe (it leaves ample headroom when multiplied against 126-bit amounts). 16 bits is chosen because it matches the conventional basis-point encoding used in DeFi fee schedules. |
| **REVEAL_WINDOW** — fair-exchange reveal deadline | **5 minutes** | `relayer-protocol/design.md` §5.4, §13 | Any positive duration is valid. Must match `DisputeRegistry.REVEAL_WINDOW`. Shorter windows improve throughput but tighten the timing budget for relayers; longer windows are more forgiving of network jitter. |

**Claim of scope**: the disclosed invention is defined by the combination of the architectural elements described in §3-§9 (three-layer separation, dual-CA identity, ZK commitment pools, nullifier double-spend prevention, federated relayer accountability). The numerical values in the table above are provided to enable reproducibility of the reference implementation, and embodiments using different values for any row labelled "freely variable" fall within the scope of the disclosure. Only the row marked "NOT freely variable" (the 126-bit amount range check) is a correctness boundary rather than a parameter choice, and even that is a consequence of the target elliptic curve (BN254), not of the inventive concept itself — implementations targeting a different curve (BLS12-381, BW6-761, etc.) would have a different correctness boundary.

### Future Work

- Formal verification of Circom circuits and Solidity contracts
- Game-theoretic model of multi-relayer competition and fee dynamics
- Integration with existing DEX aggregators
- Cross-chain zkScatter via bridge protocols
- Recursive proof composition to reduce on-chain verification to a single proof
- Trusted setup ceremony for production Groth16 parameters
- Optimization of settle circuit constraint count through custom gates

---

## 14. References

### Privacy-Preserving DEX and DeFi

[1] Renegade. "A Dark Pool DEX Using MPC." https://renegade.fi, 2023.

[2] Railgun. "Privacy System for DeFi." https://railgun.org, 2022.

[3] Penumbra. "A Private DEX on Cosmos." https://penumbra.zone, 2023.

[4] Pertsev, A., Semenov, R., Storm, R. "Tornado Cash Privacy Solution." 2019.

[5] Poon, J., Dryja, T. "The Bitcoin Lightning Network." 2016.

[6] Warren, W., Bandeali, A. "0x: An Open Protocol for Decentralized Exchange on the Ethereum Blockchain." 2017.

[7] CoW Protocol. "Batch Auctions with Coincidence of Wants." https://cow.fi, 2022.

[8] 1inch Network. "Fusion Mode: Intent-Based Swaps with Resolvers." https://1inch.io, 2023.

[9] Buterin, V., Illum, J., Nadler, M., Schar, F., Soleimani, A. "Blockchain Privacy and Regulatory Compliance: Towards a Practical Equilibrium." 2023.

### MEV and Front-Running

[10] Daian, P. et al. "Flash Boys 2.0: Frontrunning in Decentralized Exchanges." IEEE S&P, 2020.

[11] Eskandari, S. et al. "SoK: Transparent Dishonesty — Front-Running Attacks on Blockchain." FC Workshop, 2020.

### Cryptographic Foundations

[12] Goldreich, O. "Foundations of Cryptography: Volume 2." Cambridge University Press, 2004.

[13] Canetti, R. "Universally Composable Security." FOCS, 2001.

[14] Shoup, V. "Sequences of Games." Cryptology ePrint Archive, 2004.

### Privacy Protocols

[15] Bunz, B. et al. "Zether: Towards Privacy in a Smart Contract World." FC, 2020.

[16] Seres, I. et al. "Mixeth: Efficient, Trustless Coin Mixing Service for Ethereum." 2021.

### Compliance and Identity

[17] Zcash Foundation. "Selective Disclosure and Viewing Keys in Shielded Protocols." 2022.

[18] Sonnino, A. et al. "Coconut: Threshold Issuance Selective Disclosure Credentials." NDSS, 2019.

### Hash Functions

[19] Grassi, L. et al. "Poseidon: A New Hash Function for Zero-Knowledge Proof Systems." USENIX Security, 2021.

### MEV Mitigation

[20] Flashbots. "MEV-Share: Programmable Order Flow." 2023.

[21] Etherscan. "Transaction 0x4461cc699fb0b82e — Gas Price 0.357707362 Gwei." https://etherscan.io/tx/0x4461cc699fb0b82e14e0572e44dbd9390c440659dd693d249e268484b2ba9a0b, April 2025.

[22] Babel, K. et al. "Clockwork Finance: Automated Analysis of Economic Security." IEEE S&P, 2023.

[23] Garg, S., Goel, A., Kolonelos, D., Sinha, R. "Jigsaw: Doubly Private Smart Contracts." Cryptology ePrint Archive, Paper 2025/1147, 2025. https://eprint.iacr.org/2025/1147 *(First published 2025-06-18, last revised 2025-10-15. Identified as the closest prior art during the prior-art search for this disclosure; see §10 "Closest Prior Art: Jigsaw [23]". Verbatim title and author list confirmed against the ePrint record on 2026-04-10.)*
