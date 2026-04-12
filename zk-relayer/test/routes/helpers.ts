import express, { Express, Router } from "express";

export function mountRouter(basePath: string, router: Router): Express {
  const app = express();
  app.use(express.json());
  app.use(basePath, router);
  return app;
}

export function makeSubmitterStub(overrides: Partial<Record<string, unknown>> = {}) {
  const provider = {
    getBlockNumber: async () => 12345,
    getBalance: async () => 10n ** 18n,
    getNetwork: async () => ({ chainId: 31337n }),
    ...(overrides.provider as object | undefined),
  };
  const wallet = { address: "0x" + "9".repeat(40), ...(overrides.wallet as object | undefined) };
  return {
    getProvider: () => provider,
    getWallet: () => wallet,
    getAddress: () => wallet.address,
    getCommitmentMerkleProof: async (i: number) => ({ leafIndex: i, siblings: [] }),
    ...overrides,
  } as never;
}

export function makeDbStub(overrides: Partial<Record<string, unknown>> = {}) {
  const meta = new Map<string, string>();
  return {
    getMeta: (k: string) => meta.get(k) ?? null,
    setMeta: (k: string, v: string) => { meta.set(k, v); },
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
  } as never;
}

export function makeOrderbookStub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getOrderCount: () => 0,
    cancelAll: () => 0,
    pendingOrderCount: 0,
    ...overrides,
  } as never;
}
