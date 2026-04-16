# ZK Circuit Assets

This directory holds compiled circuit files required at runtime:
- `deposit.wasm` + `deposit_final.zkey` — deposit proof
- `claim.wasm` + `claim_final.zkey` — claim proof
- `authorize.wasm` + `authorize_final.zkey` — authorize proof (market + limit orders)

These files are **not committed to git** (too large, ~5-19MB each).

## Setup

```bash
# 1. Build circuits (requires circom CLI)
cd circuits && bash scripts/build.sh

# 2. Copy to mobile assets
cd ../mobile && npm run copy:circuits
```

Without these files, deposit, claim, and order proof generation will fail at runtime.
