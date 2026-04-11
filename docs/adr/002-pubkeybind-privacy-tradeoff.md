# ADR-002: pubKeyBind Privacy Tradeoff

> Status: Accepted
> Date: 2026-04-11

## Context

`authorize.circom` outputs `pubKeyBind = Poseidon(pubKeyAx, pubKeyAy, nullifier)` as a public signal. This value is visible on-chain in the `settleAuth` and `settleWithDex` events.

## Privacy Analysis

### What pubKeyBind reveals

| Scenario | Who can link | How |
|----------|-------------|-----|
| **External observer** (no pubKey) | ❌ Cannot link trades | pubKeyBind changes per trade (different nullifier each time) |
| **Relayer** (knows pubKey) | ✅ Can link trades | Recompute `Poseidon(Ax, Ay, nullifier)` and match against on-chain pubKeyBind |
| **Law enforcement** (subpoena relayer) | ✅ Can trace user | Relayer discloses pubKey → trace all pubKeyBind on-chain |

### Key properties

1. **Per-trade unique**: pubKeyBind changes with each trade (nullifier is unique per commitment). No two trades have the same pubKeyBind.

2. **Relayer-linkable**: A relayer who knows the user's BabyJub pubKey can link all trades by that user. This is **intentional** for compliance.

3. **Cross-relayer unlinkable**: Different relayers see different pubKeys (if user uses separate keys per relayer). But if user reuses the same EdDSA key across relayers, all relayers can collude to link.

4. **On-chain unlinkable** (without pubKey): Without the BabyJub public key, an on-chain observer sees random-looking Poseidon hashes. No linkability.

## Decision

**Accept the tradeoff.** pubKeyBind is a deliberate design choice for the Dual-CA compliance model:

- **Privacy from public**: Protected. On-chain observers cannot link trades.
- **Transparency to relayer**: Intentional. Relayers serve as the compliance checkpoint.
- **Law enforcement access**: Via relayer subpoena only. Protocol itself cannot de-anonymize users.

### Why not remove pubKeyBind?

Without pubKeyBind, a user could provide a fake pubKey to the relayer. The relayer would log the fake key, making the compliance log useless. pubKeyBind cryptographically proves the pubKey matches the commitment's owner.

### Why not add blinding?

`pubKeyBind = Poseidon(pubKeyAx, pubKeyAy, nullifier, random_blinding)` would prevent relayer linkability. But this defeats the compliance purpose — the relayer needs to verify `pubKeyBind` to confirm the user's identity.

## Mitigation recommendations

1. **Users should use separate EdDSA keys per relayer** to prevent cross-relayer linkability.
2. **The frontend should warn users** that their relayer can link their trades.
3. **Relayer privacy policy** should document what data is logged and retention period.

## References

- `circuits/authorize.circom` lines 485-501
- `docs/PAPER.md` § 8 (Compliance Model)
- `docs/adr/001-no-self-trade-detection.md` (related privacy decision)
