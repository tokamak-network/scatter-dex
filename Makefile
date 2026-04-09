.PHONY: up up-multi down ps logs clean test up-integration

# ─── Mock Mode (standalone, no zk-X509) ──────────────────────
up:
	docker compose --profile mock up -d
	@echo ""
	@echo "ScatterDEX is running (mock mode)"
	@echo "  Frontend:         http://localhost:3000"
	@echo "  ZK Relayer A:     http://localhost:3002"
	@echo "  Shared Orderbook: http://localhost:4000"
	@echo "  Anvil:            http://localhost:8545"
	@echo ""
	@echo "  make up-multi  — start with Relayer B (cross-relayer matching)"
	@echo "  make logs      — follow logs"
	@echo "  make down      — stop all"

# ─── Multi-Relayer Mode (cross-relayer matching) ─────────────
up-multi:
	docker compose --profile mock --profile multi-relayer up -d
	@echo ""
	@echo "ScatterDEX is running (multi-relayer mode)"
	@echo "  Frontend:         http://localhost:3000"
	@echo "  ZK Relayer A:     http://localhost:3002"
	@echo "  ZK Relayer B:     http://localhost:3003"
	@echo "  Shared Orderbook: http://localhost:4000"
	@echo "  Anvil:            http://localhost:8545"
	@echo ""
	@echo "  make logs   — follow logs"
	@echo "  make down   — stop all"

# ─── Integration Mode (with zk-X509) ────────────────────────
up-integration:
ifndef IDENTITY_REGISTRY
	$(error IDENTITY_REGISTRY is required. Usage: make up-integration IDENTITY_REGISTRY=0x... RELAYER_IDENTITY_REGISTRY=0x...)
endif
ifndef RELAYER_IDENTITY_REGISTRY
	$(error RELAYER_IDENTITY_REGISTRY is required. Usage: make up-integration IDENTITY_REGISTRY=0x... RELAYER_IDENTITY_REGISTRY=0x...)
endif
	IDENTITY_REGISTRY=$(IDENTITY_REGISTRY) \
	RELAYER_IDENTITY_REGISTRY=$(RELAYER_IDENTITY_REGISTRY) \
	RPC_URL=http://host.docker.internal:8545 \
	NEXT_PUBLIC_RPC_URL=http://localhost:8545 \
	docker compose up -d
	@echo ""
	@echo "ScatterDEX is running (integration mode)"
	@echo "  Frontend:         http://localhost:3000"
	@echo "  ZK Relayer A:     http://localhost:3002"
	@echo "  Shared Orderbook: http://localhost:4000"
	@echo "  Anvil:            http://localhost:8545 (zk-X509)"

# ─── Management ──────────────────────────────────────────────
down:
	docker compose --profile mock --profile multi-relayer down 2>/dev/null || docker compose down

ps:
	docker compose ps

logs:
	docker compose logs -f

clean:
	docker compose --profile mock --profile multi-relayer down -v 2>/dev/null || docker compose down -v

# ─── Contract Tests ──────────────────────────────────────────
test:
	cd contracts && forge test
