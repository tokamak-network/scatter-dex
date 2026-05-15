#!/usr/bin/env bash
# ============================================================
# Swap scatter-dex's IdentityGate from MockIdentityRegistry to a real
# zk-X509 IdentityRegistry. Run AFTER `dev.sh --mock` is up — with any
# `--apps` selection (e.g. `--apps pay`, `--apps pay,pro`, …) — and
# AFTER you've deployed a zk-X509 IdentityRegistry onto the same anvil.
#
# IdentityGate is a single on-chain contract shared by every app
# (Pay, Pro, Drop, etc.). One swap covers all of them — the script
# reads the address from apps/pay/.env.local for convenience.
#
# The native `dev.sh` integration path (no --mock, with
# IDENTITY_REGISTRY=...) tries to register the relayer identity
# during contract deploy, which reverts with NotVerified() on a
# freshly-deployed zk-X509 registry. Booting in mock and swapping
# afterwards lets the stack come up first and avoids that
# chicken-and-egg.
#
# Usage:
#   ./scripts/swap-identity-registry.sh <zk-X509 IdentityRegistry>
#   IDENTITY_GATE=0x... ./scripts/swap-identity-registry.sh 0x...
#   RPC_URL=http://localhost:8545 ./scripts/swap-identity-registry.sh 0x...
#   ZK_X509_REPO=/path/to/zk-X509 ./scripts/swap-identity-registry.sh 0x...
#   EXPECTED_VKEY=0x… ./scripts/swap-identity-registry.sh 0x...
#
# Inputs (env or default):
#   IDENTITY_GATE   IdentityGate proxy. Auto-resolved by reading
#                   NEXT_PUBLIC_IDENTITY_GATE_ADDRESS from the first
#                   available .env.local under: apps/pay, apps/pro,
#                   apps/drop, apps/operators. They all carry the same
#                   on-chain address (single IdentityGate, multiple
#                   front-ends). Set explicitly if none of those were
#                   started: IDENTITY_GATE=0x... ./scripts/swap...
#   RPC_URL         default http://localhost:8545
#   DEPLOYER_KEY    default Anvil account #0 (must own IdentityGate)
#   ZK_X509_REPO    optional absolute path to a co-checked-out zk-X509
#                   repo. When set, delegates a full health check to
#                   `script/verify-deployment.sh --quick` over there,
#                   anchoring the swap on whatever ELF that repo
#                   currently builds.
#   EXPECTED_VKEY   optional 32-byte hex. When set, asserts
#                   `registry.effectiveProgramVKey()` equals it before
#                   touching IdentityGate. Use when the source of
#                   truth is the desktop app's bundled ELF VK and the
#                   zk-X509 repo isn't locally checked out.
#   STRICT_VKEY     default 1. When 0, soft-warn on missing
#                   `effectiveProgramVKey()` getter (older registry
#                   builds) instead of aborting.
# ============================================================

set -euo pipefail

ZK_REG="${1:-}"
if [ -z "$ZK_REG" ]; then
    echo "ERROR: zk-X509 IdentityRegistry address required."
    echo "Usage: $0 <zk-X509 IdentityRegistry>"
    exit 1
fi

RPC_URL="${RPC_URL:-http://localhost:8545}"
DEPLOYER_KEY="${DEPLOYER_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

# Resolve IdentityGate from env or from the first available app's .env.local.
# All apps point at the same on-chain IdentityGate, so any of them works —
# fallback order (pay → pro → drop → operators) matches the most-common
# `--apps` selections so an operator that ran `--apps pro` (no pay) still
# resolves automatically.
if [ -z "${IDENTITY_GATE:-}" ]; then
    REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
    for app in pay pro drop operators; do
        ENV_FILE="$REPO_ROOT/apps/$app/.env.local"
        [ -f "$ENV_FILE" ] || continue
        CAND=$(grep -E '^NEXT_PUBLIC_IDENTITY_GATE_ADDRESS=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
        if [ -n "$CAND" ]; then
            IDENTITY_GATE="$CAND"
            echo "  Resolved IdentityGate from apps/$app/.env.local"
            break
        fi
    done
fi
if [ -z "${IDENTITY_GATE:-}" ]; then
    echo "ERROR: IDENTITY_GATE not set and no apps/{pay,pro,drop,operators}/.env.local"
    echo "       has NEXT_PUBLIC_IDENTITY_GATE_ADDRESS."
    echo "       Did you run 'dev.sh --mock --apps <pay|pro|...>' first?"
    echo "       Or set explicitly: IDENTITY_GATE=0x... $0 $*"
    exit 1
fi

echo "=== Swap IdentityGate registry → zk-X509 ==="
echo "  IdentityGate: $IDENTITY_GATE"
echo "  zk-X509 reg:  $ZK_REG"
echo "  RPC:          $RPC_URL"
echo ""

# Sanity: anvil reachable, IdentityGate has code, zk-X509 reg has code.
for addr in "$IDENTITY_GATE" "$ZK_REG"; do
    CODE=$(cast code "$addr" --rpc-url "$RPC_URL" 2>/dev/null || echo "0x")
    if [ "$CODE" = "0x" ]; then
        echo "ERROR: no contract at $addr"
        exit 1
    fi
done

# ── zk-X509 registry VK pre-check ─────────────────────────────
# The swap doesn't change the registry's program VK — it only
# rewires IdentityGate.getRegistries() — so if the target registry
# was deployed with a stale `programVKey` (e.g. an old hardcoded
# default in DeployLocal.s.sol, or a since-rebuilt ELF), the swap
# completes silently, the user generates a perfectly valid Groth16
# proof, and the eventual `register(proof, publicValues)` call
# reverts with custom selector `0x7fcdd1f4` = `ProofInvalid()` —
# diagnosis trail invisible at that point.
#
# Three escalating levels of check, each opt-in:
#   1. Always: `effectiveProgramVKey()` is callable and non-zero
#      (proves the registry is wired to a factory or carries its
#      own VK). Soft-warns when STRICT_VKEY=0 and the getter is
#      missing — older registry deployments lacked it.
#   2. EXPECTED_VKEY=0x…  → assert exact match (callers that know
#      the live ELF VK out-of-band).
#   3. ZK_X509_REPO=path  → run that repo's verify-deployment.sh
#      against the registry. Same set of 7 checks, but anchored on
#      whatever ELF that local checkout currently builds (cargo
#      run --bin vkey), so an ELF rebuild *after* deploy is also
#      caught.
STRICT_VKEY="${STRICT_VKEY:-1}"
echo "  Pre-check: registry program VK..."
# Detect getter availability by exit code, not substring matching on
# the returned hex. A legitimate 32-byte VK can contain the byte
# patterns 0x6572726f72 ("error") or 0x726576657274 ("reverted")
# in its body, and the previous `*"reverted"*` / `*"error"*` checks
# would false-fail on those — flagging a working registry as broken
# (Gemini review on PR #754).
set +e
VKEY_RAW=$(cast call "$ZK_REG" "effectiveProgramVKey()(bytes32)" --rpc-url "$RPC_URL" 2>/dev/null)
VKEY_STATUS=$?
set -e
# When `EXPECTED_VKEY` is set, the caller is explicitly anchoring the
# swap on a known VK — promote a missing getter to a hard error
# regardless of `STRICT_VKEY`, because the soft-warn path below would
# silently skip the EXPECTED_VKEY assertion the caller asked for
# (Copilot review on PR #754).
if [ "$VKEY_STATUS" -ne 0 ] || [ -z "$VKEY_RAW" ]; then
    if [ "$STRICT_VKEY" = "1" ] || [ -n "${EXPECTED_VKEY:-}" ]; then
        echo "ERROR: registry $ZK_REG has no usable effectiveProgramVKey()."
        echo "       Either it's not a zk-X509 IdentityRegistry, or it's an"
        echo "       older build without the getter."
        if [ -n "${EXPECTED_VKEY:-}" ]; then
            echo "       (STRICT_VKEY=0 is NOT honored while EXPECTED_VKEY is"
            echo "       set — unset EXPECTED_VKEY too if you really mean to"
            echo "       skip the VK check.)"
        else
            echo "       Set STRICT_VKEY=0 to skip this check at your own risk."
        fi
        exit 1
    fi
    echo "  ⚠ effectiveProgramVKey() not callable — skipping VK check (STRICT_VKEY=0)."
else
    ZERO_BYTES32="0x0000000000000000000000000000000000000000000000000000000000000000"
    # Full A–Z lowercase (not just A–F) so a `0X…` prefix the user
    # might paste also normalizes correctly (Copilot+Gemini review
    # on PR #754).
    VKEY_LOWER=$(printf '%s' "$VKEY_RAW" | tr 'A-Z' 'a-z')
    if [ "$VKEY_LOWER" = "$ZERO_BYTES32" ]; then
        echo "ERROR: registry $ZK_REG has a zero programVKey — proofs will"
        echo "       always revert. Did deploy-on-existing-anvil.sh fail"
        echo "       silently? Re-run it and confirm Step 5 passes."
        exit 1
    fi
    echo "  effectiveProgramVKey: $VKEY_RAW"

    if [ -n "${EXPECTED_VKEY:-}" ]; then
        EXP_LOWER=$(printf '%s' "$EXPECTED_VKEY" | tr 'A-Z' 'a-z')
        if [ "$VKEY_LOWER" != "$EXP_LOWER" ]; then
            echo "ERROR: registry VK ($VKEY_RAW) ≠ EXPECTED_VKEY ($EXPECTED_VKEY)."
            echo "       This swap would point IdentityGate at a registry that"
            echo "       rejects every proof from the current ELF. To fix the"
            echo "       registry side first, in your zk-X509 checkout:"
            echo "         bash script/deploy-on-existing-anvil.sh   # redeploys + sets correct VK"
            echo "       Or update an already-deployed factory's VK in place"
            echo "       (need its address from .env.shared-anvil):"
            echo "         FACTORY=\$(grep ^FACTORY_ADDRESS= \$ZK_X509_REPO/.env.shared-anvil | cut -d= -f2- | tr -d '\"')"
            echo "         cast send \$FACTORY 'updateProgramVKey(bytes32)' \\"
            echo "           $EXPECTED_VKEY --rpc-url $RPC_URL --private-key \$DEPLOYER_KEY"
            exit 1
        fi
        echo "  ✓ matches EXPECTED_VKEY"
    fi
fi

if [ -n "${ZK_X509_REPO:-}" ]; then
    VERIFY_SCRIPT="$ZK_X509_REPO/script/verify-deployment.sh"
    # `-r` instead of `-x`: we invoke via `bash $VERIFY_SCRIPT` below
    # (an explicit interpreter call), so the executable bit isn't
    # consulted. A checkout that lost the +x bit (filesystem
    # transfer / archive extract) would still work, but the earlier
    # `-x` would false-fail it (Copilot review on PR #754).
    if [ ! -r "$VERIFY_SCRIPT" ]; then
        echo "ERROR: ZK_X509_REPO=$ZK_X509_REPO set, but $VERIFY_SCRIPT is"
        echo "       not readable. Make sure that repo is on the branch that"
        echo "       added verify-deployment.sh (or unset ZK_X509_REPO to"
        echo "       skip the delegated check)."
        exit 1
    fi
    echo "  Delegating to $VERIFY_SCRIPT (REGISTRY_ADDRESS_OVERRIDE=$ZK_REG, --quick)..."
    # `--quick` skips the cargo run + SP1 cache integrity scan over
    # there since the swap operator typically just wants to know
    # "does this registry's on-chain state match its factory + VK
    # snapshot"; the full cargo recompute is the right thing for
    # deeper investigations and is one flag away (`--rebuild-vk`).
    if ! REGISTRY_ADDRESS_OVERRIDE="$ZK_REG" bash "$VERIFY_SCRIPT" --quick; then
        echo "ERROR: zk-X509 verify-deployment.sh reported a failure on"
        echo "       registry $ZK_REG. Aborting swap — fix upstream first."
        exit 1
    fi
fi

# Snapshot current registries before mutation.
CURRENT=$(cast call "$IDENTITY_GATE" "getRegistries()(address[])" --rpc-url "$RPC_URL")
echo "  Current registries: $CURRENT"

# Add zk-X509 first — IdentityGate refuses to leave 0 registries, so we
# can't remove the mock until the replacement is in place.
if echo "$CURRENT" | grep -qi "${ZK_REG#0x}"; then
    echo "  · zk-X509 registry already present, skipping addRegistry"
else
    echo "  → addRegistry($ZK_REG)"
    cast send "$IDENTITY_GATE" "addRegistry(address)" "$ZK_REG" \
        --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null
    echo "    done"
fi

# Remove every other registry (typically the mock from dev.sh's deploy).
UPDATED=$(cast call "$IDENTITY_GATE" "getRegistries()(address[])" --rpc-url "$RPC_URL")
IFS=',' read -ra ADDRS <<< "$(echo "$UPDATED" | tr -d '[] ')"
for addr in "${ADDRS[@]}"; do
    [ -z "$addr" ] && continue
    # Case-insensitive compare to avoid checksum mismatches.
    if [ "$(echo "$addr" | tr 'A-Z' 'a-z')" != "$(echo "$ZK_REG" | tr 'A-Z' 'a-z')" ]; then
        echo "  → removeRegistry($addr)"
        cast send "$IDENTITY_GATE" "removeRegistry(address)" "$addr" \
            --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null
        echo "    done"
    fi
done

FINAL=$(cast call "$IDENTITY_GATE" "getRegistries()(address[])" --rpc-url "$RPC_URL")
echo ""
echo "=== Final ==="
echo "  Registries on IdentityGate: $FINAL"
echo ""
echo "Pay's isVerified() now routes through zk-X509. Issue identities via"
echo "the zk-X509 dashboard at http://localhost:3000 before depositing."
