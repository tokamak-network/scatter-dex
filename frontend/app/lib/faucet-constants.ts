// Shared faucet drip amounts — imported by both the /api/faucet route
// and the /faucet UI so the button label can never drift from what the
// server actually sends.

export const ETH_DRIP_WHOLE = 10;
export const USDC_DRIP_WHOLE = 10_000n;

export const FAUCET_LABEL = `Drip ${ETH_DRIP_WHOLE} ETH + ${Number(USDC_DRIP_WHOLE).toLocaleString()} USDC`;
