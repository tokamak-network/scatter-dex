# Half-Proof Migration Guide

> **Status**: Draft (2026-04-10)
> **Audience**: Testnet users, relayer operators, frontend integrators
> **Related**:
> - [circuit-split/design.md](circuit-split/design.md) §10 — technical migration strategy
> - [architecture-v2.md](architecture-v2.md) — system architecture
> - [adr/001-no-self-trade-detection.md](adr/001-no-self-trade-detection.md) — privacy model

## 1. What Changed

zkScatter migrated from a **monolithic prove model** (relayer generates the full settlement proof) to a **Half-proof model** (each user proves their own side in the browser). This is a fundamental change to the trust model.

### 1.1 Commitment Format: v1 → v2

| Aspect | v1 (deprecated) | v2 (current) |
|--------|-----------------|--------------|
| Hash | `Poseidon(secret, token, amount, salt)` | `Poseidon(3, secret, token, amount, salt, pubKeyAx, pubKeyAy)` |
| Domain tag | None | `TAG_COMMITMENT_V2 = 3` |
| EdDSA pubkey binding | Not bound | Bound into preimage |
| Attack surface | Swap-the-key attack possible | Closed (PR #129) |

**v1 commitments are permanently invalid.** Any funds deposited under the v1 format on testnet must be re-deposited under v2.

### 1.2 Proof Generation

| Aspect | Before | After |
|--------|--------|-------|
| Who proves | Relayer (server-side) | Each user (browser-side via Web Worker) |
| Circuit | `settle.circom` (monolithic) | `authorize.circom` (per-side) |
| Contract | `settlePrivate()` | `settleAuth()` |
| User secret exposure | Sent to relayer | **Never leaves the browser** |
| Proof time | N/A (server) | ~3-5s desktop, ~15-30s mobile |

### 1.3 EdDSA Key Requirement

The half-proof model requires each user to have a **BabyJub EdDSA key pair**:

- **Derived from MetaMask signature** — user signs a fixed message (`DERIVE_MESSAGE`) with their Ethereum wallet, and the signature is used as entropy to derive the EdDSA private key
- **Deterministic** — same wallet always produces the same EdDSA key
- **Stored encrypted** in browser localStorage, re-derivable on any device by signing the same message

## 2. Testnet Users: What You Need to Do

### 2.1 v1 Commitment Deprecation

If you have funds in a v1 commitment (deposited before the half-proof upgrade):

1. **Withdraw** using the legacy `withdraw` circuit (still supported for v1 commitments)
2. **Re-deposit** — the new deposit flow automatically creates a v2 commitment with your EdDSA pubkey bound

There is no automatic migration. v1 commitments cannot be used for trading under the half-proof model because `authorize.circom` requires the pubkey to be part of the commitment preimage.

### 2.2 New Deposit Flow

When you deposit under the half-proof model:

1. **Connect wallet** (MetaMask or compatible)
2. **Derive EdDSA key** — you'll see a MetaMask signature popup asking you to sign a specific message. This is NOT a transaction — it costs no gas. The signature is used to deterministically derive your EdDSA private key
3. **Deposit** — the contract stores your v2 commitment (which includes your pubkey binding)
4. **Save your note file** — contains your `ownerSecret`, `salt`, `token`, `amount`, `leafIndex`, `pubKeyAx`, `pubKeyAy`

### 2.3 Backup Strategy

Your funds are recoverable from two pieces of information:

| Secret | Where it lives | How to back up |
|--------|---------------|----------------|
| `ownerSecret` | Note file (JSON) | Save the note file securely — this is the master secret for your escrow |
| EdDSA private key | Derived from MetaMask signature | **No separate backup needed** — re-derivable from the same wallet on any device by signing the same message |

**Critical**: if you lose your `ownerSecret`, your funds are permanently locked. The EdDSA key alone cannot recover them. Always keep your note files backed up.

## 3. Relayer Operators: What You Need to Do

### 3.1 Update Relayer Software

The relayer no longer generates settlement proofs. Instead:

1. **Receive `authorize.circom` proofs** from users (via the authorize-order API)
2. **Match orders** based on public signals (token, amount, price, expiry)
3. **Submit `settleAuth()`** to the contract with both proofs

The relayer never sees user secrets. Matching is done entirely on public signals.

### 3.2 Database Migration

The relayer DB schema has been updated:
- `settled_at` column added to `private_orders` (automatic migration on startup)
- `relayer_meta` table added for uptime tracking
- No manual migration needed — the relayer handles schema upgrades automatically

### 3.3 Cross-Relayer Compatibility

Cross-relayer matching works with the half-proof model:
- Trade Offers carry the taker's `authorize.circom` proof
- The receiving relayer verifies the proof and submits `settleAuth()` with both sides

## 4. Frontend Integrators

### 4.1 New Dependencies

- `authorize-prover.ts` — generates `authorize.circom` proofs in the browser
- `authorize-worker.ts` / `authorize-worker-client.ts` — Web Worker for non-blocking proof generation
- `cancel-prover.ts` — generates cancel proofs for escrow rotation

### 4.2 Circuit Artifacts

The following files must be served from `/zk/`:

| File | Size | Purpose |
|------|------|---------|
| `authorize.wasm` | ~2 MB | Witness calculator |
| `authorize_final.zkey` | ~18 MB | Proving key (cached in IndexedDB after first download) |
| `cancel.wasm` | ~1 MB | Cancel witness calculator |
| `cancel_final.zkey` | ~8 MB | Cancel proving key |
| `deposit.wasm` | ~1 MB | Deposit witness calculator |
| `deposit_final.zkey` | ~4 MB | Deposit proving key |

### 4.3 Wallet UX Changes

The deposit flow now includes an additional step:

```
[Connect Wallet] → [Sign Message (EdDSA derivation)] → [Approve Deposit Tx] → [Save Note]
```

The signature popup appears **once per session** (the derived key is cached in encrypted localStorage). Users should be informed that:
- The signature request is for key derivation, not a transaction
- It costs no gas
- They can verify the message content before signing

## 5. Timeline

| Phase | Status | Description |
|-------|--------|-------------|
| A — Parallel deployment | ✅ Done | `settleAuth` deployed alongside legacy `settlePrivate` |
| B — Frontend migration | ✅ Done | Browser proving via Web Worker, authorize-order API |
| C — Legacy deprecation | Pending | `settlePrivate` still available but no longer the default path |

## 6. Known Limitations

- **Mobile proof time**: ~15-30s on mobile devices with snarkjs WASM. rapidsnark-wasm would reduce this to ~3-8s but the npm package is not yet available for browser environments
- **zkey download**: First proof generation requires downloading ~18 MB zkey file. Subsequent proofs use IndexedDB cache
- **No v1→v2 auto-migration**: Users must manually withdraw and re-deposit. This is by design — automatic migration would require the contract to know the v1 preimage, which it doesn't have
