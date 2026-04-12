import express, { Express, Router } from "express";
import type { PrivateSubmitter } from "../../src/core/private-submitter.js";
import type { PrivateOrderDB } from "../../src/core/db.js";
import type { PrivateOrderbook } from "../../src/core/orderbook.js";

export function mountRouter(basePath: string, router: Router): Express {
  const app = express();
  app.use(express.json());
  app.use(basePath, router);
  return app;
}

// Minimal shape of each stub — a typed `overrides` catches key typos that a
// `Record<string, unknown>` would silently accept. The final `as unknown as X`
// casts to the full class type so route factories accept the stub.

type SubmitterStub = {
  getProvider: () => { getBlockNumber: () => Promise<number>; getBalance: () => Promise<bigint>; getNetwork: () => Promise<{ chainId: bigint }> };
  getWallet: () => { address: string };
  getAddress: () => string;
  getCommitmentMerkleProof: (i: number) => Promise<unknown>;
};

export function makeSubmitterStub(overrides: Partial<SubmitterStub> = {}): PrivateSubmitter {
  const provider = {
    getBlockNumber: async () => 12345,
    getBalance: async () => 10n ** 18n,
    getNetwork: async () => ({ chainId: 31337n }),
  };
  const wallet = { address: "0x" + "9".repeat(40) };
  const stub: SubmitterStub = {
    getProvider: () => provider,
    getWallet: () => wallet,
    getAddress: () => wallet.address,
    getCommitmentMerkleProof: async (i: number) => ({ leafIndex: i, siblings: [] }),
    ...overrides,
  };
  return stub as unknown as PrivateSubmitter;
}

type DbStub = {
  getMeta: (k: string) => string | null;
  setMeta: (k: string, v: string) => void;
  getRelayerStats: () => { totalOrders: number; settledOrders: number; successRate: number; crossRelayerSettled: number; avgSettleTimeMs: number; uptimeSince: number };
  getSettledVolume: () => Array<{ sellToken: string; count: number; totalVolume: string }>;
  getTradeOffers: (limit?: number, offset?: number) => unknown[];
  getPendingTxs: () => unknown[];
  loadPendingAuthorizeOrders: () => unknown[];
  saveAuthorizeOrder: (...args: unknown[]) => void;
  updateAuthorizeOrderStatus: (...args: unknown[]) => void;
};

export function makeDbStub(overrides: Partial<DbStub> = {}): PrivateOrderDB {
  const meta = new Map<string, string>();
  const stub: DbStub = {
    getMeta: (k) => meta.get(k) ?? null,
    setMeta: (k, v) => { meta.set(k, v); },
    getRelayerStats: () => ({
      totalOrders: 0, settledOrders: 0, successRate: 0,
      crossRelayerSettled: 0, avgSettleTimeMs: 0, uptimeSince: Date.now(),
    }),
    getSettledVolume: () => [],
    getTradeOffers: () => [],
    getPendingTxs: () => [],
    loadPendingAuthorizeOrders: () => [],
    saveAuthorizeOrder: () => {},
    updateAuthorizeOrderStatus: () => {},
    ...overrides,
  };
  return stub as unknown as PrivateOrderDB;
}

type OrderbookStub = {
  getOrderCount: () => number;
  cancelAll: () => number;
  pendingOrderCount: number;
};

export function makeOrderbookStub(overrides: Partial<OrderbookStub> = {}): PrivateOrderbook {
  const stub: OrderbookStub = {
    getOrderCount: () => 0,
    cancelAll: () => 0,
    pendingOrderCount: 0,
    ...overrides,
  };
  return stub as unknown as PrivateOrderbook;
}
