import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createTransfer7702Routes } from "../../src/routes/transfer-7702.js";
import { mountRouter, makeSubmitterStub } from "./helpers.js";

const DELEGATE = "0x" + "a".repeat(40);
const STEALTH = "0x" + "b".repeat(40);
const TARGET = "0x" + "c".repeat(40);
const TX_HASH = "0x" + "f".repeat(64);
const SIG_65_BYTES = "0x" + "1".repeat(130);
const HEX_32 = "0x" + "2".repeat(64);

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    stealthAddress: STEALTH,
    calls: [{ target: TARGET, value: "0", data: "0x" }],
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
    getWallet: () => ({ address: "0x" + "9".repeat(40), sendTransaction } as never),
  });
}

describe("/api/transfer-7702", () => {
  it("POST /relay submits a type-4 tx and returns the hash", async () => {
    const sendTransaction = vi.fn(async () => ({ hash: TX_HASH }));
    const app = mountRouter(
      "/api/transfer-7702",
      createTransfer7702Routes(
        makeStubWithSendTx(sendTransaction),
        { stealthTransferAccountAddress: DELEGATE },
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
        { stealthTransferAccountAddress: DELEGATE },
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
        { stealthTransferAccountAddress: DELEGATE },
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
        { stealthTransferAccountAddress: DELEGATE },
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
        { stealthTransferAccountAddress: DELEGATE },
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
        { stealthTransferAccountAddress: DELEGATE },
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
        { stealthTransferAccountAddress: DELEGATE },
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
        { stealthTransferAccountAddress: DELEGATE },
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
        { stealthTransferAccountAddress: checksummed },
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
});
