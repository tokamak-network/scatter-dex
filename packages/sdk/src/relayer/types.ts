/** Relayer info as recorded in the on-chain `RelayerRegistry`. */
export interface RelayerOnChain {
  address: string;
  url: string;
  /** Operator-set display name from the registry. May be the empty
   *  string for legacy entries that registered before the name field
   *  was added. */
  name: string;
  /** Per-trade fee in basis points (100 = 1%). */
  fee: number;
  /** Bond posted to register, in wei. */
  bond: bigint;
  registeredAt: number;
  exitRequestedAt: number;
  active: boolean;
}

/** Optional metadata a relayer publishes via its `/api/info`. We
 *  trust nothing inside `profile`: see `sanitizeProfile`. */
export interface RelayerProfile {
  name?: string;
  description?: string;
  logoUrl?: string;
  contact?: string;
  socialX?: string;
  website?: string;
  updatedAt?: number;
}

/** Live response from a relayer's `/api/info`. */
export interface RelayerApiInfo {
  name: string;
  version: string;
  address: string;
  fee: number;
  orderCount: number;
  settlement: string;
  profile?: RelayerProfile;
}

/** Per-token settled volume (one row per `sell_token`). `totalVolume`
 *  is a wei-string (BigInt-safe) so callers can `BigInt()` it back. */
export interface RelayerSettledVolume {
  sellToken: string;
  count: number;
  totalVolume: string;
}

/** In-memory metrics shape returned alongside DB-derived counters.
 *  Optional because older relayer builds don't compute it. */
export interface RelayerRuntimeMetrics {
  gas: { avgCostEth: number | null; minCostEth: number | null; maxCostEth: number | null; lastCostEth: number | null; totalSpentEth: number };
  settlement: { avgDurationMs: number | null; minDurationMs: number | null; maxDurationMs: number | null; lastDurationMs: number | null; totalCount: number; perMinute: number };
  orders: { submittedPerMinute: number };
  sampleSize: number;
}

/** Public stats from a relayer's `/api/relayer/stats`. Surfaced for
 *  cross-relayer comparison (leaderboard performance columns).
 *  - `avgSettleTimeMs` is null when there are no confirmed settlements
 *    in the window (the SQL AVG returns null).
 *  - `uptimeSince` is null when the `started_at` meta key is missing
 *    or unparseable — independent of settlement count. */
export interface RelayerStatsResponse {
  address: string;
  totalOrders: number;
  settledOrders: number;
  successRate: number;
  crossRelayerSettled: number;
  totalTradeOffers: number;
  settledTradeOffers: number;
  avgSettleTimeMs: number | null;
  uptimeSince: number | null;
  pendingOrders: number;
  settledVolume?: RelayerSettledVolume[];
  metrics?: RelayerRuntimeMetrics;
}

/** Combined view: on-chain registry data + live `/api/info` probe.
 *  `api` is undefined when the relayer is offline / unreachable.
 *  `stats` is undefined when the stats probe failed (older relayer
 *  build, network error, or feature not enabled). */
export interface RelayerInfo extends RelayerOnChain {
  api?: RelayerApiInfo;
  stats?: RelayerStatsResponse;
  online: boolean;
}

/** A single submitted order as the relayer reports it. */
export interface RelayerOrder {
  maker: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  nonce: string;
  maxFee: string;
  expiry: string;
  feeMode?: string;
  status: string;
  submittedAt: number;
  settleTxHash?: string;
  claims?: { claimHash: string; amount: string; releaseDelay: string }[];
}

export interface OrderHistoryResponse {
  orders: RelayerOrder[];
  total: number;
  limit: number;
  offset: number;
}

/** Fee modes the relayer accepts on `submitOrder`. */
export type FeeMode = "cover_taker";

/** Order payload as the relayer expects it on submit. */
export interface OrderData {
  maker: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  maxFee: number;
  expiry: number;
  nonce: number;
  claims: { claimHash: string; amount: string; releaseDelay: number }[];
}
