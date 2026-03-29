# Local Development Setup

ScatterDEX requires a **zk-X509 Identity Registry** for user verification. This guide covers how to run the full stack locally with both systems on a shared anvil instance.

## Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (forge, anvil, cast)
- Node.js >= 18
- [zk-X509](https://github.com/user/zk-X509) repo cloned at a known path
- Docker Desktop (for Groth16 proof generation)

## Step 1: Start Anvil

One shared anvil instance for both zk-X509 and ScatterDEX.

```bash
anvil
```

Leave this terminal running.

## Step 2: Deploy zk-X509

Follow the [zk-X509 local setup guide](https://github.com/user/zk-X509/blob/main/docs/local-setup.md) — Steps 1~3 (certs, build, deploy).

```bash
cd /path/to/zk-X509

# Generate test certs
cd certs && bash generate-test-certs.sh && cd ..

# Build
cargo build --release --workspace

# Deploy contracts
cd contracts
PROGRAM_V_KEY=$(cargo run --release --bin vkey 2>&1 | grep "Verification Key:" | awk '{print $3}') \
MAX_WALLETS_PER_CERT=3 \
forge script script/DeployLocal.s.sol --tc DeployLocalScript \
  --rpc-url http://localhost:8545 \
  --broadcast \
  --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

Note the **IdentityRegistry (proxy)** address from the output:

```
IdentityRegistry (proxy): 0xbf9fBFf01664500A33080Da5d437028b07DFcC55
```

## Step 3: Register a CA

Register at least one CA so users can be verified.

```bash
export REGISTRY_ADDR=0xbf9fBFf01664500A33080Da5d437028b07DFcC55  # from Step 2

CA_HASH=$(cargo run --release --bin zk-x509 -- --ca-root --ca-cert certs/ca_pub.der 2>&1 \
  | grep "CA Merkle Root:" | awk '{print $4}')

cast send $REGISTRY_ADDR "addCA(bytes32)" $CA_HASH \
  --rpc-url http://localhost:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

## Step 4: Register Test Users

Generate a proof and register a wallet (e.g., Alice — anvil account #0):

```bash
cargo run --release --bin evm -- --system groth16 \
  --cert certs/signCert.der --key certs/signPri.key --ca-cert certs/ca_pub.der \
  --registrant 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
  --wallet-index 0 --max-wallets 3 --chain-id 31337 \
  --registry-address $REGISTRY_ADDR \
  --rpc-url http://localhost:8545
```

Submit the proof on-chain:

```bash
cast send $REGISTRY_ADDR "register(bytes,bytes)" $PROOF $PUBLIC_VALUES \
  --rpc-url http://localhost:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

Verify:

```bash
cast call $REGISTRY_ADDR "isVerified(address)(bool)" \
  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --rpc-url http://localhost:8545
# → true
```

## Step 5: Start ScatterDEX

```bash
cd /path/to/scatter-dex

IDENTITY_REGISTRY=0xbf9fBFf01664500A33080Da5d437028b07DFcC55 ./scripts/dev.sh
```

This will:
1. Detect the running anvil (does **not** start its own)
2. Deploy ScatterDEX contracts with the real `IdentityGate` → zk-X509 registry
3. Deploy test tokens (WETH, USDC) and whitelist them
4. Start relayer on http://localhost:3001
5. Start frontend on http://localhost:3000

## Quick Test (Mock Mode)

For rapid contract/frontend development without zk-X509:

```bash
./scripts/dev.sh --mock
```

This starts its own anvil with a `MockIdentityRegistry` that approves all users. No proofs needed — but identity verification is bypassed.

## Summary

| Service | URL | Source |
|---------|-----|--------|
| Anvil | http://localhost:8545 | Shared instance |
| zk-X509 Frontend | http://localhost:3000 (zk-X509) | zk-X509 repo |
| ScatterDEX Frontend | http://localhost:3000 | scatter-dex repo |
| Relayer | http://localhost:3001 | scatter-dex repo |

> **Port conflict:** Both frontends default to port 3000. Run zk-X509 frontend on a different port if needed:
> ```bash
> cd /path/to/zk-X509/frontend && PORT=3002 npm run dev
> ```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `ERROR: anvil is not running` | Start anvil first, or use `--mock` mode |
| `ERROR: No contract found at 0x...` | Deploy zk-X509 contracts first (Step 2) |
| `NotVerified` when depositing | Register the user wallet via zk-X509 (Step 4) |
| `TokenNotWhitelisted` | Tokens are auto-whitelisted by `dev.sh`; check the correct addresses |
