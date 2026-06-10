/**
 * Commitment-indexer daemon entry. Reads RPC + CommitmentPool address +
 * deploy block from env, attaches to the same SQLite file the orderbook
 * server reads from, and indexes `CommitmentInserted` leaves so
 * `GET /api/commitments` can serve them. Mirrors `src/verify.ts`.
 *
 * Multi-network: one process runs a loop per chain, each binding its own RPC +
 * pool but sharing the one SQLite DB (rows are scoped by chain_id).
 *
 * Env:
 *   COMMITMENT_CHAINS              — JSON array of per-chain configs, e.g.
 *                                    [{"chainId":11155111,"rpcUrl":"https://…",
 *                                      "commitmentPoolAddress":"0x…",
 *                                      "deployBlock":11008264}, …]. Wins over
 *                                    the single-chain vars below.
 *   RPC_URL                       — JSON-RPC endpoint (single-chain fallback)
 *   COMMITMENT_POOL_ADDRESS       — 0x… (single-chain fallback)
 *   COMMITMENT_DEPLOY_BLOCK       — pool deploy block (single-chain fallback)
 *   CHAIN_ID                      — chainId for the single-chain fallback
 *                                   (default 11155111 / Sepolia)
 *   DB_PATH                       — same path the API uses (default shared-orderbook.db)
 *   COMMITMENT_POLL_INTERVAL_SEC  — watch-mode pass interval (default 30)
 *   COMMITMENT_BLOCK_SAFETY_MARGIN— confirmations to stay behind head (default 6)
 *   COMMITMENT_INDEX_BLOCK_RANGE  — max blocks per getLogs window (default 50000)
 *
 * Modes:
 *   node dist/commitment-indexer.js          # one-shot pass per chain, exit 0
 *   node dist/commitment-indexer.js --watch  # loop per chain until SIGINT/SIGTERM
 */
import "dotenv/config";
import { JsonRpcProvider, isAddress } from "ethers";
import { OrderbookDB } from "./core/db.js";
import {
  makeCommitmentFetcher,
  runCommitmentIndexLoop,
  runCommitmentIndexPass,
} from "./core/commitment-indexer.js";
import { DEFAULT_CHAIN_ID } from "./core/chain.js";

interface ChainConfig {
  chainId: number;
  rpcUrl: string;
  commitmentPoolAddress: string;
  deployBlock: number;
}

function envRequired(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`[commitment-indexer] missing required env: ${key}`);
    process.exit(2);
  }
  return v;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`[commitment-indexer] invalid numeric env: ${key}=${raw}`);
    process.exit(2);
  }
  return n;
}

/** CHAINS (a JSON array) wins; otherwise fall back to single-chain env vars. */
function resolveChains(): ChainConfig[] {
  const raw = process.env.COMMITMENT_CHAINS;
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error("[commitment-indexer] COMMITMENT_CHAINS is not valid JSON");
      process.exit(2);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.error("[commitment-indexer] COMMITMENT_CHAINS must be a non-empty JSON array");
      process.exit(2);
    }
    return parsed.map((c, i) => {
      if (typeof c !== "object" || c === null) {
        console.error(`[commitment-indexer] COMMITMENT_CHAINS[${i}] must be an object`);
        process.exit(2);
      }
      const o = c as Record<string, unknown>;
      const reqStr = (field: string): string => {
        const v = o[field];
        if (typeof v !== "string" || !v.trim()) {
          console.error(`[commitment-indexer] COMMITMENT_CHAINS[${i}].${field} must be a non-empty string`);
          process.exit(2);
        }
        return v.trim();
      };
      const chainId = Number(o.chainId);
      if (!Number.isInteger(chainId) || chainId <= 0) {
        console.error(`[commitment-indexer] COMMITMENT_CHAINS[${i}].chainId must be a positive integer`);
        process.exit(2);
      }
      const deployBlock = Number(o.deployBlock);
      if (!Number.isInteger(deployBlock) || deployBlock < 0) {
        console.error(`[commitment-indexer] COMMITMENT_CHAINS[${i}].deployBlock must be a non-negative integer`);
        process.exit(2);
      }
      const commitmentPoolAddress = reqStr("commitmentPoolAddress");
      if (!isAddress(commitmentPoolAddress)) {
        console.error(`[commitment-indexer] COMMITMENT_CHAINS[${i}].commitmentPoolAddress is not a valid EVM address`);
        process.exit(2);
      }
      return { chainId, rpcUrl: reqStr("rpcUrl"), commitmentPoolAddress, deployBlock };
    });
  }
  // Single-chain fallback.
  const commitmentPoolAddress = envRequired("COMMITMENT_POOL_ADDRESS").trim();
  if (!isAddress(commitmentPoolAddress)) {
    console.error("[commitment-indexer] COMMITMENT_POOL_ADDRESS is not a valid EVM address");
    process.exit(2);
  }
  return [{
    chainId: envInt("CHAIN_ID", DEFAULT_CHAIN_ID),
    rpcUrl: envRequired("RPC_URL"),
    commitmentPoolAddress,
    deployBlock: envInt("COMMITMENT_DEPLOY_BLOCK", 0),
  }];
}

async function main(): Promise<void> {
  const chains = resolveChains();
  const dbPath = process.env.DB_PATH ?? "shared-orderbook.db";
  const watch = process.argv.includes("--watch");
  const safety = envInt("COMMITMENT_BLOCK_SAFETY_MARGIN", 6);
  const chunkSize = envInt("COMMITMENT_INDEX_BLOCK_RANGE", 50_000);
  const db = new OrderbookDB(dbPath);

  if (!watch) {
    for (const c of chains) {
      const provider = new JsonRpcProvider(c.rpcUrl);
      const fetcher = makeCommitmentFetcher({
        rpcUrl: c.rpcUrl,
        poolAddress: c.commitmentPoolAddress,
        provider,
      });
      const latest = await provider.getBlockNumber();
      const toBlock = Math.max(0, latest - safety);
      const s = await runCommitmentIndexPass(db, fetcher, {
        chainId: c.chainId,
        poolAddress: c.commitmentPoolAddress,
        deployBlock: c.deployBlock,
        toBlock,
        chunkSize,
      });
      console.log(
        `[commitment-indexer] one-shot chain=${c.chainId}: indexed=${s.indexed} ` +
          `range=[${s.fromBlock},${s.toBlock}]${s.error ? ` error=${s.error}` : ""}`,
      );
    }
    db.close();
    return;
  }

  const ac = new AbortController();
  const shutdown = (sig: string): void => {
    console.log(`[commitment-indexer] received ${sig}; draining and exiting`);
    ac.abort();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const intervalSec = envInt("COMMITMENT_POLL_INTERVAL_SEC", 30);
  console.log(`[commitment-indexer] watch mode, db=${dbPath}, chains=[${chains.map((c) => c.chainId).join(",")}]`);

  await Promise.all(chains.map((c) => {
    const provider = new JsonRpcProvider(c.rpcUrl);
    const fetcher = makeCommitmentFetcher({
      rpcUrl: c.rpcUrl,
      poolAddress: c.commitmentPoolAddress,
      provider,
    });
    console.log(`[commitment-indexer] chain=${c.chainId} @ ${c.rpcUrl}, pool=${c.commitmentPoolAddress}, deployBlock=${c.deployBlock}`);
    return runCommitmentIndexLoop(db, fetcher, {
      chainId: c.chainId,
      poolAddress: c.commitmentPoolAddress,
      deployBlock: c.deployBlock,
      intervalSec,
      blockSafetyMargin: safety,
      chunkSize,
      provider,
      signal: ac.signal,
      onPass: (s) => {
        const parts = [`chain=${c.chainId}`, `indexed=${s.indexed}`, `range=[${s.fromBlock},${s.toBlock}]`];
        if (s.error) parts.push(`error=${s.error}`);
        console.log(`[commitment-indexer] pass: ${parts.join(" ")}`);
      },
    });
  }));
  db.close();
}

main().catch((err) => {
  console.error("[commitment-indexer] fatal:", err);
  process.exit(1);
});
