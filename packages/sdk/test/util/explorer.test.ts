import { describe, expect, it } from "vitest";
import {
  buildExplorerUrl,
  buildExplorerTxUrl,
  buildExplorerAddressUrl,
  buildExplorerBlockUrl,
} from "../../src/util/explorer";

const ETHERSCAN = "https://etherscan.io";
const PROXY_WITH_SUBPATH = "https://explorer.io/eth-mainnet/";
const TX = "0xabc123";
const ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("buildExplorerTxUrl", () => {
  it("returns null when base is missing", () => {
    expect(buildExplorerTxUrl(undefined, TX)).toBeNull();
    expect(buildExplorerTxUrl(null, TX)).toBeNull();
    expect(buildExplorerTxUrl("", TX)).toBeNull();
  });

  it("returns null when value is empty", () => {
    expect(buildExplorerTxUrl(ETHERSCAN, "")).toBeNull();
  });

  it("returns null for unparseable base", () => {
    expect(buildExplorerTxUrl("not a url", TX)).toBeNull();
  });

  it("rejects javascript: scheme", () => {
    // The main security guarantee: a hostile env can't land a
    // javascript: URL in an <a href>.
    expect(buildExplorerTxUrl("javascript:alert(1)", TX)).toBeNull();
  });

  it("rejects data: scheme", () => {
    expect(buildExplorerTxUrl("data:text/html,<script>", TX)).toBeNull();
  });

  it("rejects ftp: scheme", () => {
    expect(buildExplorerTxUrl("ftp://files.example.com", TX)).toBeNull();
  });

  it("accepts plain https base", () => {
    expect(buildExplorerTxUrl(ETHERSCAN, TX)).toBe(`${ETHERSCAN}/tx/${TX}`);
  });

  it("accepts plain http base", () => {
    expect(buildExplorerTxUrl("http://localhost:8545", TX)).toBe(
      `http://localhost:8545/tx/${TX}`,
    );
  });

  it("normalises trailing slash on base", () => {
    expect(buildExplorerTxUrl(`${ETHERSCAN}/`, TX)).toBe(`${ETHERSCAN}/tx/${TX}`);
  });

  it("preserves sub-path on the base", () => {
    expect(buildExplorerTxUrl(PROXY_WITH_SUBPATH, TX)).toBe(
      `https://explorer.io/eth-mainnet/tx/${TX}`,
    );
  });

  it("url-encodes the value segment", () => {
    // Defence against an unlikely caller passing a value with
    // path-sensitive characters.
    const url = buildExplorerTxUrl(ETHERSCAN, "abc/def?q=1");
    expect(url).toBe(`${ETHERSCAN}/tx/abc%2Fdef%3Fq%3D1`);
  });
});

describe("buildExplorerAddressUrl", () => {
  it("composes /address/ paths", () => {
    expect(buildExplorerAddressUrl(ETHERSCAN, ADDR)).toBe(
      `${ETHERSCAN}/address/${ADDR}`,
    );
  });

  it("inherits the same scheme guards", () => {
    expect(buildExplorerAddressUrl("javascript:alert(1)", ADDR)).toBeNull();
  });
});

describe("buildExplorerBlockUrl", () => {
  it("accepts string blockNumber", () => {
    expect(buildExplorerBlockUrl(ETHERSCAN, "12345")).toBe(`${ETHERSCAN}/block/12345`);
  });

  it("accepts number blockNumber", () => {
    expect(buildExplorerBlockUrl(ETHERSCAN, 12345)).toBe(`${ETHERSCAN}/block/12345`);
  });

  it("accepts bigint blockNumber", () => {
    expect(buildExplorerBlockUrl(ETHERSCAN, 12345n)).toBe(`${ETHERSCAN}/block/12345`);
  });
});

describe("buildExplorerUrl (segment dispatcher)", () => {
  it("supports the three segments", () => {
    expect(buildExplorerUrl(ETHERSCAN, "tx", TX)).toContain("/tx/");
    expect(buildExplorerUrl(ETHERSCAN, "address", ADDR)).toContain("/address/");
    expect(buildExplorerUrl(ETHERSCAN, "block", "1")).toContain("/block/");
  });
});
