#!/usr/bin/env bash
#
# gen-deployment-doc.sh — render a human-readable, committable deployment doc
# listing EVERY contract deployed, one by one, with its proxy / logic / admin
# address AND the on-chain CREATE tx hash.
#
# Why: forge's broadcast/<script>/<chainId>/run-latest.json has the tx hashes
# but is gitignored and machine-shaped; deployments/<chainId>.json has the
# curated addresses but no tx hashes. This script joins the two into
# deployments/<chainId>.md so the team has one readable record of what was
# deployed, where, and in which transaction.
#
# Usage:
#   scripts/gen-deployment-doc.sh [chainId]      # default 11155111 (Sepolia)
#
# Inputs (all under contracts/):
#   deployments/<chainId>.json                          (DeploySepolia ledger)
#   deployments/zk-x509-{users,relayers}-<chainId>.json (zk-X509 ledgers, if any)
#   broadcast/DeploySepolia.s.sol/<chainId>/run-latest.json (tx hashes, if present)
# Output:
#   deployments/<chainId>.md
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHAIN_ID="${1:-11155111}"
DEPLOY_DIR="$ROOT_DIR/contracts/deployments"
LEDGER="$DEPLOY_DIR/${CHAIN_ID}.json"
BROADCAST="$ROOT_DIR/contracts/broadcast/DeploySepolia.s.sol/${CHAIN_ID}/run-latest.json"
OUT="$DEPLOY_DIR/${CHAIN_ID}.md"

[ -f "$LEDGER" ] || { echo "ERROR: ledger not found: $LEDGER (run DeploySepolia first)" >&2; exit 1; }

python3 - "$CHAIN_ID" "$LEDGER" "$BROADCAST" "$DEPLOY_DIR" "$OUT" <<'PY'
import json, os, sys

chain_id, ledger_path, broadcast_path, deploy_dir, out_path = sys.argv[1:6]
L = json.load(open(ledger_path))

# address(lower) -> CREATE tx hash, from the forge broadcast (if present).
tx_by_addr = {}
if os.path.isfile(broadcast_path):
    bc = json.load(open(broadcast_path))
    for t in bc.get("transactions", []):
        if t.get("transactionType") == "CREATE" and t.get("contractAddress"):
            tx_by_addr[t["contractAddress"].lower()] = t.get("hash", "")

def tx(addr):
    if not isinstance(addr, str) or not addr.startswith("0x") or len(addr) != 42:
        return ""
    return tx_by_addr.get(addr.lower(), "")

def row(*cells):
    return "| " + " | ".join(str(c) for c in cells) + " |"

lines = []
A = lines.append
A(f"# zkScatter deployment — chain {chain_id}")
A("")
A(f"- **Deployer:** `{L.get('deployer','?')}`")
A(f"- **Deploy block:** {L.get('deployBlock','?')}")
A(f"- **Proxy pattern:** {L.get('proxyType','?')}")
A(f"- **Shared ProxyAdmin:** `{L.get('proxyAdmin','?')}`")
A(f"- **Upgrade owner (ProxyAdmin owner):** `{L.get('upgradeOwner','?')}`")
A(f"- **Treasury owner:** `{L.get('treasuryOwner','?')}`")
A(f"- **Relayer bond token:** `{L.get('bondToken','?')}`")
if not tx_by_addr:
    A("")
    A("> ⚠️ No broadcast file found — tx-hash columns omitted. "
      "(Re-run after a `--broadcast` deploy to capture tx hashes.)")
A("")

# (label, proxy-key, impl-key) for every upgradeable contract.
UPGRADEABLE = [
    ("CommitmentPool",    "commitmentPool",    "commitmentPoolImpl"),
    ("PrivateSettlement", "privateSettlement", "privateSettlementImpl"),
    ("IdentityGate",      "identityGate",      "identityGateImpl"),
    ("RelayerRegistry",   "relayerRegistry",   "relayerRegistryImpl"),
    ("FeeVault",          "feeVault",          "feeVaultImpl"),
    ("Treasury",          "treasury",          "treasuryImpl"),
    ("SanctionsList",     "sanctionsList",     "sanctionsListImpl"),
]
A("## Upgradeable contracts (proxy + logic, shared admin)")
A("")
hdr = ["Contract", "Proxy (facade)", "Logic (impl)", "Admin"]
if tx_by_addr: hdr += ["Proxy tx", "Impl tx"]
A(row(*hdr))
A(row(*(["---"] * len(hdr))))
admin = L.get("proxyAdmin", "?")
for label, pk, ik in UPGRADEABLE:
    p, i = L.get(pk, "?"), L.get(ik, "?")
    cells = [label, f"`{p}`", f"`{i}`", f"`{admin}`"]
    if tx_by_addr: cells += [f"`{tx(p)}`", f"`{tx(i)}`"]
    A(row(*cells))
A("")

# Plain (non-proxy) contracts deployed by this script.
PLAIN = [("BatchExecutor", "batchExecutor"), ("IssuanceApprovalRegistry", "issuanceApprovalRegistry")]
A("## Non-upgradeable (plain) contracts")
A("")
hdr = ["Contract", "Address"] + (["tx"] if tx_by_addr else [])
A(row(*hdr)); A(row(*(["---"] * len(hdr))))
for label, k in PLAIN:
    a = L.get(k, "?")
    cells = [label, f"`{a}`"] + ([f"`{tx(a)}`"] if tx_by_addr else [])
    A(row(*cells))
A("")

# ZK verifiers (plain, generated from circuits/build).
VERIFIERS = [
    ("deposit",       "depositVerifier"),
    ("withdraw",      "withdrawVerifier"),
    ("claim (16)",    "claimVerifier16"),
    ("claim (64)",    "claimVerifier64"),
    ("claim (128)",   "claimVerifier128"),
    ("authorize (16)","authorizeVerifier16"),
    ("authorize (64)","authorizeVerifier64"),
    ("authorize (128)","authorizeVerifier128"),
    ("cancel",        "cancelVerifier"),
]
A("## ZK verifiers (plain)")
A("")
hdr = ["Circuit", "Address"] + (["tx"] if tx_by_addr else [])
A(row(*hdr)); A(row(*(["---"] * len(hdr))))
for label, k in VERIFIERS:
    a = L.get(k, "?")
    cells = [label, f"`{a}`"] + ([f"`{tx(a)}`"] if tx_by_addr else [])
    A(row(*cells))
A("")

# External / pre-existing addresses (reused, not deployed here).
EXTERNAL = [
    ("WETH",                     "weth"),
    ("IdentityRegistry User-CA", "identityRegistry"),
    ("IdentityRegistry Relayer-CA", "relayerIdentityRegistry"),
]
A("## External / pre-existing (reused, not deployed here)")
A("")
A(row("Name", "Address")); A(row("---", "---"))
for label, k in EXTERNAL:
    A(row(label, f"`{L.get(k,'?')}`"))
A("")

# zk-X509 registry ledgers (deployed by deploy-zk-x509-sepolia.sh).
zk = []
for role in ("users", "relayers"):
    p = os.path.join(deploy_dir, f"zk-x509-{role}-{chain_id}.json")
    if os.path.isfile(p):
        zk.append((role, json.load(open(p))))
if zk:
    A("## zk-X509 IdentityRegistries")
    A("")
    A(row("Role", "Registry (proxy)", "Logic (impl)", "Type", "Owner", "Wallets/cert", "Block"))
    A(row(*(["---"] * 7)))
    for role, z in zk:
        A(row(role, f"`{z.get('identityRegistry','?')}`", f"`{z.get('identityRegistryImpl','?')}`",
              z.get("proxyType", "?"), f"`{z.get('owner','?')}`",
              z.get("maxWalletsPerCert", "?"), z.get("deployBlock", "?")))
    A("")

open(out_path, "w").write("\n".join(lines) + "\n")
print(f"wrote {out_path} ({len(UPGRADEABLE)} proxies, {len(VERIFIERS)} verifiers, {len(zk)} zk-X509 ledgers)")
PY