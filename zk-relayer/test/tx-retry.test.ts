import { describe, it, expect, vi } from "vitest";
import { sendAndWait, _isTransientSendError } from "../src/core/tx-retry.js";

// ── isTransientSendError ────────────────────────────────────

describe("isTransientSendError", () => {
  it("returns true for transient RPC errors", () => {
    expect(_isTransientSendError(new Error("ECONNREFUSED"))).toBe(true);
    expect(_isTransientSendError(new Error("timeout"))).toBe(true);
    expect(_isTransientSendError(new Error("socket hang up"))).toBe(true);
    expect(_isTransientSendError(new Error("network error"))).toBe(true);
    expect(_isTransientSendError(new Error("bad response"))).toBe(true);
    expect(_isTransientSendError(new Error("503 service unavailable"))).toBe(true);
    expect(_isTransientSendError(new Error("429 too many requests"))).toBe(true);
  });

  it("returns false for permanent errors (revert, invalid params)", () => {
    expect(_isTransientSendError(new Error("execution reverted"))).toBe(false);
    expect(_isTransientSendError(new Error("UNPREDICTABLE_GAS_LIMIT"))).toBe(false);
    expect(_isTransientSendError(new Error("nonce too low"))).toBe(false);
    expect(_isTransientSendError(new Error("insufficient funds"))).toBe(false);
    expect(_isTransientSendError(new Error("invalid address"))).toBe(false);
  });

  it("returns false for unknown errors (safe default)", () => {
    expect(_isTransientSendError(new Error("something weird"))).toBe(false);
    expect(_isTransientSendError("string error")).toBe(false);
    expect(_isTransientSendError(null)).toBe(false);
  });
});

// ── sendAndWait ─────────────────────────────────────────────

function mockTxResponse(hash: string) {
  return {
    hash,
    wait: vi.fn(),
  };
}

function mockProvider() {
  return {
    getTransactionReceipt: vi.fn(),
  };
}

describe("sendAndWait", () => {
  it("succeeds on first attempt", async () => {
    const txResp = mockTxResponse("0xabc");
    txResp.wait.mockResolvedValue({ hash: "0xabc", status: 1 });
    const provider = mockProvider();

    const result = await sendAndWait(
      () => Promise.resolve(txResp) as any,
      provider as any,
      { label: "test" },
    );

    expect(result.txHash).toBe("0xabc");
    expect(result.receipt.status).toBe(1);
  });

  it("retries transient send errors", async () => {
    const txResp = mockTxResponse("0xdef");
    txResp.wait.mockResolvedValue({ hash: "0xdef", status: 1 });
    const provider = mockProvider();

    let attempt = 0;
    const sendFn = () => {
      attempt++;
      if (attempt === 1) return Promise.reject(new Error("ECONNREFUSED"));
      return Promise.resolve(txResp) as any;
    };

    const result = await sendAndWait(sendFn, provider as any, {
      label: "test",
      sendRetries: 3,
      sendRetryBaseMs: 10, // fast for tests
    });

    expect(attempt).toBe(2);
    expect(result.txHash).toBe("0xdef");
  });

  it("does NOT retry permanent send errors (revert)", async () => {
    const provider = mockProvider();

    let attempt = 0;
    const sendFn = () => {
      attempt++;
      return Promise.reject(new Error("execution reverted: nullifier already spent"));
    };

    await expect(
      sendAndWait(sendFn, provider as any, {
        label: "test",
        sendRetries: 3,
        sendRetryBaseMs: 10,
      }),
    ).rejects.toThrow("execution reverted");

    expect(attempt).toBe(1); // no retry
  });

  it("calls onTxHash callback after send succeeds", async () => {
    const txResp = mockTxResponse("0x123");
    txResp.wait.mockResolvedValue({ hash: "0x123", status: 1 });
    const provider = mockProvider();
    const onTxHash = vi.fn();

    await sendAndWait(
      () => Promise.resolve(txResp) as any,
      provider as any,
      { label: "test", onTxHash },
    );

    expect(onTxHash).toHaveBeenCalledWith("0x123");
  });

  it("throws on on-chain revert (status=0)", async () => {
    const txResp = mockTxResponse("0xbad");
    txResp.wait.mockResolvedValue({ hash: "0xbad", status: 0 });
    const provider = mockProvider();

    await expect(
      sendAndWait(
        () => Promise.resolve(txResp) as any,
        provider as any,
        { label: "test" },
      ),
    ).rejects.toThrow("reverted on-chain");
  });

  it("polls receipt when wait times out", async () => {
    const txResp = mockTxResponse("0xslow");
    // wait() never resolves within timeout
    txResp.wait.mockImplementation(() => new Promise(() => {}));

    const provider = mockProvider();
    provider.getTransactionReceipt
      .mockResolvedValueOnce(null) // first poll: not yet
      .mockResolvedValueOnce({ hash: "0xslow", status: 1 }); // second poll: found

    const result = await sendAndWait(
      () => Promise.resolve(txResp) as any,
      provider as any,
      {
        label: "test",
        waitTimeoutMs: 50,
        receiptPollRetries: 3,
        receiptPollIntervalMs: 30,
      },
    );

    expect(result.txHash).toBe("0xslow");
    expect(provider.getTransactionReceipt).toHaveBeenCalledTimes(2);
  });

  it("throws when wait times out and polling exhausted", async () => {
    const txResp = mockTxResponse("0xlost");
    txResp.wait.mockImplementation(() => new Promise(() => {}));

    const provider = mockProvider();
    provider.getTransactionReceipt.mockResolvedValue(null);

    await expect(
      sendAndWait(
        () => Promise.resolve(txResp) as any,
        provider as any,
        {
          label: "test",
          waitTimeoutMs: 50,
          receiptPollRetries: 2,
          receiptPollIntervalMs: 20,
        },
      ),
    ).rejects.toThrow("no receipt after timeout");
  });
});
