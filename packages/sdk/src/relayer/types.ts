/** Relayer info as recorded in the on-chain `RelayerRegistry`. */
export interface RelayerOnChain {
  /** 0-based index in the registry's `relayerList` — the relayer's
   *  stable on-chain id, assigned at first registration. */
  id: number;
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
  /** Address of the on-chain CommitmentPool the relayer reads from.
   *  Mirrors `commitmentPool` in `zk-relayer/src/routes/info.ts` —
   *  the older single `settlement` field was inaccurate (the response
   *  has always returned the two contracts separately). */
  commitmentPool: string;
  /** Address of the PrivateSettlement contract the relayer submits to. */
  privateSettlement: string;
  profile?: RelayerProfile;
  /** Per-token gasless-transfer fee policy. Symbol → decimal-string
   *  amount in token-units, e.g.
   *  `{ USDC: "0.10", USDT: "0.10", TON: "1.0" }`. Empty / missing
   *  when the relayer hasn't configured a policy, in which case its
   *  `/api/transfer-7702/relay` rejects with `token not supported`. */
  gasless_fees?: Record<string, string>;
  /** Per-recipient claim-gasless reserve policy. Symbol → decimal-
   *  string amount in token-units, e.g.
   *  `{ USDC: "0.05", USDT: "0.05", TON: "0.5" }`. Multiplied by the
   *  run's recipient count and added to the bps service fee at
   *  settle time. Empty / missing when the platform hasn't published
   *  a policy — operator UI falls back to legacy service-fee-only
   *  behavior. */
  claim_fees?: Record<string, string>;
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
  /** Per-token fee revenue across this relayer's lifetime. Sum of
   *  fee_history rows grouped by token, exposed publicly so the
   *  leaderboard can rank "who earned the most" without each
   *  visitor needing peer admin keys. Same shape as the operator
   *  analytics page's `/history/fees` aggregate. */
  feeTotals?: Array<{ token: string; count: number; totalWei: string }>;
  metrics?: RelayerRuntimeMetrics;
  /** Per-app (Pay = scatterDirectAuth, Pro = settleAuth) breakdown of
   *  counts / volume / fees. Optional: older relayers omit this field
   *  and consumers degrade to the aggregate view for that row. */
  byApp?: {
    pay: RelayerStatsByApp;
    pro: RelayerStatsByApp;
  };
}

/** Per-app subset of RelayerStatsResponse. Mirrors the aggregate
 *  fields the leaderboard ranks on (orders / volume / fees) so the
 *  segmented control can re-rank using the same comparator logic. */
export interface RelayerStatsByApp {
  totalOrders: number;
  settledOrders: number;
  settledVolume?: RelayerSettledVolume[];
  feeTotals?: Array<{ token: string; count: number; totalWei: string }>;
}

/** One of the two app flows the relayer surfaces in `byApp`:
 *  Pay maps to `scatterDirectAuth` (single-party direct payouts) and
 *  Pro maps to `settleAuth` (half-proof order matches). Callers
 *  model the "All" / aggregate view at the UI layer, not via this
 *  type — the aggregate stats already live on `RelayerStatsResponse`
 *  itself, so no `null` member is needed here. */
export type AppSegment = "pay" | "pro";

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
