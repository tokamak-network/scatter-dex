# Gas Cost Analysis: Standard vs ZK Private Settlement

> Measured via Foundry trace on local EVM (Solidity 0.8.28, optimizer 200 runs)
> Last updated: 2026-04-07

## Test Scenario

- 2 parties (maker + taker)
- Maker: 3 claims, Taker: 1 claim
- Zero fee for baseline comparison

## Gas Measurement

| Operation | Standard | ZK Private | Notes |
|-----------|----------|------------|-------|
| Deposit (cold) | ~81K | ~810K | ZK: Poseidon Merkle insert (depth 20) |
| Deposit (warm) | ~13K | ~657K | ZK: 2nd Merkle insert (partial warm) |
| Settle (3+1 claims) | ~290K | ~1,633K | ZK: Groth16 verify + 2 commitment inserts |
| Claim (per recipient) | ~33K | ~83K | ZK: proof verify + nullifier check |
| Withdraw | ~11K | N/A | Standard only |
| Refund (unclaimed) | ~30K | N/A | Standard only |
| **Total (1 trade, 4 claims)** | **~569K** | **~3,565K** | **ZK ≈ 6.3× Standard** |

> Note: ZK measurements use MockVerifier. Real on-chain Groth16 verification adds ~200K gas per proof.

## Cost Comparison

### Ethereum L1 — Current (0.035 Gwei, ETH=$1,800)

| | Standard | ZK Private |
|------|----------|------------|
| Total gas | ~569K | ~3,565K |
| Cost (ETH) | 0.0000199 ETH | 0.000125 ETH |
| **Cost (USD)** | **$0.036** | **$0.225** |
| **Cost (KRW)** | **₩51** | **₩322** |

### Ethereum L1 — Average (0.5 Gwei, ETH=$1,800)

| | Standard | ZK Private |
|------|----------|------------|
| Cost (ETH) | 0.000285 ETH | 0.00178 ETH |
| **Cost (USD)** | **$0.51** | **$3.21** |
| **Cost (KRW)** | **₩730** | **₩4,590** |

### Base L2 (~0.001 Gwei, ETH=$1,800)

| | Standard | ZK Private |
|------|----------|------------|
| Cost (ETH) | 0.000000569 ETH | 0.00000357 ETH |
| **Cost (USD)** | **$0.001** | **$0.006** |
| **Cost (KRW)** | **₩1** | **₩9** |

## Competitor Comparison (L1, 0.035 Gwei)

| System | Gas | USD | KRW | Privacy |
|--------|-----|-----|-----|---------|
| **Standard Scatter** | ~569K | $0.036 | ₩51 | Statistical (traffic-dependent) |
| **ZK Private Scatter** | ~3,565K | $0.225 | ₩322 | Cryptographic (Groth16 + stealth) |
| Tornado Cash | ~2,200K | $0.139 | ₩199 | ZK Merkle proof |
| Railgun | ~1,700K | $0.107 | ₩153 | zk-SNARK |

### Key Insights

- **Standard mode**: 67-74% cheaper than Tornado Cash / Railgun
- **ZK mode**: ~1.6× Tornado Cash, ~2.1× Railgun — higher cost due to Poseidon Merkle tree (depth 20)
- **L2 deployment**: Both modes under ₩10 — cost difference is negligible
- **Dominant cost in ZK**: CommitmentPool deposit (~810K gas) — Poseidon hash × 20 levels

## When to Use Which Mode

| | Standard | ZK Private |
|------|----------|------------|
| **Best for** | Everyday trades, high-traffic markets | Large trades, identity-sensitive, low-traffic |
| **Privacy** | Statistical (anonymity set grows with traffic) | Cryptographic (traffic-independent) |
| **Gas cost** | ~569K (~₩51 at current L1) | ~3,565K (~₩322 at current L1) |
| **UX complexity** | Low (MetaMask only) | Medium (EdDSA key + stealth address) |
| **Wallet exposure** | Deposit/claim visible | msg.sender = relayer (stealth) |

## Gas Price Reference

| Period | Avg Gas Price | Source |
|--------|--------------|--------|
| 2024 Q4 | ~3 Gwei | Etherscan |
| 2025 Q1 | ~0.5 Gwei | Etherscan |
| 2025 Q2-Q4 | ~0.1-0.5 Gwei | Etherscan |
| 2026 Q1 (current) | ~0.035 Gwei | [Etherscan tx](https://etherscan.io/tx/0xf7f68a03fc75acbd3ebc54455ef5d1d816b1b7b68480ea7fc4aff24c397334cf) |
