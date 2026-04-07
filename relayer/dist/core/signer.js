import { ethers } from "ethers";
import { EIP712_DOMAIN, EIP712_TYPES } from "../types/order.js";
export function verifyOrderSignature(order, signature, chainId, contractAddress) {
    const domain = {
        ...EIP712_DOMAIN,
        chainId,
        verifyingContract: contractAddress,
    };
    const orderValue = {
        maker: order.maker,
        sellToken: order.sellToken,
        buyToken: order.buyToken,
        sellAmount: order.sellAmount,
        buyAmount: order.buyAmount,
        maxFee: order.maxFee,
        expiry: order.expiry,
        nonce: order.nonce,
        claims: order.claims.map((c) => ({
            claimHash: c.claimHash,
            amount: c.amount,
            releaseDelay: c.releaseDelay,
        })),
    };
    const recovered = ethers.verifyTypedData(domain, EIP712_TYPES, orderValue, signature);
    return recovered;
}
export function isValidSignature(order, signature, chainId, contractAddress) {
    try {
        const recovered = verifyOrderSignature(order, signature, chainId, contractAddress);
        return recovered.toLowerCase() === order.maker.toLowerCase();
    }
    catch {
        return false;
    }
}
