// Populate required env vars before config.ts is imported anywhere
// in the test graph. Consumed by vitest.config.ts as a setupFile.
//
// Load order matters: `.env` → then defaults. dotenv.config() does not
// override already-set values, so calling it before `??=` makes `.env`
// win and defaults fill only what's missing (CI case).
import { config as loadDotenv } from "dotenv";

loadDotenv();

process.env.RPC_URL ??= "http://localhost:8545";
process.env.RELAYER_PRIVATE_KEY ??= "0x" + "a".repeat(64);
process.env.COMMITMENT_POOL_ADDRESS ??= "0x" + "1".repeat(40);
process.env.PRIVATE_SETTLEMENT_ADDRESS ??= "0x" + "2".repeat(40);
process.env.FEE_VAULT_ADDRESS ??= "0x" + "3".repeat(40);
