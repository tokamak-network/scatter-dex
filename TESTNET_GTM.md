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
- One-click claim: sign message → relayer handles the rest
- Show relayer tip transparently: "Gas fee: 0.5 USDC (paid from your claim)"

## 3. Testnet Milestones

### Completed
- [x] Gasless claim contract (claimReleaseFor) — PR #22
- [x] Claim link generation + auto-fill + preview — PR #25
- [x] Gasless claim frontend UI — PR #27
- [x] Paper enhancement (Dual-CA, MLS model, formal proofs) — PR #23
- [x] All security issues resolved (H-1/2, M-1/3/4/5, L-1/2/3/4)
- [x] Multicall3 batch query optimization — PR #26

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

**Elevator pitch**: "ScatterDEX is the first DEX that solves the privacy-compliance-efficiency trilemma. We achieve Tornado Cash-level privacy at 74% lower gas cost, with built-in KYC compliance — no zero-knowledge proofs needed."

**Key differentiators for VC pitch**:
1. **Regulatory moat**: zk-X509 identity gating = compliant by design (post-Tornado Cash world)
2. **Gas efficiency**: 67-74% cheaper than ZK alternatives (measured, not estimated)
3. **Simple audit surface**: hash-locks + time-locks only, no ZK circuits to audit
4. **Multi-relayer model**: no single point of failure, censorship resistant
5. **Base ecosystem alignment**: Coinbase's regulatory DNA + Base's developer momentum

## 5. Marketing Hooks

- "Privacy that regulators can live with"
- "Your money, your privacy, their compliance"
- "The anti-Tornado Cash: private AND legal"
- "See your trades scatter in real-time" (dashboard visualization)
