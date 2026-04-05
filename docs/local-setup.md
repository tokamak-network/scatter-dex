# Local Development Setup

ScatterDEX requires a **zk-X509 Identity Registry** for user verification (Dual-CA architecture). This guide covers two ways to run the full stack locally.

## Option A: Docker

> **Note:** Docker mode requires a `frontend/Dockerfile` which is not yet created.
> Use **Option B (Native)** for now.

### Mock Mode (standalone, no zk-X509)

Uses `MockIdentityRegistry` that approves all users and relayers (Dual-CA mock).

```bash
make up          # start (background)
make ps          # check status
make logs        # follow logs
make down        # stop
make clean       # stop + remove volumes
```

Or without Makefile:

```bash
docker compose --profile mock up -d
```

### Integration Mode (with zk-X509)

Connects to the zk-X509 Docker environment already running on your machine.

**Step 1:** Start zk-X509 by following the [zk-X509 Local Setup Guide](https://github.com/tokamak-network/zk-X509/blob/main/docs/local-setup.md).

**Step 2:** Start ScatterDEX:

```bash
make up-integration \
  IDENTITY_REGISTRY=0x... \
  RELAYER_IDENTITY_REGISTRY=0x...
```

Or without Makefile:

```bash
IDENTITY_REGISTRY=0x...           \
RELAYER_IDENTITY_REGISTRY=0x...   \
RPC_URL=http://host.docker.internal:8545 \
NEXT_PUBLIC_RPC_URL=http://localhost:8545 \
docker compose up -d
```

> - `IDENTITY_REGISTRY` — User CA registry (max masking, `minDisclosureMask=0x00`)
> - `RELAYER_IDENTITY_REGISTRY` — Relayer CA registry (min masking, `minDisclosureMask=0x0F`)

---

## Option B: Native (without Docker)

### Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (forge, anvil, cast)
- Node.js >= 18
- [circom](https://docs.circom.io/getting-started/installation/) (for ZK circuit compilation)
- [zk-X509](https://github.com/tokamak-network/zk-X509) repo (for integration mode)

### Mock Mode

```bash
./scripts/dev.sh --mock
```

This starts anvil, deploys all contracts (MockIdentityRegistry for both User CA and Relayer CA), mock tokens, relayer, and frontend in one terminal. Press `Ctrl+C` to stop all services.

### Manual Setup (Mock Mode, step by step)

If you want to understand each step or customize the process:

**1. Start anvil:**

```bash
anvil
```

**2. Deploy contracts:**

```bash
cd contracts
forge script script/DeployLocal.s.sol:DeployLocal \
  --rpc-url http://localhost:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

Note the addresses from the output (ScatterSettlement, RelayerRegistry, WETH, USDC).

**3. Whitelist tokens:**

```bash
cast send <SETTLEMENT> "setTokenWhitelist(address,bool)" <WETH> true \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --rpc-url http://localhost:8545

cast send <SETTLEMENT> "setTokenWhitelist(address,bool)" <USDC> true \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --rpc-url http://localhost:8545
```

**4. Start relayer:**

```bash
cd relayer
cat > .env <<EOF
RPC_URL=http://localhost:8545
RELAYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
SETTLEMENT_ADDRESS=<SETTLEMENT>
RELAYER_FEE=30
PORT=3001
EOF
npm run dev
```

**5. Start frontend:**

```bash
cd frontend
cat > .env.local <<EOF
NEXT_PUBLIC_SETTLEMENT_ADDRESS=<SETTLEMENT>
NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=<RELAYER_REGISTRY>
NEXT_PUBLIC_WETH_ADDRESS=<WETH>
NEXT_PUBLIC_TOKENS=<WETH>:WETH:18,<USDC>:USDC:18
NEXT_PUBLIC_RPC_URL=http://localhost:8545
NEXT_PUBLIC_CHAIN_ID=31337
EOF
npm run dev
```

### Integration Mode

**Step 1:** Start anvil:

```bash
anvil
```

**Step 2:** Deploy zk-X509 by following the [zk-X509 Local Setup Guide](https://github.com/tokamak-network/zk-X509/blob/main/docs/local-setup.md). Deploy contracts and register test users/CAs on the anvil instance.

**Step 3:** Start ScatterDEX:

```bash
IDENTITY_REGISTRY=0x... \
RELAYER_IDENTITY_REGISTRY=0x... \
./scripts/dev.sh
```

The script will:
1. Detect the running anvil (does **not** start its own)
2. Deploy ScatterDEX contracts with real `IdentityGate` (User CA) and `RelayerRegistry` (Relayer CA)
3. Register deployer as relayer
4. Start relayer on http://localhost:3001
5. Start frontend on http://localhost:3000

---

## Services

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3000 |
| Relayer | http://localhost:3001 |
| Anvil | http://localhost:8545 |

## Tests

### Contract Tests (Solidity)

```bash
cd contracts && forge test
# or
make test
```

Includes 165 tests: ScatterSettlement, CommitmentPool (ZK escrow), PrivateSettlement (ZK settle/claim).

### ZK Circuit Tests (E2E with real proofs)

```bash
cd circuits && npm install && npm test
```

Generates real Groth16 proofs and verifies them off-chain. Tests:
- Withdraw: full + partial with change commitment
- Claim: single + multiple claims from same root

### ZK Circuit Build (compile + trusted setup)

```bash
cd circuits && npm run build
```

Compiles 3 circuits (withdraw, settle, claim), runs Powers of Tau + Phase 2 ceremony, generates:
- Solidity verifiers → `contracts/src/zk/`
- WASM + zkey → `frontend/public/zk/`

### Deploy ZK Contracts (local anvil)

After `./scripts/dev.sh --mock`:

```bash
cd contracts
forge script script/DeployPrivateSettlement.s.sol:DeployPrivateSettlement \
  --rpc-url http://localhost:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

Note the `NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS` from the output and add it to `frontend/.env.local`.

### Relayer Tests

```bash
cd relayer && npm test           # unit tests
cd relayer && npm run test:e2e   # E2E integration tests
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| deployer fails to connect | Docker: ensure `--profile mock` is set. Native: start anvil first |
| `NotVerified` when depositing | Register the user wallet via zk-X509 (User CA) |
| `NotVerified` when registering relayer | Register the relayer via zk-X509 (Relayer CA) |
| Port conflict with zk-X509 frontend | Run the zk-X509 frontend on a different port: `PORT=3002` |
| `TokenNotWhitelisted` | Tokens are auto-whitelisted by `dev.sh` / deployer; check the correct addresses |
