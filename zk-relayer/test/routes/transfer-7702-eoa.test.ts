import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { ethers } from "ethers";
import { createTransfer7702Routes } from "../../src/routes/transfer-7702.js";
import { mountRouter, makeSubmitterStub } from "./helpers.js";

const DELEGATE = "0x" + "a".repeat(40);
const FROM_EOA = "0x" + "b".repeat(40);
const RECIPIENT = "0x" + "5".repeat(40);
const TX_HASH = "0x" + "f".repeat(64);
const SIG_65_BYTES = "0x" + "1".repeat(130);
const HEX_32 = "0x" + "2".repeat(64);
const RELAYER_ADDR = "0x" + "9".repeat(40);
const USDC_ADDR = "0x" + "d".repeat(40);
const RANDO_TOKEN = "0x" + "7".repeat(40);

const TOKEN_ENTRIES = [
  { addr: USDC_ADDR.toLowerCase(), symbol: "USDC", decimals: 6 },
];
const GASLESS_FEES = { USDC: "0.1" };

const TRANSFER_IFACE = new ethers.Interface([
  "function transfer(address to, uint256 amount)",
]);

function transferCall(token: string, to: string, amountDecimal: string, decimals = 6) {
  return {
    target: token,
    value: "0",
    data: TRANSFER_IFACE.encodeFunctionData("transfer", [
      to,
      ethers.parseUnits(amountDecimal, decimals),
    ]),
  };
}

// Far-future unix-second timestamp — keeps existing tests immune to
// the deadline preflight added in v2 (only the dedicated expiry
// tests override this).
const FAR_FUTURE = String(Math.floor(Date.now() / 1000) + 86_400);

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    fromEoa: FROM_EOA,
    // Default: send 100 USDC to recipient + 0.1 USDC fee to relayer.
    calls: [
      transferCall(USDC_ADDR, RECIPIENT, "100"),
      transferCall(USDC_ADDR, RELAYER_ADDR, "0.1"),
    ],
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
    getWallet: () => ({ address: RELAYER_ADDR, sendTransaction } as never),
  });
}

const ROUTE_OPTS = {
  stealthTransferAccountAddress: DELEGATE,
  tokenEntries: TOKEN_ENTRIES,
  gaslessFees: GASLESS_FEES,
};

describe("/api/transfer-7702/eoa-relay", () => {
  it("submits a type-4 tx for a whitelisted ERC20 transfer + fee", async () => {
    const sendTransaction = vi.fn(async () => ({ hash: TX_HASH }));
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(makeStubWithSendTx(sendTransaction), ROUTE_OPTS),
    );

    const res = await request(app)
      .post("/api/transfer-7702/eoa-relay")
      .send(validBody());
    expect(res.status).toBe(202);
    expect(res.body.txHash).toBe(TX_HASH);

    expect(sendTransaction).toHaveBeenCalledOnce();
    const arg = sendTransaction.mock.calls[0][0] as {
      type: number;
      to: string;
      authorizationList: { address: string }[];
    };
    expect(arg.type).toBe(4);
    // tx target is the EOA being delegated, not the recipient.
    expect(arg.to).toBe(FROM_EOA);
    expect(arg.authorizationList[0].address).toBe(DELEGATE);
  });

  it("rejects a transfer of a non-whitelisted token", async () => {
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(
        makeStubWithSendTx(async () => ({ hash: TX_HASH })),
        ROUTE_OPTS,
      ),
    );
    const res = await request(app)
      .post("/api/transfer-7702/eoa-relay")
      .send(
        validBody({
          calls: [
            transferCall(RANDO_TOKEN, RECIPIENT, "100"),
            transferCall(USDC_ADDR, RELAYER_ADDR, "0.1"),
          ],
        }),
      );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/token not whitelisted/i);
    expect(res.body.token.toLowerCase()).toBe(RANDO_TOKEN.toLowerCase());
    expect(res.body.index).toBe(0);
  });

  it("rejects calls that aren't ERC20.transfer", async () => {
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(
        makeStubWithSendTx(async () => ({ hash: TX_HASH })),
        ROUTE_OPTS,
      ),
    );
    // Arbitrary calldata pointed at a whitelisted token address.
    const opaqueCall = { target: USDC_ADDR, value: "0", data: "0xdeadbeef" };
    const res = await request(app)
      .post("/api/transfer-7702/eoa-relay")
      .send(validBody({ calls: [opaqueCall] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-erc20-transfer call/i);
  });

  it("rejects calls with non-zero native value", async () => {
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(
        makeStubWithSendTx(async () => ({ hash: TX_HASH })),
        ROUTE_OPTS,
      ),
    );
    const valueCall = {
      ...transferCall(USDC_ADDR, RECIPIENT, "100"),
      value: "1",
    };
    const res = await request(app)
      .post("/api/transfer-7702/eoa-relay")
      .send(
        validBody({
          calls: [valueCall, transferCall(USDC_ADDR, RELAYER_ADDR, "0.1")],
        }),
      );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-zero call value/i);
  });

  it("rejects a fee below policy", async () => {
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(
        makeStubWithSendTx(async () => ({ hash: TX_HASH })),
        ROUTE_OPTS,
      ),
    );
    const res = await request(app)
      .post("/api/transfer-7702/eoa-relay")
      .send(
        validBody({
          calls: [
            transferCall(USDC_ADDR, RECIPIENT, "100"),
            transferCall(USDC_ADDR, RELAYER_ADDR, "0.05"),
          ],
        }),
      );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fee below policy/i);
  });

  it("rejects a batch with no fee paid to the relayer", async () => {
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(
        makeStubWithSendTx(async () => ({ hash: TX_HASH })),
        ROUTE_OPTS,
      ),
    );
    const res = await request(app)
      .post("/api/transfer-7702/eoa-relay")
      .send(
        validBody({
          calls: [transferCall(USDC_ADDR, RECIPIENT, "100")],
        }),
      );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no fee paid/i);
  });

  it("rejects an unauthorized delegate", async () => {
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(
        makeStubWithSendTx(async () => ({ hash: TX_HASH })),
        ROUTE_OPTS,
      ),
    );
    const res = await request(app)
      .post("/api/transfer-7702/eoa-relay")
      .send(
        validBody({
          authorization: {
            address: "0x" + "e".repeat(40),
            chainId: "31337",
            nonce: "0",
            signature: { r: HEX_32, s: HEX_32, yParity: 0 },
          },
        }),
      );
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
    const res = await request(app)
      .post("/api/transfer-7702/eoa-relay")
      .send(
        validBody({
          authorization: {
            address: DELEGATE,
            chainId: "1",
            nonce: "0",
            signature: { r: HEX_32, s: HEX_32, yParity: 0 },
          },
        }),
      );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/chainId mismatch/i);
  });

  it("returns 400 on a malformed body (missing fromEoa)", async () => {
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(
        makeStubWithSendTx(async () => ({ hash: TX_HASH })),
        ROUTE_OPTS,
      ),
    );
    const res = await request(app)
      .post("/api/transfer-7702/eoa-relay")
      .send({ calls: [], signature: SIG_65_BYTES, authorization: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid body/i);
  });

  it("does not affect the existing /relay (stealth) endpoint", async () => {
    // Sanity check: shared helpers haven't broken the stealth flow.
    // Stealth body uses `stealthAddress` not `fromEoa`.
    const sendTransaction = vi.fn(async () => ({ hash: TX_HASH }));
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(makeStubWithSendTx(sendTransaction), ROUTE_OPTS),
    );
    const res = await request(app)
      .post("/api/transfer-7702/relay")
      .send({
        stealthAddress: FROM_EOA,
        calls: [transferCall(USDC_ADDR, RELAYER_ADDR, "0.1")],
        deadline: FAR_FUTURE,
        signature: SIG_65_BYTES,
        authorization: {
          address: DELEGATE,
          chainId: "31337",
          nonce: "0",
          signature: { r: HEX_32, s: HEX_32, yParity: 0 },
        },
      });
    expect(res.status).toBe(202);
    expect(res.body.txHash).toBe(TX_HASH);
  });

  it("rejects an expired deadline before broadcasting", async () => {
    const sendTransaction = vi.fn(async () => ({ hash: TX_HASH }));
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(makeStubWithSendTx(sendTransaction), ROUTE_OPTS),
    );
    // Set deadline 5 minutes in the past — preflight should fail
    // fast and never call sendTransaction.
    const expired = String(Math.floor(Date.now() / 1000) - 300);
    const res = await request(app)
      .post("/api/transfer-7702/eoa-relay")
      .send(validBody({ deadline: expired }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("expired_signature");
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});
