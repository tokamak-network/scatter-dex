// Token pair key: "0xTokenA-0xTokenB" (lowercase, sorted)
export function pairKey(tokenA, tokenB) {
    const [a, b] = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort();
    return `${a}-${b}`;
}
const MAX_CLAIMS = 10;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
// Parse and validate order from JSON (string amounts → BigInt)
export function parseOrder(raw) {
    if (typeof raw !== "object" || raw === null)
        throw new Error("invalid order");
    const maker = raw.maker;
    const sellToken = raw.sellToken;
    const buyToken = raw.buyToken;
    if (!ADDRESS_RE.test(maker))
        throw new Error("invalid maker address");
    if (!ADDRESS_RE.test(sellToken))
        throw new Error("invalid sellToken address");
    if (!ADDRESS_RE.test(buyToken))
        throw new Error("invalid buyToken address");
    if (sellToken.toLowerCase() === buyToken.toLowerCase())
        throw new Error("sellToken == buyToken");
    let sellAmount, buyAmount, maxFee, expiry, nonce;
    try {
        sellAmount = BigInt(raw.sellAmount);
        buyAmount = BigInt(raw.buyAmount);
        maxFee = BigInt(raw.maxFee);
        expiry = BigInt(raw.expiry);
        nonce = BigInt(raw.nonce);
    }
    catch {
        throw new Error("invalid numeric field");
    }
    if (sellAmount <= 0n)
        throw new Error("sellAmount must be > 0");
    if (buyAmount <= 0n)
        throw new Error("buyAmount must be > 0");
    if (maxFee < 0n)
        throw new Error("maxFee must be >= 0");
    if (expiry < 0n)
        throw new Error("expiry must be >= 0");
    if (nonce < 0n)
        throw new Error("nonce must be >= 0");
    const claims = raw.claims;
    if (!Array.isArray(claims) || claims.length === 0 || claims.length > MAX_CLAIMS) {
        throw new Error(`claims must be 1-${MAX_CLAIMS}`);
    }
    return {
        maker,
        sellToken,
        buyToken,
        sellAmount,
        buyAmount,
        maxFee,
        expiry,
        nonce,
        claims: claims.map((c) => {
            if (!BYTES32_RE.test(c.claimHash))
                throw new Error("invalid claimHash");
            let amount, releaseDelay;
            try {
                amount = BigInt(c.amount);
                releaseDelay = BigInt(c.releaseDelay);
            }
            catch {
                throw new Error("invalid claim numeric field");
            }
            if (amount <= 0n)
                throw new Error("claim amount must be > 0");
            if (releaseDelay < 0n)
                throw new Error("releaseDelay must be >= 0");
            return {
                claimHash: c.claimHash,
                amount,
                releaseDelay,
            };
        }),
    };
}
// EIP-712 typed data for order signing/verification
export const EIP712_DOMAIN = {
    name: "ScatterSettlement",
    version: "1",
};
export const EIP712_TYPES = {
    ClaimInfo: [
        { name: "claimHash", type: "bytes32" },
        { name: "amount", type: "uint256" },
        { name: "releaseDelay", type: "uint256" },
    ],
    Order: [
        { name: "maker", type: "address" },
        { name: "sellToken", type: "address" },
        { name: "buyToken", type: "address" },
        { name: "sellAmount", type: "uint256" },
        { name: "buyAmount", type: "uint256" },
        { name: "maxFee", type: "uint256" },
        { name: "expiry", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "claims", type: "ClaimInfo[]" },
    ],
};
