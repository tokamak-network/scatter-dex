# QA — Pay: WETH stealth → claim → native-ETH transfer-out

End-to-end verification that a WETH-routed Pay payout correctly
auto-unwraps to native ETH on claim and that the recipient's
`TransferOutModal` sends native ETH (via `wallet.sendTransaction`)
rather than `WETH.transfer` when forwarding the funds out.

The contract-level unwrap is already covered by forge tests; this
checklist exists to verify the **UI wiring** end-to-end and to catch
config-side regressions (e.g. a missing `NEXT_PUBLIC_PAY_WETH` that
silently routes a WETH stealth balance through the ERC20 path).

## What this verifies

The post-PR-#602 path:

```
operator (Pay)                 contract                      recipient (Pay /stealth/inbox)
─ deposit ETH→WETH wrap                                       ─ open claim link
─ settle to WETH stealth ──→ ─ claimWithProof:                 ─ TransferOutModal
                                 IWETH.withdraw(amount)            isNative=true
                                 sendValue(stealth, amount) ──→    sendTransaction({to,value})
```

The two UI invariants:
1. **`isWrappedNative(token, cfg)`** at `apps/pay/app/stealth/inbox/page.tsx:32` must return `true` when the claim package's `token` field equals `cfg.contracts.weth`.
2. **`TransferOutModal.send`** at the same file (~line 970) must take the `wallet.sendTransaction({ to, value })` branch — **not** the `ERC20.transfer` fallback.

## Prerequisites

- `bash circuits/scripts/build.sh` ran successfully (every tier's
  zkey + verifier present locally).
- `forge build` clean in `contracts/`.
- Two browser profiles (one for the operator, one for the
  recipient), each holding an anvil account funded with at least
  ~1 ETH.

## Setup

Bring up the local stack from a clean state. `dev.sh` defaults to
the legacy `frontend/` on port 3000; this checklist needs the **Pay**
app on port 4001, so pass `--apps pay`:

```bash
# Start anvil + deploy + zk-relayer + Pay dev server. Use --mock when
# you don't have the production zk-X509 stack handy (the standard
# case for QA reruns).
bash scripts/dev.sh --mock --apps pay
```

The deploy summary in `dev.sh`'s stdout uses `Label: 0xAddress` lines
(see `scripts/dev.sh:440-443`). Confirm WETH was deployed by looking
for the `WETH:` line in the summary block:

```
  RelayerRegistry:     0x…
  WETH:                0x…
  USDC:                0x…
  …
```

Then look at `apps/pay/.env.local` (also written by `dev.sh`). It
carries **two** env vars pointing at the same WETH contract:
`NEXT_PUBLIC_WETH_ADDRESS` (`dev.sh:600`) and `NEXT_PUBLIC_PAY_WETH`
(`dev.sh:620`). The inbox's `isWrappedNative` check at
`apps/pay/app/stealth/inbox/page.tsx:32` reads the second one
through `cfg.contracts.weth`; if it's zero or missing, the modal
silently falls into the ERC20 path and `WETH.transfer(to, amount)`
reverts with `ERC20InsufficientBalance` because the stealth address
actually holds native ETH, not WETH.

**Verify `NEXT_PUBLIC_PAY_WETH` in `apps/pay/.env.local` is the same
non-zero address as the deploy summary's `WETH:` line before
proceeding.**

## Scenario

### Step 1 — Operator: deposit + settle to WETH stealth

In the operator browser profile:

1. Connect the operator wallet to Pay (`http://localhost:4001`).
2. `Dashboard → New payout`.
3. **Token**: `WETH`. **Recipients**: one row with the recipient
   wallet's plain (non-stealth) address and an amount that fits in
   the operator's WETH balance (e.g. `0.1`).
4. **Claim time**: leave default (3 minutes from now).
5. Walk through the wizard until the Funds step. Confirm the
   selected source note is a **WETH** note (not USDC etc.).
6. Sign + submit. Wait for the relayer to broadcast.

**Expected**:
- Toast / status reaches "Settled".
- The dashboard `Run` row shows the run with token `WETH` and a
  `txHash` link.

### Step 2 — Recipient: open claim link, watch the unwrap

The dashboard surfaces a per-recipient claim link. Open it in the
recipient browser profile.

1. Connect the recipient wallet.
2. The claim page reveals the stealth address derived from the
   recipient's meta-address + the operator's ephemeral pub.
3. Click **Claim**. The contract path:
   - `claimWithProof(...)` verifies the claim proof.
   - Branch at `PrivateSettlement.sol:1018-1024` runs
     `IWETH.withdraw(amount)` and `sendValue(stealthAddr, amount)`.
4. After confirmation, the recipient is redirected (or can navigate)
   to `/stealth/inbox`.

**Verify on-chain (CLI)**:

```bash
# Replace <stealth> with the address rendered on the claim page, and
# <weth> with the WETH address from the deploy summary (or
# `NEXT_PUBLIC_PAY_WETH` in apps/pay/.env.local). dev.sh doesn't
# export these into the caller's shell, so they're literal arguments
# here.
cast balance <stealth> --rpc-url http://localhost:8545

# Expect: ≥ the amount you settled (no fee on the recipient side
# for self-pay) — minus any gas spent claiming. The balance is in
# wei, NOT WETH-token units, because the contract already unwrapped.
cast call <weth> "balanceOf(address)(uint256)" <stealth> \
  --rpc-url http://localhost:8545
# Expect: 0  (the WETH was withdrawn during the claim)
```

If `balanceOf` returns non-zero or the native balance is zero, the
unwrap path didn't trigger — most likely `weth` on the contract
disagrees with the deployed WETH address. Check
`PrivateSettlement.weth()`.

### Step 3 — Recipient: open `TransferOutModal`, transfer out

In the recipient browser, navigate to `/stealth/inbox`. The new claim
should appear as a row.

1. Click the row's **Transfer** action. The modal opens.
2. Header confirms **From (stealth)** = the stealth address from
   step 2. **Token** label still says `WETH` (the package was
   originally WETH-tagged); the modal's internal logic, however,
   has resolved `isNative=true` because the contract auto-unwrapped.
3. Enter a **Recipient address** — any other anvil account works
   for the smoke test; the recipient's regular EOA is the natural
   choice.
4. Click **Send max**. The amount auto-fills to balance minus a
   gas buffer (`gasPrice * 21000 * 1.2`). This indicates the
   native-path branch took effect — the ERC20 path would `balanceOf`
   the WETH contract (which is 0 from step 2) and pre-fill `0`.
5. Click **Send**. Confirm in wallet.

**Expected**:
- Modal shows `✓ Sent · <txHash>`.
- Recipient EOA's native ETH balance grew by the sent amount (minus
  miner fees, irrelevant here on anvil).

**Verify on-chain (CLI)**:

```bash
# Inspect the broadcast tx.
cast tx <txHash> --rpc-url http://localhost:8545

# Expect:
#   value: 0x<amount>   (non-zero — this is the native send-value
#                        path; the ERC20 path would have value=0
#                        and a non-empty `input` calldata calling
#                        `transfer(address,uint256)`)
#   to:    <recipient EOA>
#   input: 0x   (empty calldata — pure ETH transfer)
```

If `input` is non-empty (`0xa9059cbb…` is `transfer(address,uint256)`'s selector), the modal silently fell into the ERC20 branch — most likely a `cfg.contracts.weth` mismatch. File a regression issue with the `NEXT_PUBLIC_PAY_WETH` value and the package's `token` address from the inbox row.

### Step 4 — Sanity: ERC20 token path still works

Repeat steps 1–3 with **USDC** in step 1 (or any non-WETH whitelist
token). The expected flow inverts:

- Stealth address holds USDC ERC20 balance, **not** native ETH.
- `gasEmpty` warning appears unless the stealth address has been
  pre-funded with native gas (operator can send a small amount of
  ETH directly, or wait for a relayer-funded path if any).
- `TransferOutModal.send` takes the `ERC20.transfer` branch.
- `cast tx` on the broadcast hash shows `to=<USDC>`, non-zero
  `input` calldata starting with `0xa9059cbb`, `value=0x0`.

This confirms the WETH path is correctly **opt-in** — non-WETH
tokens still use the ERC20 send.

## Edge cases worth covering once

- **Operator deposits from native ETH**: confirm `realDeposit.ts`
  wraps via `WETH.deposit({value: amount})` before the
  commitment-pool deposit. Two paths exist depending on wallet
  capability — atomic-batch (5792) at `realDeposit.ts:259`
  (`encodeFunctionData("deposit")` inside the batch) or sequential
  fallback at `realDeposit.ts:340` (`weth.deposit({value: …})`).
  Either way the wrap must happen before the deposit, otherwise
  the source note's token is the user's wallet ETH (not WETH) and
  the settle's `claim.token === buyToken` constraint fails.
- **Multiple recipients in one run**: settle to two recipients
  with WETH; verify both stealth addresses receive native ETH and
  both rows of the inbox show the native-path modal.
- **Tier 64 / 128 path**: settle to 17+ recipients with WETH;
  every per-recipient claim still routes through the
  `PrivateSettlement.claimWithProof` WETH branch (the contract
  doesn't differ by tier on the unwrap side). This is the
  multi-tier × WETH cross-product check.

## Known limitations

- The modal still labels the token as `WETH` even after the
  unwrap — the recipient sees `WETH` in the modal header but
  receives native ETH out. This is technically correct (the
  package was WETH-tagged) but is mildly confusing UX. Tracked as
  a follow-up; not a regression.
- The `gasEmpty` warning copy ("send a small amount of ETH first")
  is meant for the ERC20 path; on the WETH/native path, an empty
  balance means the recipient already transferred everything out
  — which the warning doesn't acknowledge. Edge-case copy
  improvement; not a blocker.

## Re-running this checklist

This document is the source of truth — run through the steps
verbatim after any change to:

- `apps/pay/app/stealth/inbox/page.tsx` (TransferOutModal,
  `isWrappedNative`)
- `apps/pay/app/_lib/realDeposit.ts` (WETH wrap on deposit)
- `apps/pay/app/_lib/network.ts` (`cfg.contracts.weth` plumbing)
- `contracts/src/zk/PrivateSettlement.sol` `claimWithProof` (the
  unwrap branch)
- `scripts/dev.sh` (env-var emission, especially
  `NEXT_PUBLIC_PAY_WETH`)
