import { describe, expect, it } from "vitest";
import { formatBalanceForDropdown, type TokenBalanceRow } from "../app/lib/useTokenBalances";

function row(partial: Partial<TokenBalanceRow>): TokenBalanceRow {
  return {
    symbol: "T",
    address: "",
    decimals: 18,
    raw: null,
    loading: false,
    error: null,
    isNative: false,
    ...partial,
  };
}

describe("formatBalanceForDropdown", () => {
  it("renders '…' for loading rows", () => {
    expect(formatBalanceForDropdown(row({ loading: true }))).toBe("…");
  });

  it("renders '—' for non-loading rows with no balance", () => {
    expect(formatBalanceForDropdown(row({ raw: null, loading: false }))).toBe("—");
  });

  it("renders whole-number balances without a decimal point", () => {
    expect(
      formatBalanceForDropdown(row({ raw: 10n * 10n ** 18n, decimals: 18 })),
    ).toBe("10");
  });

  it("strips trailing zeros after the decimal", () => {
    // 1.5 ETH expressed in wei
    expect(
      formatBalanceForDropdown(row({ raw: 1_500_000_000_000_000_000n, decimals: 18 })),
    ).toBe("1.5");
  });

  it("caps fractional digits at six with an ellipsis", () => {
    // 18 decimals → seven 1s in the fractional → must truncate.
    expect(
      formatBalanceForDropdown(row({ raw: 1_111_111_111_111_111_111n, decimals: 18 })),
    ).toBe("1.111111…");
  });

  it("handles six-decimal stables (USDC) cleanly", () => {
    // 1_234.56 USDC
    expect(
      formatBalanceForDropdown(row({ raw: 1_234_560_000n, decimals: 6 })),
    ).toBe("1234.56");
  });

  it("renders zero balance as '0' (not '0.')", () => {
    expect(formatBalanceForDropdown(row({ raw: 0n, decimals: 18 }))).toBe("0");
  });
});
