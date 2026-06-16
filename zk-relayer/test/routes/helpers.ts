import express, { Express, Router } from "express";
import request from "supertest";
import { ethers } from "ethers";
import type { PrivateSubmitter } from "../../src/core/private-submitter.js";
import type { PrivateOrderDB } from "../../src/core/db.js";

export function mountRouter(basePath: string, router: Router): Express {
  const app = express();
  app.use(express.json());
  app.use(basePath, router);
  return app;
}

// Canned operator wallet (a publicly-known anvil dev key, in-process
// signing only). `makeSubmitterStub` reports this as the node's operator
// address, so a SIWE challenge signed by `TEST_OPERATOR` authenticates —
// mirroring production, where admin == the node's own operator wallet.
export const TEST_OPERATOR_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const TEST_OPERATOR = new ethers.Wallet(TEST_OPERATOR_PK);

/** Mint a SIWE session bearer against a freshly-built admin app, signing
 *  the challenge with the node's operator wallet. Returns the
 *  `Authorization` header value (`Bearer <token>`). Must be called on the
 *  same app instance the test then hits — `createAdminRoutes` publishes its
 *  SIWE handle as the process singleton on build, so the most-recently-built
 *  app owns the active session store. */
export async function siweLogin(app: Express, basePath = "/api/admin"): Promise<string> {
  const ch = await request(app).get(`${basePath}/challenge`);
  if (ch.status !== 200) {
    throw new Error(`GET ${basePath}/challenge failed (${ch.status}): ${JSON.stringify(ch.body)}`);
  }
  const { nonce, message } = ch.body as { nonce: string; message: string };
  const signature = await TEST_OPERATOR.signMessage(message);
  const sess = await request(app)
    .post(`${basePath}/session`)
    .send({ nonce, message, signature });
  if (!sess.body?.token) {
    throw new Error(`siweLogin failed (${sess.status}): ${JSON.stringify(sess.body)}`);
  }
  return `Bearer ${sess.body.token}`;
}

// Minimal shape of each stub — a typed `overrides` catches key typos that a
// `Record<string, unknown>` would silently accept. The final `as unknown as X`
// casts to the full class type so route factories accept the stub.

type SubmitterStub = {
  getProvider: () => { getBlockNumber: () => Promise<number>; getBalance: () => Promise<bigint>; getNetwork: () => Promise<{ chainId: bigint }>; getTransaction: (hash: string) => Promise<{ data: string; from: string; to: string | null; blockNumber: number | null } | null> };
  getWallet: () => { address: string; provider?: unknown };
  getAddress: () => string;
  getCommitmentMerkleProof: (i: number) => Promise<unknown>;
  submitClaim: (params: unknown) => Promise<string>;
  claimVaultFee: (vaultAddress: string, token: string) => Promise<string>;
  sendWithTxLock: <T>(fn: () => Promise<T>) => Promise<T>;
};

export function makeSubmitterStub(overrides: Partial<SubmitterStub> = {}): PrivateSubmitter {
  const provider = {
    getBlockNumber: async () => 12345,
    getBalance: async () => 10n ** 18n,
    getNetwork: async () => ({ chainId: 31337n }),
    getTransaction: async (_hash: string) => null,
  };
  const wallet = { address: TEST_OPERATOR.address, provider };
  const stub: SubmitterStub = {
    getProvider: () => provider,
    getWallet: () => wallet,
    getAddress: () => wallet.address,
    getCommitmentMerkleProof: async (i: number) => ({ leafIndex: i, siblings: [] }),
    submitClaim: async () => "0x" + "f".repeat(64),
    claimVaultFee: async () => "0x" + "e".repeat(64),
    sendWithTxLock: <T,>(fn: () => Promise<T>) => fn(),
    ...overrides,
  };
  return stub as unknown as PrivateSubmitter;
}

type DbStub = {
  getMeta: (k: string) => string | null;
  setMeta: (k: string, v: string) => void;
  getRelayerStats: () => { totalOrders: number; settledOrders: number; successRate: number; crossRelayerSettled: number; totalTradeOffers: number; settledTradeOffers: number; avgSettleTimeMs: number | null; uptimeSince: number | null };
  getSettledVolume: () => Array<{ sellToken: string; count: number; totalVolume: string }>;
  getFeeTotals: (since?: number, until?: number) => Array<{ token: string; count: number; totalWei: string }>;
  getStatsByApp: () => {
    pay: { totalOrders: number; settledOrders: number; settledVolume: Array<{ sellToken: string; count: number; totalVolume: string }>; feeTotals: Array<{ token: string; count: number; totalWei: string }> };
    pro: { totalOrders: number; settledOrders: number; settledVolume: Array<{ sellToken: string; count: number; totalVolume: string }>; feeTotals: Array<{ token: string; count: number; totalWei: string }> };
  };
  getTradeOffers: (limit?: number, offset?: number) => unknown[];
  getPendingTxs: () => unknown[];
  loadPendingAuthorizeOrders: () => unknown[];
  saveAuthorizeOrder: (...args: unknown[]) => void;
  updateAuthorizeOrderStatus: (...args: unknown[]) => void;
  hasSettledClaimsRoot: (root: string) => boolean;
  iterateSettlementHistoryRange: (opts: { since: number; until: number; type?: string; status?: string }) => Iterable<unknown>;
};

export function makeDbStub(overrides: Partial<DbStub> = {}): PrivateOrderDB {
  const meta = new Map<string, string>();
  const stub: DbStub = {
    getMeta: (k) => meta.get(k) ?? null,
    setMeta: (k, v) => { meta.set(k, v); },
    getRelayerStats: () => ({
      totalOrders: 0, settledOrders: 0, successRate: 0,
      crossRelayerSettled: 0, totalTradeOffers: 0, settledTradeOffers: 0,
      avgSettleTimeMs: 0, uptimeSince: Date.now(),
    }),
    getSettledVolume: () => [],
    getFeeTotals: () => [],
    getStatsByApp: () => ({
      pay: { totalOrders: 0, settledOrders: 0, settledVolume: [], feeTotals: [] },
      pro: { totalOrders: 0, settledOrders: 0, settledVolume: [], feeTotals: [] },
    }),
    getTradeOffers: () => [],
    getPendingTxs: () => [],
    loadPendingAuthorizeOrders: () => [],
    saveAuthorizeOrder: () => {},
    updateAuthorizeOrderStatus: () => {},
    hasSettledClaimsRoot: () => false,
    iterateSettlementHistoryRange: () => [],
    ...overrides,
  };
  return stub as unknown as PrivateOrderDB;
}

// `makeOrderbookStub` and `OrderbookStub` were retired alongside the
// PrivateOrderbook class (tracker #29). Tests that were using them have
// been removed; authorize-orders has its own in-memory store accessed
// directly via the `authorizeOrders` Map export.
