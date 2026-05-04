# ZK Circuit Assets

This directory holds compiled circuit files required at runtime:
- `deposit.wasm` + `deposit_final.zkey` — deposit proof
- `claim.wasm` + `claim_final.zkey` — claim proof
- `authorize.wasm` + `authorize_final.zkey` — authorize proof (market + limit orders)

These files are **not committed to git** (too large, ~5-19MB each).

## Tier policy — mobile is TIER_16 only

The web stack (apps/pay, apps/pro, frontend/) ships authorize / claim
circuits in three tiers (16 / 64 / 128 recipients per settlement) and
auto-routes via `pickActiveTier(recipientCount)`. **Mobile intentionally
ships only the TIER_16 assets** for two reasons:

- **Bundle size.** The TIER_64 zkey is ~50 MB and TIER_128 is ~90 MB —
  bundling both would inflate the APK / IPA by ~140 MB before any
  product code, which is unacceptable for a mobile install footprint.
  Lazy-loading from a CDN at runtime (the trick the web frontends use)
  doesn't translate cleanly to RN's asset pipeline.
- **Prove-time UX.** TIER_128 takes ~6–12 s on a mid-tier laptop;
  mobile-class hardware is meaningfully slower than that and the
  multi-second prove already strains the in-app loading state for
  TIER_16. TIER_64 / TIER_128 would push it past the point of being a
  reasonable foreground operation.

Implications for callers on mobile:
- A run with > 16 recipients must either be split across multiple
  tier-16 settlements (the current Pay multi-batch fallback path) or
  rejected at input time. Mobile UI should not invoke `pickActiveTier`
  blindly — it should treat TIER_16 as the only available tier.
- `mobile/scripts/copy-zk-assets.sh` reflects this in its `CIRCUITS`
  list (tier-16 names only). `scripts/check-zk-artifacts.sh`'s
  `mobile_copies()` predicate also restricts the mobile manifest to
  the tier-16 set.
- If a future tier ever ships for mobile (e.g. via on-demand asset
  download with a progress UI), update this README + the two scripts
  above + the `MOBILE_TIERS` policy in design.md.

## Setup

```bash
# 1. Build circuits (requires circom CLI)
cd circuits && bash scripts/build.sh

# 2. Copy to mobile assets (tier-16 only — see "Tier policy" above)
cd ../mobile && npm run copy:circuits
```

Without these files, deposit, claim, and order proof generation will fail at runtime.
