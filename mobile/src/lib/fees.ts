/**
 * Relay-fee math — shared by TradeScreen preview, HistoryScreen detail,
 * and any future order/claim summary. Circuit/contract enforces
 * totalLocked + fee ≤ sellAmount; every display must match that exact
 * integer division (buyAmount × bps / 10000).
 */
export function computeRelayFeeWei(buyAmountWei: bigint, bps: number): bigint {
  return (buyAmountWei * BigInt(bps)) / 10_000n;
}

export function computeNetBuyWei(buyAmountWei: bigint, bps: number): bigint {
  return buyAmountWei - computeRelayFeeWei(buyAmountWei, bps);
}
