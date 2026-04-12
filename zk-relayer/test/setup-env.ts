// Populate required env vars before config.ts is imported anywhere
// in the test graph. Consumed by vitest.config.ts as a setupFile.
// Ensures tests run without a .env file (e.g. in CI).
process.env.RPC_URL ??= "http://localhost:8545";
process.env.RELAYER_PRIVATE_KEY ??= "0x" + "a".repeat(64);
process.env.COMMITMENT_POOL_ADDRESS ??= "0x" + "1".repeat(40);
process.env.PRIVATE_SETTLEMENT_ADDRESS ??= "0x" + "2".repeat(40);
process.env.FEE_VAULT_ADDRESS ??= "0x" + "3".repeat(40);
process.env.ADMIN_API_KEY ??= "test-admin-key-at-least-32-bytes-long";
