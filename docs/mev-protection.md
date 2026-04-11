# MEV Protection for Market Orders

> Last updated: 2026-04-11

## The Problem

When a user submits a `settleWithDex` market order, the transaction is visible in the public mempool. MEV bots can:

1. **Sandwich attack**: buy before the user → price goes up → user buys at higher price → bot sells for profit
2. **Frontrunning**: copy the trade with better gas → execute first

## Defense Layers

### Layer 1: On-chain (contract)

| Defense | Implementation |
|---------|---------------|
| **Slippage protection** | `DexOutputInsufficient(actual, required)` — reverts if output < `totalLocked` |
| **Deadline** | `DeadlineExpired()` — reverts if `block.timestamp > deadline` (default 30 min) |
| **1inch Pathfinder** | Splits orders across multiple DEXes, reducing single-pool slippage |

### Layer 2: Private mempool (recommended)

Use **Flashbots Protect** to send market order transactions through a private channel, bypassing the public mempool entirely.

#### What is Flashbots Protect?

- Free service by [Flashbots](https://www.flashbots.net/) ($1B valuation, backed by Paradigm + a16z)
- Sends transactions directly to block builders, skipping the public mempool
- 90%+ of Ethereum blocks are built through Flashbots infrastructure
- Used by MetaMask, Uniswap, 1inch

#### How to enable (frontend)

The frontend automatically uses Flashbots RPC for market order transactions on Ethereum mainnet:

```typescript
// For market orders on mainnet, use Flashbots Protect RPC
const FLASHBOTS_RPC = "https://rpc.flashbots.net";

if (chainId === 1 && orderType === "market") {
  const flashbotsProvider = new ethers.JsonRpcProvider(FLASHBOTS_RPC);
  // Send tx through private mempool
}
```

#### How to enable (user/MetaMask)

Users can also add Flashbots Protect manually:

1. MetaMask → Settings → Networks → Add Network
2. RPC URL: `https://rpc.flashbots.net`
3. Chain ID: 1 (Ethereum)
4. All transactions from this network go through private mempool

#### Limitations

- **Ethereum mainnet only** (not available on testnets or L2s)
- Transaction must be mined within 25 blocks (~5 minutes), otherwise dropped
- Revert protection: failed transactions are not included (no wasted gas)

### Layer 3: Future improvements

- **MEV-Share**: users earn a portion of MEV extracted from their transactions
- **Account abstraction**: batch multiple operations into a single transaction
- **L2 deployment**: most L2s have sequencer-based ordering (no public mempool)

## Configuration

| Parameter | Default | Location |
|-----------|---------|----------|
| Deadline | 30 minutes | `page.tsx` → `deadline: Date.now()/1000 + 1800` |
| Slippage | 0.5% (50 bps) | UI slippage selector |
| Flashbots | Auto on mainnet | `dex-aggregator.ts` |
