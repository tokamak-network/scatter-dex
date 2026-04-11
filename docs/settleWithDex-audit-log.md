# settleWithDex Audit Log

> Last updated: 2026-04-11

All issues discovered during implementation, code review (Copilot + Gemini), automated simplify reviews (3-agent parallel), and E2E testing of the `settleWithDex` market order feature. **25 issues total** (3 CRITICAL, 4 HIGH, 10 MEDIUM, 8 LOW).

## Timeline

| PR/Commit | Description |
|-----------|-------------|
| [PR #151](https://github.com/tokamak-network/scatter-dex/pull/151) | Initial implementation: settleWithDex + BatchVerifier 15-signal + market order UI |
| [PR #157](https://github.com/tokamak-network/scatter-dex/pull/157) | withdraw.circom range check (external security audit finding) |
| [PR #160](https://github.com/tokamak-network/scatter-dex/pull/160) | Fork integration tests (Uniswap V3 + Curve) + platform fee |
| [PR #162](https://github.com/tokamak-network/scatter-dex/pull/162) | Market order E2E test |
| [PR #165](https://github.com/tokamak-network/scatter-dex/pull/165) | Address sanctions / compliance (SanctionsList) |
| [ab4f847](https://github.com/tokamak-network/scatter-dex/commit/ab4f847) | Critical fixes from market order audit |
| [75db603](https://github.com/tokamak-network/scatter-dex/commit/75db603) | Same-token underflow fix + E2E WETH→USDC |
| [Issue #169](https://github.com/tokamak-network/scatter-dex/issues/169) | Tracking issue for all E2E fixes |

---

## Issues Found and Fixed

### CRITICAL

#### C1: feeVault not set + dexPlatformFeeBps > 0 → revert
- **Found by**: Copilot (PR #160 review)
- **Commit**: [a2b941a](https://github.com/tokamak-network/scatter-dex/commit/a2b941a), [ab4f847](https://github.com/tokamak-network/scatter-dex/commit/ab4f847)
- **Description**: `settleWithDex` calls `feeVault.treasury()` when platform fee > 0. If feeVault is `address(0)`, this reverts with no useful error.
- **Fix**: Added `FeeVaultRequired` error in `setDexPlatformFee` — prevents setting fee without a vault. Removed fallback "fee stays in contract" path.

#### C2: Frontend DEX calldata encoded full sellAmount
- **Found by**: Manual audit (user report)
- **Commit**: [ab4f847](https://github.com/tokamak-network/scatter-dex/commit/ab4f847)
- **Description**: Frontend encoded `amountIn: parsedSell` (full amount) in DEX calldata, but contract approves only `swapAmount = sellAmount - platformFee`. DEX router tries to pull `sellAmount` → allowance insufficient → revert.
- **Fix**: Frontend now reads on-chain `dexPlatformFeeBps()` and computes `swapAmountIn = sellAmount - fee` before encoding calldata.

#### C3: Same-token swap underflow (Panic(17))
- **Found by**: E2E debugging
- **Commit**: [75db603](https://github.com/tokamak-network/scatter-dex/commit/75db603)
- **Description**: When `sellToken == buyToken`, the "unspent sellToken return" logic sent all remaining tokens back to the pool (including the buyToken balance the DEX just returned). Then `amountOut = buyBalanceAfter - buyBalanceBefore` underflowed because buyBalance was drained.
- **Fix**: Added `if (proof.sellToken != proof.buyToken)` guard around unspent sellToken return logic.

### HIGH

#### H1: settleWithDex blocked non-relayer users
- **Found by**: Manual audit (user report)
- **Commit**: [ab4f847](https://github.com/tokamak-network/scatter-dex/commit/ab4f847)
- **Description**: `settleWithDex` had `relayerRegistry.isActiveRelayer(proof.relayer)` check. Market orders are permissionless (user sets `relayer = self`), but non-relayer users fail this check.
- **Fix**: Removed relayer registry check from `settleWithDex`. Added comment explaining intentional omission.

#### H2: settleAuth/settlePrivate missing sanctions check
- **Found by**: Simplify 3-agent review (PR #165)
- **Commit**: [feeec6d](https://github.com/tokamak-network/scatter-dex/commit/feeec6d)
- **Description**: Only `settleWithDex` and `claimWithProof` checked sanctions. A sanctioned relayer could call `settleAuth`/`settlePrivate` unchecked.
- **Fix**: Added `_requireNotSanctioned(msg.sender)` to both `settleAuth` and `settlePrivate`.

#### H3: authorize-proof.mjs hardcoded public inputs to "0"
- **Found by**: Copilot (PR #162 review)
- **Commit**: [7bd8e4e](https://github.com/tokamak-network/scatter-dex/commit/7bd8e4e)
- **Description**: `authorize-proof.mjs` set circuit public inputs (nullifier, nonceNullifier, newCommitment, claimsRoot, totalLocked, orderHash) to `"0"`. These are `signal input` that the circuit constrains against internal computations — `"0"` would cause witness generation to fail.
- **Fix**: Changed to accept all 6 values as required parameters from the caller.

#### H4: orderHash signed with claimsRoot = 0
- **Found by**: Copilot (PR #162 review)
- **Commit**: [7bd8e4e](https://github.com/tokamak-network/scatter-dex/commit/7bd8e4e)
- **Description**: E2E computed `orderHash = Poseidon(..., claimsRoot=0, ...)` as placeholder, but the circuit binds EdDSA signature to the *actual* claimsRoot. Signature would fail verification.
- **Fix**: Compute claimsRoot from padded claims tree BEFORE signing with EdDSA.

### MEDIUM

#### M1: DexSwapFailed conflated two failures
- **Found by**: Simplify 3-agent review (PR #151)
- **Commit**: [3b40e73](https://github.com/tokamak-network/scatter-dex/commit/3b40e73)
- **Description**: Single `DexSwapFailed` error for both "call reverted" and "insufficient output". Off-chain debugging can't distinguish.
- **Fix**: Split into `DexCallReverted` and `DexOutputInsufficient(actual, required)`.

#### M2: Uniswap router address wrong (SwapRouter vs SwapRouter02)
- **Found by**: Copilot (PR #151 review)
- **Commit**: [3b40e73](https://github.com/tokamak-network/scatter-dex/commit/3b40e73)
- **Description**: `0xE592` is SwapRouter (v1), not SwapRouter02 (`0x68b3`).
- **Fix**: Changed to SwapRouter02 + per-chain router map (mainnet + Sepolia).

#### M3: minReceive floating-point rounding
- **Found by**: Copilot + Gemini (PR #151 review)
- **Commit**: [3b40e73](https://github.com/tokamak-network/scatter-dex/commit/3b40e73)
- **Description**: `toFixed()` can round up, producing a minReceive higher than intended → spurious DEX reverts.
- **Fix**: BigInt integer arithmetic (`parseUnits` → integer multiply/divide → `formatUnits`) guarantees floor rounding.

#### M4: Fee-tier string parsing fragile
- **Found by**: Copilot (PR #151 review)
- **Commit**: [3b40e73](https://github.com/tokamak-network/scatter-dex/commit/3b40e73)
- **Description**: Derived fee tier from display label strings ("0.3%"). Non-Uniswap sources (Curve "~0.04%") produce invalid tiers.
- **Fix**: `VALID_FEE_TIERS` whitelist (100/500/3000/10000), fallback to 3000.

#### M5: Surplus to owner() instead of treasury
- **Found by**: Copilot (PR #151 review)
- **Commit**: [3b40e73](https://github.com/tokamak-network/scatter-dex/commit/3b40e73)
- **Description**: `feeVault.deposit(owner(), ...)` credited surplus to owner as relayer balance, subject to platform fee on claim.
- **Fix**: Direct `safeTransfer` to `feeVault.treasury()`.

#### M6: No ISanctionsList interface
- **Found by**: Simplify 3-agent review (PR #165)
- **Commit**: [feeec6d](https://github.com/tokamak-network/scatter-dex/commit/feeec6d)
- **Description**: CommitmentPool and PrivateSettlement imported concrete `SanctionsList`, preventing swap with Chainalysis oracle.
- **Fix**: Extracted `ISanctionsList` interface. Both contracts now depend on the interface.

#### M7: setSanctionsList no contract code check
- **Found by**: Copilot (PR #165 review)
- **Commit**: [206dc51](https://github.com/tokamak-network/scatter-dex/commit/206dc51)
- **Description**: Setting an EOA as sanctions oracle would cause `isSanctioned()` to revert on empty returndata.
- **Fix**: Added `code.length` check in both CommitmentPool and PrivateSettlement setters.

#### M8: BatchSanctioned event included skipped addresses
- **Found by**: Copilot (PR #165 review), Simplify review
- **Commit**: [feeec6d](https://github.com/tokamak-network/scatter-dex/commit/feeec6d)
- **Description**: `BatchSanctioned(address[])` emitted the full input array including zero addresses and duplicates.
- **Fix**: Removed batch event, emit individual `AddressSanctioned` per address actually written.

#### M9: No removeSanctionsBatch
- **Found by**: Simplify 3-agent review
- **Commit**: [feeec6d](https://github.com/tokamak-network/scatter-dex/commit/feeec6d)
- **Description**: OFAC delists happen in batches too.
- **Fix**: Added `removeSanctionsBatch(address[])` with `MAX_BATCH_SIZE = 200`.

#### M10: Relayer authorize-order.ts duplicate variable
- **Found by**: E2E startup failure
- **Commit**: [ab4f847](https://github.com/tokamak-network/scatter-dex/commit/ab4f847)
- **Description**: `const expiry` declared twice (line 209 + 224) in `authorize-order.ts`. TypeScript/esbuild rejected it.
- **Fix**: Renamed bit-width check variables to `*Big` suffix.

### LOW

#### L1: useMainnetPrice unconditional in limit mode
- **Found by**: Simplify 3-agent review (PR #151)
- **Commit**: [4feff6f](https://github.com/tokamak-network/scatter-dex/commit/4feff6f)
- **Fix**: Pass `undefined` symbols when `orderType !== "market"` → hook no-ops.

#### L2: Duplicate useMemos for marketPrice/marketPriceSource
- **Found by**: Simplify review
- **Commit**: [4feff6f](https://github.com/tokamak-network/scatter-dex/commit/4feff6f)
- **Fix**: Single `useMemo` returning `{ marketPrice, marketPriceSource }`.

#### L3: marketSubmitting redundant state
- **Found by**: Simplify review
- **Commit**: [4feff6f](https://github.com/tokamak-network/scatter-dex/commit/4feff6f)
- **Fix**: Removed, use `step === "signing"` instead.

#### L4: handleSubmit/handleMarketSubmit ~120 lines duplicated
- **Found by**: Simplify 3-agent review
- **Commit**: [4feff6f](https://github.com/tokamak-network/scatter-dex/commit/4feff6f)
- **Fix**: Extracted `buildOrderProof()` helper.

#### L5: E2E test helpers duplicated across files
- **Found by**: Simplify review (PR #162)
- **Commit**: [c6f51ff](https://github.com/tokamak-network/scatter-dex/commit/c6f51ff)
- **Fix**: Extracted to `test/helpers/common.ts`.

#### L6: Fork test totalLocked too tight (flaky)
- **Found by**: Copilot (PR #160 review)
- **Commit**: [3df4c0d](https://github.com/tokamak-network/scatter-dex/commit/3df4c0d)
- **Fix**: Lowered to 1e6 USDC / 1e18 DAI.

#### L7: withdraw.circom LessEqThan(252) redundant
- **Found by**: Simplify 3-agent review (PR #157)
- **Commit**: [411f175](https://github.com/tokamak-network/scatter-dex/commit/411f175)
- **Fix**: Replaced with `Num2Bits(128)` on `amount - withdrawAmount`. Constraints: 6600 → 6348.

#### L8: WithdrawVerifier delta == gamma (no phase-2 contribution)
- **Found by**: Gemini + Copilot (PR #157 review)
- **Commit**: [0b578c9](https://github.com/tokamak-network/scatter-dex/commit/0b578c9)
- **Fix**: Added dev phase-2 contribution to produce independent delta point.

---

## E2E Test Coverage

| Scenario | Test File | Steps | Status |
|----------|-----------|-------|--------|
| Limit order (P2P via relayer) | `e2e-private-flow.ts` | deposit → order → settle → claim → fee vault | ✅ 9/9 |
| Market order (DEX via settleWithDex) | `e2e-market-order.ts` | deposit → authorize proof → settleWithDex → platform fee → claim | ✅ 9/9 |
| Foundry unit tests | `SettleWithDex.t.sol` | 17 tests (mock + platform fee) | ✅ |
| Foundry fork tests | `SettleWithDexFork.t.sol` | 5 tests (Uniswap V3 + Curve) | ✅ |
| Sanctions tests | `SanctionsList.t.sol` | 15 tests (unit + integration) | ✅ |

## Architecture Decisions

### Why settleWithDex skips relayer registry check
Market orders are permissionless: the user submits directly with `relayer = self`. Requiring relayer registration would force users to register as relayers just to trade, defeating the purpose. The relayer registry check remains active for `settleAuth` and `settlePrivate`.

### Why unspent sellToken return has sellToken != buyToken guard
When `sellToken == buyToken`, the balance-delta approach breaks because the sellToken return logic can drain tokens that the buyToken measurement needs. In practice, same-token swaps are unusual (wrapping/unwrapping aside), but the guard prevents Panic(17) if it occurs.

### Why platform fee bypasses FeeVault.deposit
Direct `safeTransfer` to `feeVault.treasury()` avoids:
1. Double platform fee deduction (FeeVault charges its own `platformFeeBps` on claim)
2. Need for the owner to claim from FeeVault

See [docs/fee-architecture.md](./fee-architecture.md) for the full fee model comparison.
