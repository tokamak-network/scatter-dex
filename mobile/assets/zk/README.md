# ZK Circuit Assets

This directory holds compiled circuit files required at runtime:
- `deposit.wasm` + `deposit_final.zkey`
- `claim.wasm` + `claim_final.zkey`

These files are **not committed to git** (too large, ~5-10MB each).

## Setup

```bash
# 1. Build circuits (requires circom CLI)
cd circuits && bash scripts/build.sh

# 2. Copy to mobile assets
cd ../mobile && npm run copy:circuits
```

Without these files, deposit and claim proof generation will fail at runtime.
