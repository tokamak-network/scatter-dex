# Circuit Bit-Width Audit: 126-bit Amount Safety Under Chained Multiplication

> **Status**: Audit report, 2026-04-10
> **Scope**: Re-audit of every multiplication and wide comparison in `circuits/settle.circom` and `circuits/authorize.circom` against the BN254 scalar field modulus, with particular attention to the fee-inclusion scenario raised in the 2026-04-09 patent-spec review.
> **Conclusion**: The current 126-bit range check on the four trade amounts (`makerSellAmount`, `makerBuyAmount`, `takerSellAmount`, `takerBuyAmount`) is **safe but maximally tight**. There is no room to widen any of the four amounts by even a single bit, and no room to chain the price product with any further multiplication. Fees are on a disjoint multiplication path and do not chain with the price product, so the fee-inclusion concern raised in the review does **not** manifest in the current circuit. A defensive comment + a protective guideline are recommended; the circuit itself needs no logic change.
> **Related**:
> - [../PAPER.md](../PAPER.md) §11 Circuit Complexity
> - `circuits/settle.circom` (PR #124, PR #125, PR #127)
> - `circuits/authorize.circom` (PR #127, PR #129)
> - PR #124 commit `32e1e1f fix(circuits): harden settle.circom (M1 range checks, …)` — the origin of the 126-bit range check

---

## 1. Field-modulus arithmetic, stated precisely

All zkScatter circuits target BN254's scalar field. The modulus is

```
r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
  ≈ 2^253.86006172283..
```

Two load-bearing facts follow:

1. **Values above `r` wrap silently.** The witness is allowed to be any element of `Z/rZ`. If intermediate arithmetic naturally produces a value `v ≥ r`, the circuit sees `v mod r` instead. Range checks (`Num2Bits(n)`) are the only defense — once a value has wrapped, no downstream comparison can recover the truth.
2. **`Num2Bits(253)` is the widest representation that always fits.** `Num2Bits(254)` is rejected by circomlib because `2^254 > r` — there exist 254-bit values that are not valid `Z/rZ` representatives without ambiguity. The largest safe representation is therefore 253 bits, covering `[0, 2^253)` ⊂ `[0, r)`.

The 253-bit limit is what ultimately bounds every chained multiplication in the settle circuit.

## 2. Inventory of multiplications and wide checks in `settle.circom`

Line numbers below reference `circuits/settle.circom` at HEAD as of 2026-04-10.

| # | Site | Expression | Operand widths | Product width | Next use |
|---|---|---|---|---|---|
| M1 | `settle.circom:359` | `makerProduct <== makerSellAmount * takerSellAmount` | 126 × 126 | **252 bits** | `LessEqThan(252)` at `:365` (price check) |
| M2 | `settle.circom:361` | `takerProduct <== makerBuyAmount * takerBuyAmount` | 126 × 126 | **252 bits** | `LessEqThan(252)` at `:365` (price check) |
| M3 | `settle.circom:411` | `takerFeeProduct <== takerSellAmount * takerFee` | 126 × 16 | 142 bits | `LessEqThan(252)` at `:415, :420` (floor-div bounds) |
| M4 | `settle.circom:413` | `feeTokenMakerScaled <== feeTokenMaker * 10000` | 128 × ~13.3 (10000 < 2^14) | ≤ 142 bits | `LessEqThan(252)` at `:415, :420` |
| M5 | `settle.circom:426` | `makerFeeProduct <== makerSellAmount * makerFee` | 126 × 16 | 142 bits | `LessEqThan(252)` at `:430, :435` |
| M6 | `settle.circom:428` | `feeTokenTakerScaled <== feeTokenTaker * 10000` | 128 × ~13.3 | ≤ 142 bits | `LessEqThan(252)` at `:430, :435` |
| A1 | `settle.circom:476` | `makerClaimPlusFee <== totalLockedMaker + feeTokenMaker` | 128 + 128 | ≤ 129 bits | `LessEqThan(252)` at `:477` |
| A2 | `settle.circom:483` | `takerClaimPlusFee <== totalLockedTaker + feeTokenTaker` | 128 + 128 | ≤ 129 bits | `LessEqThan(252)` at `:484` |
| S1 | claims accumulator (maker) | Σ of ≤ 16 × 128-bit claim amounts | — | ≤ 132 bits | equality with `totalLockedMaker` |
| S2 | claims accumulator (taker) | Σ of ≤ 16 × 128-bit claim amounts | — | ≤ 132 bits | equality with `totalLockedTaker` |

Relayer-binding squares (`makerRelayerSq`, `takerRelayerSq` at `:758, :760`) operate on 160-bit Ethereum addresses squared to *up to* 320 bits as integers — that is **above** the 253-bit safe range for unique representation in the BN254 scalar field. They are nevertheless safe in this circuit because the squared value is only constrained as a field element and is **never range-checked, ordered, or compared as a wide integer**. The square's only role is to keep `relayer` in the witness so the circom optimiser cannot prune it (the same idiom as the M6 binding in `withdraw`/`claim`/`settle`). Wrapping `mod r` here is harmless precisely because nothing downstream relies on the integer value of `relayerSq`. This is the only place in either circuit where a multiplication exceeds 253 bits, and the no-comparison condition is what makes it safe.

All other multiplications in the file (`pathIndices[i] * (1 - pathIndices[i])`, `(1 - isUsed[i].out) * leaves[i]`, the commitment-root hash tree, the `expectedNew` guards) involve binary or bit signals and are inherently narrow.

## 3. The critical site — `LessEqThan(252)` internal representation

This is the one place in the circuit where 0.86 bits of field headroom matter. Circomlib's `LessEqThan(252)` is

```circom
template LessEqThan(n) {        // n = 252 in our call sites
    assert(n <= 252);
    signal input in[2];
    signal output out;
    component lt = LessThan(n);
    lt.in[0] <== in[0];
    lt.in[1] <== in[1] + 1;
    lt.out ==> out;
}

template LessThan(n) {
    assert(n <= 252);
    signal input in[2];
    signal output out;
    component n2b = Num2Bits(n + 1);                 // Num2Bits(253) for our case
    n2b.in <== in[0] + (1 << n) - in[1];
    out <== 1 - n2b.out[n];
}
```

For `LessEqThan(252).in = (takerProduct, makerProduct)`, the internal `Num2Bits(253)` input is

```
n2b.in = takerProduct + 2^252 - (makerProduct + 1)
       = takerProduct - makerProduct + 2^252 - 1
```

With `takerProduct, makerProduct ∈ [0, 2^252)`, the worst-case is `takerProduct = 2^252 − 1`, `makerProduct = 0`:

```
n2b.in_max = (2^252 − 1) − 0 + 2^252 − 1
           = 2·2^252 − 2
           = 2^253 − 2
```

And the minimum (for the opposite adversarial choice) is

```
n2b.in_min = 0 − (2^252 − 1) + 2^252 − 1 = 0
```

So the internal representation must represent values in `[0, 2^253 − 2]`, which fits in 253 bits, which fits in the field because `2^253 − 2 < r ≈ 2^253.86`. **The safety margin to the field modulus is approximately `log2(r / 2^253) ≈ 0.86 bits`** — enough to be correct, but almost zero as a defensive buffer.

### 3.1 What this means for "widening any operand by even 1 bit"

Suppose the four trade amounts were range-checked to 127 bits instead of 126:

```
makerProduct_max = takerProduct_max = (2^127 − 1)^2 ≈ 2^254 − 2^128
n2b.in_max       = 2·(2^254 − 2^128) − 2 ≈ 2^255 − 2^129
```

This exceeds both `2^253` (fails `Num2Bits(253)` decomposition uniqueness) **and** `r ≈ 2^253.86` (wraps around `Z/rZ`). The `LessEqThan(252)` would silently produce the wrong answer for adversarially-chosen inputs near the maximum. **The 126-bit limit is therefore not a soft guideline — it is a hard correctness boundary.**

### 3.2 What this means for chaining the price product with a further multiplication

Suppose a future refactor wanted to compute `makerProduct * feeBps` to apply a relative haircut:

```
126-bit × 126-bit × 16-bit = 268 bits >> 253
```

This overflows immediately. No chained multiplication that includes `makerProduct` or `takerProduct` as a factor is safe without first dividing out at least 15 bits of magnitude.

### 3.3 What the review's "fee inclusion" concern actually refers to

The 2026-04-09 review raised:

> *fee 계산 등에서 추가 곱셈이 있으면 오버플로우 가능성이 있습니다.*
> ("If there are additional multiplications in fee calculations, there is a possibility of overflow.")

Inspecting M3, M4, M5, M6 in §2 above, the fee computation is **on a disjoint multiplication path** from the price product:

- Fees multiply `sellAmount × feeBps` with operand widths 126 × 16, yielding ≤142 bits
- The result is bounds-checked against `feeTokenScaled = feeToken × 10000` (≤142 bits) via `LessEqThan(252)`
- Neither fee product nor `feeTokenScaled` is ever multiplied by `makerProduct` or `takerProduct`
- Both end in a `LessEqThan(252)` comparison where the internal 253-bit representation carries only small values (≤143 bits), leaving ~110 bits of slack to the critical threshold

**Conclusion**: the fee path is **comfortably safe** in the current circuit. The "additional multiplications" concern would only materialise if a future change:

(a) widens any of the four trade amounts past 126 bits, or
(b) multiplies a price product (`makerProduct`/`takerProduct`) by any additional factor, or
(c) adds the price product to a value that could itself approach 2^252.

None of (a)-(c) are present in the current circuit, in `authorize.circom`, or in the `circuit-split/design.md` half-proof sketch.

## 4. `authorize.circom` cross-check

`authorize.circom` does not contain any cross-party price check — that check lives in the future `settleAuth` Solidity glue contract (see `docs/circuit-split/design.md:798-801`). The only multiplications inside `authorize.circom` are:

| Site | Expression | Widths | Product |
|---|---|---|---|
| `authorize.circom:225-234` | Range checks `Num2Bits(126/128/16)` on `sellAmount`, `buyAmount`, `balance`, `totalLocked`, `maxFee`, claim amounts | — | — |
| `authorize.circom:299-302` | `LessEqThan(128)` balance sufficiency | — | ≤ 128 bits |
| `authorize.circom:397-400` | `LessEqThan(128)` receive guarantee | — | ≤ 128 bits |
| `authorize.circom:438` | `relayerSq <== relayer * relayer` | 160 × 160 | 320 bits (safe — only used as a constraint) |

`authorize.circom` replaces the `LessEqThan(252)` comparisons of `settle.circom` with `LessEqThan(128)` because, after `Num2Bits(126/128)` range checks upstream, every comparison fits trivially in 128 bits. This is the PR #127 "LessEqThan(128) is sufficient" optimisation and it leaves enormous slack. `authorize.circom` has **no tight spot** — its bit-width safety budget is roughly two orders of magnitude more relaxed than `settle.circom`'s.

## 5. `settleAuth` Solidity glue cross-check

The future `settleAuth` contract sketched in `docs/circuit-split/design.md:798-801` does a Solidity-side price check:

```solidity
uint256 makerProduct = uint256(m.makerSellAmount) * uint256(t.takerSellAmount);
uint256 takerProduct = uint256(m.makerBuyAmount)  * uint256(t.takerBuyAmount);
if (takerProduct > makerProduct) revert PriceMismatch();
```

The struct types are `uint128`. Let us verify this:

- If the circuit accepted values up to `2^126 − 1` (which it does), the max product is `(2^126 − 1)² < 2^252`, well within `uint256` (slack ≈ 4 bits). ✓
- If a misbehaving caller were to pass raw `uint128` values exceeding `2^126`, the Solidity multiplication is up to `(2^128 − 1)² < 2^256`, still within `uint256` by a few bits — no Solidity overflow. Such a call would then fail circuit verification downstream, so the inflated product is irrelevant. ✓

**There is a latent documentation drift worth noting**: the Solidity struct admits up to 128 bits, but the circuit rejects anything above 126 bits. This is harmless (circuit rejection is the real gate) but it should be mentioned in the `MakerProof` / `TakerProof` struct comment so that a future reader does not conclude the full 128 bits is usable.

## 6. Recommendations

Prioritised from highest value to lowest.

### R1 — Strengthen the M1 comment in `settle.circom` (non-invasive, comment-only)

The existing M1 comment at `circuits/settle.circom:314-326` says:

> *"Reducing to 126 bits caps each product at 2^252 < r, well inside the field"*

This understates how tight the margin actually is. The phrase "well inside the field" is wrong: the `LessEqThan(252)` internal computation can reach `2^253 − 2`, which is inside the field by only `log2(r / 2^253) ≈ 0.86 bits`. A corrected version should:

- State the BN254 modulus and cite its bit-length (`r ≈ 2^253.86`)
- Note that `LessEqThan(252)` internally computes a 253-bit value (not a 252-bit value)
- State the effective headroom (`≈ 0.86 bits to modulus`, `exactly 0 bits to the next Num2Bits width`)
- Explicitly warn: "Do not widen any of the four trade-amount range checks. Do not chain `makerProduct`/`takerProduct` into any further multiplication. Any such change requires re-running the bit-width audit at `docs/circuit-split/bit-width-audit.md`."

This is a comment-only change and produces an **identical R1CS** — no trusted-setup re-run is required. Suggested wording is in §7 below.

### R2 — Annotate the `uint128` struct fields in the `settleAuth` sketch

In `docs/circuit-split/design.md` around `:730`, annotate the `uint128 makerSellAmount` / `uint128 makerBuyAmount` / `uint128 takerSellAmount` / `uint128 takerBuyAmount` fields with:

> `// Circuit enforces ≤ 2^126 − 1 via Num2Bits(126). Values in [2^126, 2^128) will fail proof verification. See docs/circuit-split/bit-width-audit.md §5.`

This closes the documentation drift without changing the struct layout. When the `settleAuth` contract is actually written, this comment prevents a future implementer from "helpfully" widening the types.

### R3 — Do not introduce a `COMMIT_AMOUNT_BITS` parameter

A parameterised range check (`Num2Bits(COMMIT_AMOUNT_BITS)`) would invite a future contributor to change the parameter without understanding the chain of reasoning in §3. The hard-coded literal `126` is safer because every occurrence is a conspicuous magic number that forces the reader to ask *why 126*, at which point the M1 comment (strengthened per R1) answers them.

### R4 — Ship this audit document alongside the circuit changes

`docs/circuit-split/bit-width-audit.md` (this file) is the durable record of the analysis. When the half-proof circuits ship, the `docs/circuit-split/design.md` file should link to this audit from its constraint-count section so that future reviewers find the audit before they start "optimising" the range checks.

### R5 — No action needed on the fee path

The fee path is comfortably safe (≤142 bits vs ~253-bit budget). The 2026-04-09 review's concern that fee calculations might tip the price-check margin over the edge is **not substantiated by the current circuit**: the fee path and the price path are on disjoint multiplication chains and are joined only by `LessEqThan(252)` comparisons that each consume only ~143 bits of the 253-bit budget.

## 7. Suggested replacement text for the M1 comment in `settle.circom`

Drop-in replacement for `settle.circom:314-326`. This is comment-only and produces an identical R1CS.

```circom
    // [M1, gemini review fix, 2026-04-10 audit] Range-check the four trade
    // amounts to 126 bits.
    //
    // The previous version used Num2Bits(128). 128-bit × 128-bit can reach
    // 2^256, which exceeds the BN254 scalar modulus r ≈ 2^253.86 and would
    // wrap around the field — making the LessEqThan(252) comparison below
    // give the wrong answer for adversarially-chosen amounts.
    //
    // Reducing to 126 bits caps each product at 2^252, which matches the
    // `LessEqThan(252)` internal representation exactly. Note that the
    // LessEqThan(252) template internally computes
    //     n2b.in = in[0] + 2^252 - in[1]
    // and calls Num2Bits(253) on it. With our products ∈ [0, 2^252), the
    // worst-case internal value is 2·2^252 - 2 = 2^253 - 2, which fits in
    // 253 bits and is inside the field modulus by log2(r/2^253) ≈ 0.86
    // bits. This is the tightest place in the circuit.
    //
    // CONSEQUENCES — do not undo this without re-running the bit-width
    // audit at docs/circuit-split/bit-width-audit.md:
    //  1. Do not widen any of the four trade-amount range checks past
    //     126 bits. Even 127 bits would break LessEqThan(252) silently.
    //  2. Do not multiply makerProduct or takerProduct by any further
    //     factor (e.g., a relative haircut or a second-order fee term).
    //     That would push the chain past 253 bits.
    //  3. Do not add makerProduct to any value that could approach 2^252.
    //     Addition alone is fine (254 bits max, still inside the field),
    //     but any subsequent LessEqThan(252) on the sum would fail.
    //  4. Fees are on a disjoint multiplication path
    //     (sellAmount × feeBps ≤ 142 bits) and are comfortably safe.
    //     Do not merge the fee computation with the price computation.
    //
    // Range-check costs for widening the four amounts back to 128 bits
    // would be negligible (~8 constraints), but the correctness cost is
    // infinite: there is no way to fit 128×128 = 256 bits into the field.
    //
    // Other 128-bit checks below (balances, totalLocked, fees) are kept
    // at 128 bits because they only get multiplied by 16-bit fee bps,
    // where 128 + 16 = 144 bits is comfortably inside the field.
```

This replacement strengthens the existing comment without changing any R1CS constraint. The trusted setup for `settle.circom` is unaffected.

## 8. Summary table

| Aspect | Current state | Safe? | Margin |
|---|---|---|---|
| `makerProduct`, `takerProduct` (126×126 = 252 bits) | Fits in field, used only in `LessEqThan(252)` | ✅ | **~0.86 bits to modulus, 0 bits to next `Num2Bits` width** |
| Fee products (126×16 = 142 bits) | Separate multiplication chain, never merged with price | ✅ | ~111 bits of slack |
| `feeToken × 10000` (≤142 bits) | Bounds checked via `LessEqThan(252)` | ✅ | ~111 bits of slack |
| `totalLocked + feeToken` (≤129 bits) | Bounded by `sellAmount` (≤126 bits) in the cap check | ✅ | ~124 bits of slack |
| Claim accumulator (≤132 bits) | 16 × 128-bit bounded sum | ✅ | ~121 bits of slack |
| Widening any of the four amounts | Would break immediately | ❌ | N/A — hard boundary |
| Chaining a third factor into the price product | Would break immediately | ❌ | N/A — hard boundary |
| Fee/price path merger | Not present; would be unsafe if introduced | — | depends on widths |

**Overall verdict**: the circuit is currently correct, and the 2026-04-09 review concern does not manifest in today's multiplication chain. The 126-bit boundary is load-bearing and must be preserved with an explicit comment (R1) and a documentation cross-reference (R2). No logic change is needed.
