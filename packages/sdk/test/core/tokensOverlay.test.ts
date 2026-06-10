import { describe, it, expect } from "vitest";
import {
  curatedErc20View,
  overlayOnchainTokens,
  type TokenInfo,
} from "../../src/core/tokens";

const ZERO = "0x0000000000000000000000000000000000000000";
const WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const TON = "0xa30fe40285B8f5c0457DbC3B7C8A280373c40044";
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

// Curated list as an app ships it: native ETH + ERC-20s, all with the
// ZERO sentinel address (env addresses unset) but correct decimals.
const curated: TokenInfo[] = [
  { address: ZERO, symbol: "ETH", decimals: 18, isNative: true },
  { address: ZERO, symbol: "USDC", decimals: 6, isNative: false },
  { address: ZERO, symbol: "TON", decimals: 18, isNative: false },
];

// On-chain whitelist (what fetchWhitelistedTokens returns): real
// addresses, native ETH appears as "WETH" sharing the WETH address.
const onchain: TokenInfo[] = [
  { address: WETH, symbol: "WETH", decimals: 18, isNative: false },
  { address: USDC, symbol: "USDC", decimals: 6, isNative: false },
  { address: TON, symbol: "TON", decimals: 18, isNative: false },
];

describe("curatedErc20View", () => {
  it("relabels the native ETH entry to non-native WETH, leaves the rest", () => {
    const view = curatedErc20View(curated);
    expect(view[0]).toMatchObject({ symbol: "WETH", isNative: false });
    expect(view[1]).toEqual(curated[1]);
    expect(view[2]).toEqual(curated[2]);
  });

  it("does not mutate the input", () => {
    const copy = curated.map((t) => ({ ...t }));
    curatedErc20View(curated);
    expect(curated).toEqual(copy);
  });
});

describe("overlayOnchainTokens", () => {
  it("overlays on-chain address + decimals while preserving curated order/metadata", () => {
    const out = overlayOnchainTokens(curated, onchain, WETH);
    // Native ETH keeps symbol "ETH" + isNative, takes the on-chain WETH address.
    expect(out[0]).toMatchObject({ symbol: "ETH", isNative: true, address: WETH, decimals: 18 });
    // ERC-20s match by symbol and pick up the real address.
    expect(out[1]).toMatchObject({ symbol: "USDC", address: USDC, decimals: 6 });
    expect(out[2]).toMatchObject({ symbol: "TON", address: TON, decimals: 18 });
  });

  it("keeps a curated token that the whitelist omits (zero address)", () => {
    const out = overlayOnchainTokens(curated, [onchain[0]!], WETH); // only WETH on-chain
    expect(out[1]).toEqual(curated[1]); // USDC untouched → still ZERO
    expect(out[2]).toEqual(curated[2]); // TON untouched → still ZERO
  });

  it("falls native ETH back to the env WETH address when none is whitelisted", () => {
    const out = overlayOnchainTokens(curated, [onchain[1]!, onchain[2]!], WETH); // no WETH on-chain
    // wethAddress is configured → native takes it so callers read a usable address.
    expect(out[0]).toMatchObject({ symbol: "ETH", isNative: true, address: WETH });
  });

  it("leaves native ETH at its curated address when the env WETH is unconfigured too", () => {
    const out = overlayOnchainTokens(curated, [onchain[1]!, onchain[2]!], ZERO); // no on-chain + zero env
    expect(out[0]).toEqual(curated[0]); // nothing usable → untouched
  });

  it("matches symbols case-insensitively", () => {
    const lower: TokenInfo[] = [{ address: USDC, symbol: "usdc", decimals: 6, isNative: false }];
    const out = overlayOnchainTokens(curated, lower, WETH);
    expect(out[1]).toMatchObject({ address: USDC, decimals: 6 });
  });
});
