import { expect, test } from "@playwright/test";
import { ANVIL_DEFAULT, installTestWallet } from "./_helpers/test-wallet";

/**
 * Smoke for the test-wallet bridge. With `installTestWallet` set up
 * before navigation, Pay's `useWallet` finds an account on
 * `eth_accounts` immediately and renders the connected pill in the
 * header without any user interaction.
 *
 * This is the foundation other wallet-driven specs will build on.
 * Signing-side methods (`eth_sendTransaction`, `personal_sign`,
 * etc.) intentionally throw in this iteration — see the helper for
 * the follow-up that adds them.
 */
test.describe("Wallet bridge", () => {
  test("page boots into the connected state with no manual click", async ({ page }) => {
    await installTestWallet(page, {
      account: ANVIL_DEFAULT.account,
      chainId: ANVIL_DEFAULT.chainId,
    });

    await page.goto("/dashboard");

    // Pay's connect pill renders the short address as
    // `0xPREFIX…SUFFIX`; anchor on the account-specific prefix /
    // suffix so the assertion fails if the page falls back to the
    // disconnected `Connect wallet` button.
    const account = ANVIL_DEFAULT.account.toLowerCase();
    const prefix = account.slice(0, 6); // "0xf39f"
    const suffix = account.slice(-4);   // "2266"
    await expect(
      page.getByText(new RegExp(`${prefix}.*${suffix}`, "i")).first(),
    ).toBeVisible();

    // Negative assertion — the disconnected `Connect wallet` button
    // must NOT be visible. Without this, a page that rendered both
    // states (e.g. a buggy hydration that flickered through the
    // disconnected path before the bridge bound) would still pass
    // the positive assertion above.
    await expect(
      page.getByRole("button", { name: /^Connect wallet$/i }),
    ).not.toBeVisible();
  });

  test("signing methods throw a recognisable error without a privateKey", async ({ page }) => {
    // Read-only install (no privateKey) — every signing method
    // must reject loudly so a test author who forgot the option
    // gets a clear pointer at the right place to add it.
    await installTestWallet(page, {
      account: ANVIL_DEFAULT.account,
      chainId: ANVIL_DEFAULT.chainId,
    });
    await page.goto("/");

    const err = await page.evaluate(async () => {
      const eth = (window as unknown as { ethereum: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
      try {
        await eth.request({ method: "personal_sign", params: ["0xdead", "0x0"] });
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(err).toContain("install with { privateKey }");
  });

  test("personal_sign produces a recoverable signature", async ({ page }) => {
    await installTestWallet(page, {
      account: ANVIL_DEFAULT.account,
      chainId: ANVIL_DEFAULT.chainId,
      privateKey: ANVIL_DEFAULT.privateKey,
    });
    await page.goto("/");

    // Sign "hello" via the bridge, then verify the signature
    // recovers to ANVIL_DEFAULT.account so we know the bridge
    // wired the node-side ethers signer correctly. Anchoring on
    // recovery (not the bytes themselves) keeps the test stable
    // across ethers patch versions that might tweak v normalisation.
    const result = await page.evaluate(async (account) => {
      const eth = (window as unknown as {
        ethereum: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
      }).ethereum;
      const messageHex = "0x" +
        Array.from(new TextEncoder().encode("hello"))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      const sig = (await eth.request({
        method: "personal_sign",
        params: [messageHex, account],
      })) as string;
      return { sig, messageHex };
    }, ANVIL_DEFAULT.account);

    expect(result.sig).toMatch(/^0x[0-9a-f]{130}$/i);
    const { ethers } = await import("ethers");
    const recovered = ethers.verifyMessage(
      ethers.getBytes(result.messageHex),
      result.sig,
    );
    expect(recovered.toLowerCase()).toBe(ANVIL_DEFAULT.account.toLowerCase());
  });

  test("install rejects a privateKey whose address doesn't match account", async ({ page }) => {
    // Negative path for the address-mismatch precheck. A test
    // author who hand-types a wrong account or copy-pastes the
    // wrong key needs an immediate fail at install time, not a
    // confusing signature-recovery mismatch deep in another spec.
    await expect(
      installTestWallet(page, {
        account: "0x0000000000000000000000000000000000000001",
        chainId: ANVIL_DEFAULT.chainId,
        privateKey: ANVIL_DEFAULT.privateKey,
      }),
    ).rejects.toThrow(/derives.*but options\.account/);
  });

  test("eth_signTypedData_v4 produces a recoverable signature", async ({ page }) => {
    await installTestWallet(page, {
      account: ANVIL_DEFAULT.account,
      chainId: ANVIL_DEFAULT.chainId,
      privateKey: ANVIL_DEFAULT.privateKey,
    });
    await page.goto("/");

    // Standard EIP-712 example — Mail with a single Person field —
    // round-tripped through the bridge. Recovery via
    // `verifyTypedData` confirms the node-side signer handled the
    // domain + types stripping correctly.
    const typedData = {
      domain: { name: "Test", version: "1", chainId: ANVIL_DEFAULT.chainId },
      types: {
        Person: [{ name: "wallet", type: "address" }],
      },
      primaryType: "Person",
      message: { wallet: ANVIL_DEFAULT.account },
    };
    const sig = await page.evaluate(async (td) => {
      const eth = (window as unknown as {
        ethereum: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
      }).ethereum;
      return (await eth.request({
        method: "eth_signTypedData_v4",
        params: [td.message.wallet, JSON.stringify(td)],
      })) as string;
    }, typedData);

    const { ethers } = await import("ethers");
    const recovered = ethers.verifyTypedData(
      typedData.domain,
      typedData.types,
      typedData.message,
      sig,
    );
    expect(recovered.toLowerCase()).toBe(ANVIL_DEFAULT.account.toLowerCase());
  });

  test("eth_sendTransaction broadcasts via the configured RPC", async ({ page }) => {
    // Live anvil only — the broadcast path needs a real chain to
    // produce a tx hash. Skip when no anvil is reachable so the
    // test is opt-in (`bash scripts/dev.sh --apps pay --mock` puts
    // it on 127.0.0.1:8545); a hard requirement would make the
    // suite flaky on machines that don't have the stack up.
    test.skip(
      !(await isAnvilReachable("http://127.0.0.1:8545")),
      "anvil not reachable — start with `bash scripts/dev.sh --apps pay --mock`",
    );

    await installTestWallet(page, {
      account: ANVIL_DEFAULT.account,
      chainId: ANVIL_DEFAULT.chainId,
      privateKey: ANVIL_DEFAULT.privateKey,
    });
    await page.goto("/");

    const txHash = (await page.evaluate(async (from) => {
      const eth = (window as unknown as {
        ethereum: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
      }).ethereum;
      // Self-send 1 wei — minimal, no token approvals, no
      // gas-payer mismatch. The bridge populates nonce + fees from
      // anvil; we only assert we get a real tx hash back.
      return await eth.request({
        method: "eth_sendTransaction",
        params: [{ from, to: from, value: "0x1" }],
      });
    }, ANVIL_DEFAULT.account)) as string;

    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/i);
  });
});

/** Cheap reachability check: a single `eth_chainId` post. Returns
 *  true on any 200 with a JSON-RPC result, false on connect /
 *  HTTP / parse failure. */
async function isAnvilReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
    });
    if (!res.ok) return false;
    const json = await res.json();
    return typeof json?.result === "string";
  } catch {
    return false;
  }
}
