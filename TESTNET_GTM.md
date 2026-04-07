# Testnet Launch & GTM (Go-To-Market) Strategy

> The testnet is not just for catching bugs — it's a **showroom for VCs and the community**.

---

## 1. Chain Selection

The paper mentions Arbitrum, but **Base (Coinbase L2)** is where the current market hype is.

**Recommendation: Deploy to Base Sepolia**

- Position as **"The compliant privacy layer for Base ecosystem"**
- Attracts Coinbase Ventures' attention
- Base has strong regulatory alignment (Coinbase's compliance DNA), which matches ScatterDEX's zk-X509 identity gating narrative perfectly
- Lower competition in privacy tooling on Base vs Arbitrum

## 2. "Aha!" Moment UI/UX

Scatter's power is **"time-delayed split settlement"**. The frontend must make this visible.

### 2.1 My Scatter Dashboard

Build a **[My Scatter Status Board]** that visually shows:

- **Split visualization**: "Your order was split into 3 parts" with amount bars
- **Time-delay progress bars**: Each split shows a countdown timer + progress bar to unlock
- **Anonymity set indicator**: "Your transaction is mixed with ~150 other deposits"
- **Claim status**: locked → claimable → claimed, with animations

### 2.2 zk-X509 Identity Gamification

- Build a **mock certificate issuer** for testnet
- Show a "Verified Anonymous User" badge after mock KYC
- Make the verification flow feel like a game achievement
- Badge text: "You are a regulation-compliant anonymous user"
- Visual: shield icon with checkmark, animated on first verification

### 2.3 Gasless Claim UX

- Recipients should never see a "gas fee required" screen
- **Standard claim**: one-click claim with relayer tip (EIP-712 signed)
- **ZK private claim**: browser generates ZK proof → zk-relayer submits on-chain (fully gasless, no wallet connection)
- Settlement fee covers relayer gas costs (gas-inclusive minimum fee auto-calculated per claim count)

## 3. Testnet Milestones

### Completed
- [x] Gasless claim contract (claimReleaseFor) — PR #22
- [x] Claim link generation + auto-fill + preview — PR #25
- [x] Gasless claim frontend UI — PR #27
- [x] Paper enhancement (Dual-CA, MLS model, formal proofs) — PR #23
- [x] All security issues resolved (H-1/2, M-1/3/4/5, L-1/2/3/4)
- [x] Multicall3 batch query optimization — PR #26
- [x] ZK private settlement (CommitmentPool + PrivateSettlement + circuits) — PR #50
- [x] Stealth address claim — PR #74
- [x] Gasless ZK claim via zk-relayer — PR #78, #80
- [x] Relayer fee calculation (private settlement) — PR #84
- [x] Gas-inclusive minimum fee + clickable breakdown — PR #85
- [x] E2E tests 36/36 passing — PR #86
- [x] EdDSA key AES-GCM encryption in localStorage — PR #87
- [x] Incremental Merkle tree (O(depth) insert) — PR #88

### Phase 1: Core Demo (Week 1-2)
- [ ] Deploy ScatterSettlement + RelayerRegistry + IdentityGate to Base Sepolia
- [ ] Deploy mock IdentityRegistry (testnet-only certificate issuer)
- [ ] Whitelist testnet WETH, USDC, TON tokens
- [ ] Basic relayer running with orderbook matching

### Phase 2: Frontend Polish (Week 3-4)
- [ ] My Scatter Dashboard with split visualization
- [ ] Time-delay progress bars
- [ ] Mock zk-X509 badge flow
- [x] ~~Multicall batch query optimization~~ (done in PR #26)

### Phase 3: Community Testing (Week 5-6)
- [ ] Public testnet launch announcement
- [ ] Bug bounty program
- [ ] Community trading competition (testnet tokens)
- [ ] Collect UX feedback

## 4. VC Narrative

**Elevator pitch**: "ScatterDEX is the first DEX that solves the privacy-compliance-efficiency trilemma. We combine hash-lock scatter settlement for standard trades with full ZK privacy (Groth16 + stealth addresses) for maximum anonymity — all with built-in KYC compliance via zk-X509."

**Key differentiators for VC pitch**:
1. **Regulatory moat**: zk-X509 identity gating = compliant by design (post-Tornado Cash world)
2. **Dual privacy modes**: Standard scatter settlement (67-74% cheaper than ZK alternatives) + ZK private settlement (full privacy with commitment pools and stealth addresses)
3. **Gasless UX**: ZK claims require no wallet connection — zk-relayer pays gas, settlement fee covers costs
4. **Multi-relayer model**: no single point of failure, censorship resistant
5. **Base ecosystem alignment**: Coinbase's regulatory DNA + Base's developer momentum

## 5. Marketing Hooks

- "Privacy that regulators can live with"
- "Your money, your privacy, their compliance"
- "The anti-Tornado Cash: private AND legal"
- "See your trades scatter in real-time" (dashboard visualization)
