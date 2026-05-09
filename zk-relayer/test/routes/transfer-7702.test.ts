import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { ethers } from "ethers";
import { createTransfer7702Routes } from "../../src/routes/transfer-7702.js";
import { mountRouter, makeSubmitterStub } from "./helpers.js";

const DELEGATE = "0x" + "a".repeat(40);
const STEALTH = "0x" + "b".repeat(40);
const TARGET = "0x" + "c".repeat(40);
const TX_HASH = "0x" + "f".repeat(64);
const SIG_65_BYTES = "0x" + "1".repeat(130);
const HEX_32 = "0x" + "2".repeat(64);
const RELAYER_ADDR = "0x" + "9".repeat(40);
const USDC_ADDR = "0x" + "d".repeat(40);

const TOKEN_ENTRIES = [
  { addr: USDC_ADDR.toLowerCase(), symbol: "USDC", decimals: 6 },
];
const GASLESS_FEES = { USDC: "0.1" };

const TRANSFER_IFACE = new ethers.Interface([
  "function transfer(address to, uint256 amount)",
]);

/** Build an ERC20.transfer call to the relayer for the given fee
 *  (in token-units) — this is what the contract sees in the batch. */
function feeCall(amountDecimal: string) {
  const wei = ethers.parseUnits(amountDecimal, 6);
  return {
    target: USDC_ADDR,
    value: "0",
    data: TRANSFER_IFACE.encodeFunctionData("transfer", [RELAYER_ADDR, wei]),
  };
}

// Far-future unix-second timestamp — keeps existing tests immune to
// the deadline preflight added in v2 (only the dedicated expiry
// tests override this).
const FAR_FUTURE = String(Math.floor(Date.now() / 1000) + 86_400);

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    stealthAddress: STEALTH,
    // Default: a single in-batch fee transfer that meets the policy.
    // Tests that exercise the fee-validation path override `calls`.
    calls: [feeCall("0.1")],
    deadline: FAR_FUTURE,
    signature: SIG_65_BYTES,
    authorization: {
      address: DELEGATE,
      chainId: "31337",
      nonce: "0",
      signature: { r: HEX_32, s: HEX_32, yParity: 0 },
    },
    ...overrides,
  };
}

function makeStubWithSendTx(sendTransaction: (req: unknown) => Promise<{ hash: string }>) {
  return makeSubmitterStub({
    // Spy-friendly wallet: tests assert the relayer called
    // sendTransaction with the right type/authorizationList shape.
    getWallet: () => ({ address: RELAYER_ADDR, sendTransaction } as never),
  });
}

const ROUTE_OPTS = {
  stealthTransferAccountAddress: DELEGATE,
  tokenEntries: TOKEN_ENTRIES,
  gaslessFees: GASLESS_FEES,
};

describe("/api/transfer-7702", () => {
  it("POST /relay submits a type-4 tx and returns the hash", async () => {
    const sendTransaction = vi.fn(async () => ({ hash: TX_HASH }));
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(
        makeStubWithSendTx(sendTransaction),
        ROUTE_OPTS,
      ),
    );

    const res = await request(app).post("/api/transfer-7702/relay").send(validBody());
    expect(res.status).toBe(202);
    expect(res.body.txHash).toBe(TX_HASH);

    expect(sendTransaction).toHaveBeenCalledOnce();
    const arg = sendTransaction.mock.calls[0][0] as {
      type: number;
      to: string;
      authorizationList: { address: string; chainId: bigint; nonce: bigint }[];
    };
    expect(arg.type).toBe(4);
    expect(arg.to).toBe(STEALTH);
    expect(arg.authorizationList).toHaveLength(1);
    expect(arg.authorizationList[0].address).toBe(DELEGATE);
    // BigInts survive the round-trip — guards against accidentally
    // passing strings into ethers, which would later coerce wrong.
    expect(typeof arg.authorizationList[0].chainId).toBe("bigint");
    expect(typeof arg.authorizationList[0].nonce).toBe("bigint");
  });

  it("rejects an authorization for an unauthorized delegate", async () => {
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(
        makeStubWithSendTx(async () => ({ hash: TX_HASH })),
        ROUTE_OPTS,
      ),
    );

    const body = validBody({
      authorization: {
        address: "0x" + "d".repeat(40), // attacker-controlled delegate
        chainId: "31337",
        nonce: "0",
        signature: { r: HEX_32, s: HEX_32, yParity: 0 },
      },
    });

    const res = await request(app).post("/api/transfer-7702/relay").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unauthorized delegate/i);
  });

  it("rejects an authorization for a different chainId", async () => {
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(
        makeStubWithSendTx(async () => ({ hash: TX_HASH })),
        ROUTE_OPTS,
      ),
    );

    const body = validBody({
      authorization: {
        address: DELEGATE,
        chainId: "1", // mainnet auth replayed on the test chain (31337)
        nonce: "0",
        signature: { r: HEX_32, s: HEX_32, yParity: 0 },
      },
    });

    const res = await request(app).post("/api/transfer-7702/relay").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/chainId mismatch/i);
  });

  it("returns 400 on a malformed body", async () => {
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(
        makeStubWithSendTx(async () => ({ hash: TX_HASH })),
        ROUTE_OPTS,
      ),
    );

    // Missing `signature` field
    const res = await request(app)
      .post("/api/transfer-7702/relay")
      .send({ stealthAddress: STEALTH, calls: [], authorization: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid body/i);
  });

  it("classifies upstream insufficient-funds errors without leaking RPC details", async () => {
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(
        makeStubWithSendTx(async () => {
          // ethers can include the RPC URL (which may carry an API
          // key) in connection errors — verify we don't echo it.
          throw new Error("insufficient funds for gas at https://mainnet.infura.io/v3/SECRETKEY");
        }),
        ROUTE_OPTS,
      ),
    );

    const res = await request(app).post("/api/transfer-7702/relay").send(validBody());
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("broadcast failed");
    expect(res.body.reason).toBe("insufficient relayer balance");
    expect(res.body.reason).not.toMatch(/SECRETKEY|infura/i);
  });

  it("falls back to a generic reason for unrecognised broadcast errors", async () => {
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(
        makeStubWithSendTx(async () => {
          throw new Error("could not detect network (event=\"noNetwork\", url=\"https://rpc.example/SECRET\")");
        }),
        ROUTE_OPTS,
      ),
    );

    const res = await request(app).post("/api/transfer-7702/relay").send(validBody());
    expect(res.status).toBe(500);
    expect(res.body.reason).toBe("internal error");
    expect(res.body.reason).not.toMatch(/SECRET|rpc\.example/);
  });

  it("rejects an empty calls array", async () => {
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(
        makeStubWithSendTx(async () => ({ hash: TX_HASH })),
        ROUTE_OPTS,
      ),
    );

    const res = await request(app).post("/api/transfer-7702/relay").send(validBody({ calls: [] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid body/i);
  });

  it("rejects a calls array over the cap (>16)", async () => {
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(
        makeStubWithSendTx(async () => ({ hash: TX_HASH })),
        ROUTE_OPTS,
      ),
    );

    const tooMany = Array.from({ length: 17 }, () => ({
      target: TARGET,
      value: "0",
      data: "0x",
    }));
    const res = await request(app).post("/api/transfer-7702/relay").send(validBody({ calls: tooMany }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid body/i);
  });

  it("matches the configured delegate case-insensitively", async () => {
    const sendTransaction = vi.fn(async () => ({ hash: TX_HASH }));
    // Configure with checksummed address; user supplies lowercased.
    const checksummed = "0x" + "Aa".repeat(20);
    const lowercased = checksummed.toLowerCase();
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(
        makeStubWithSendTx(sendTransaction),
        { ...ROUTE_OPTS, stealthTransferAccountAddress: checksummed },
      ),
    );

    const body = validBody({
      authorization: {
        address: lowercased,
        chainId: "31337",
        nonce: "0",
        signature: { r: HEX_32, s: HEX_32, yParity: 0 },
      },
    });
    const res = await request(app).post("/api/transfer-7702/relay").send(body);
    expect(res.status).toBe(202);
    expect(sendTransaction).toHaveBeenCalledOnce();
  });

  it("rejects a batch that pays no fee to the relayer", async () => {
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(
        makeStubWithSendTx(async () => ({ hash: TX_HASH })),
        ROUTE_OPTS,
      ),
    );
    // Single transfer to a third party — no fee call to relayer.
    const recipientCall = {
      target: USDC_ADDR,
      value: "0",
      data: TRANSFER_IFACE.encodeFunctionData("transfer", [
        "0x" + "5".repeat(40),
        ethers.parseUnits("100", 6),
      ]),
    };
    const res = await request(app)
      .post("/api/transfer-7702/relay")
      .send(validBody({ calls: [recipientCall] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no fee paid/i);
  });

  it("rejects a fee below the published policy", async () => {
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(
        makeStubWithSendTx(async () => ({ hash: TX_HASH })),
        ROUTE_OPTS,
      ),
    );
    // Policy is 0.1 USDC; submit a 0.05 USDC fee.
    const res = await request(app)
      .post("/api/transfer-7702/relay")
      .send(validBody({ calls: [feeCall("0.05")] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fee below policy/i);
    expect(res.body.required).toBe("0.1");
    expect(res.body.paid).toBe("0.05");
  });

  it("rejects a fee paid in a token completely outside the relayer's TOKEN_LIST", async () => {
    // Different from the "in tokenEntries but no policy" case —
    // here the address isn't even in the operator's TOKEN_LIST. A
    // pre-fix bug would silently accept this because the loop
    // `continue`d past unknown tokens, bypassing the floor check.
    const RANDO_ADDR = "0x" + "f".repeat(40);
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(
        makeStubWithSendTx(async () => ({ hash: TX_HASH })),
        ROUTE_OPTS,
      ),
    );
    const randoFeeCall = {
      target: RANDO_ADDR,
      value: "0",
      data: TRANSFER_IFACE.encodeFunctionData("transfer", [
        RELAYER_ADDR,
        ethers.parseUnits("9999", 6),
      ]),
    };
    const res = await request(app)
      .post("/api/transfer-7702/relay")
      .send(validBody({ calls: [randoFeeCall] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("token not supported");
    // Reports the raw address (not a symbol) since it isn't in
    // tokenEntries to look up.
    expect(res.body.token.toLowerCase()).toBe(RANDO_ADDR.toLowerCase());
  });

  it("rejects a fee in a token the relayer hasn't published a policy for", async () => {
    const ETH_ADDR = "0x" + "e".repeat(40);
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(
        makeStubWithSendTx(async () => ({ hash: TX_HASH })),
        {
          ...ROUTE_OPTS,
          tokenEntries: [
            ...TOKEN_ENTRIES,
            { addr: ETH_ADDR.toLowerCase(), symbol: "WETH", decimals: 18 },
          ],
          // No WETH entry in gaslessFees — relayer doesn't relay it.
        },
      ),
    );
    const wethFeeCall = {
      target: ETH_ADDR,
      value: "0",
      data: TRANSFER_IFACE.encodeFunctionData("transfer", [
        RELAYER_ADDR,
        ethers.parseUnits("0.001", 18),
      ]),
    };
    const res = await request(app)
      .post("/api/transfer-7702/relay")
      .send(validBody({ calls: [wethFeeCall] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/token not supported/i);
    expect(res.body.token).toBe("WETH");
  });
});
