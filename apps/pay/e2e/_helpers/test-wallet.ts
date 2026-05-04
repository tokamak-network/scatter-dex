import type { Page } from "@playwright/test";
import { ethers } from "ethers";

/**
 * Minimal test-only EIP-1193 provider injected at `window.ethereum`
 * BEFORE the page's React tree mounts, so Pay's `useWallet` boots
 * straight into the connected state without a manual click.
 *
 * Scope today: read-side methods only (account discovery, chain
 * id, log queries, balance / call passthrough to the RPC URL the
 * test points at). Tx + signing methods (`eth_sendTransaction`,
 * `personal_sign`, `eth_signTypedData_v4`) intentionally throw —
 * tests that need them will land alongside a follow-up PR that adds
 * a self-contained signing helper. The settle / claim / transfer-out
 * flows that need signing are still tracked by the manual checklist
 * at `docs/operations/qa-pay-weth-transferout.md`.
 *
 * Why a hand-rolled stub instead of Synpress:
 * - No MetaMask binary to manage on CI.
 * - No flaky popup automation; the provider is a pure JS object.
 * - Deterministic across browsers; resets per page navigation.
 * - The signing-side gap is real but small — the next iteration
 *   adds it without changing this surface area.
 */
export interface TestWalletOptions {
  /** EOA the page should treat as connected. Pass an anvil-funded
   *  address (e.g. the deployer key from `dev.sh`) when you need
   *  on-chain reads to land against real state. */
  account: string;
  /** Decimal chain id the wallet reports. Must match the network
   *  config Pay reads at runtime (`getNetworkConfig().chainId`),
   *  otherwise Pay surfaces a "wrong chain" banner and gates writes. */
  chainId: number;
  /** Optional private key (`0x…` 32 bytes). When set, the bridge
   *  enables `personal_sign` / `eth_signTypedData_v4` /
   *  `eth_sendTransaction` — every signing call is forwarded to a
   *  node-side `ethers.Wallet(privateKey)` via Playwright's
   *  `page.exposeFunction`, so the browser stub stays free of any
   *  signing crypto bundle. Omit for read-only tests; the signing
   *  methods then keep their loud "not supported" throw. The key's
   *  derived address must equal `account`. */
  privateKey?: string;
  /** RPC URL all unhandled JSON-RPC methods passthrough to. Also
   *  used by the node-side signer to populate + broadcast
   *  `eth_sendTransaction`. Defaults to anvil's standard
   *  `http://127.0.0.1:8545` so a developer running
   *  `dev.sh --apps pay --mock` doesn't have to thread the URL
   *  through every test. */
  rpcUrl?: string;
  /** Vendor flag echoed via `isMetaMask` so `detectWalletName`
   *  doesn't fall through to the generic "Browser Wallet" label.
   *  Defaults to true — most tests don't care about the wallet
   *  name. Set false to exercise the generic-wallet branch. */
  isMetaMask?: boolean;
}

/**
 * Handle returned by {@link installTestWallet}. Lets a test trigger
 * EIP-1193 events the SDK's wallet hook subscribes to (`accountsChanged`,
 * `chainChanged`) without re-doing the `page.evaluate(() => window.…)`
 * dance every time. The next-iteration signer add-on extends the
 * same handle, so existing tests don't need to migrate. */
export interface TestWalletHandle {
  /** Fire an EIP-1193 event on the in-page provider. Routes to every
   *  listener `eth.on(event, …)` ever registered. The SDK uses this
   *  for `accountsChanged` (account swap) and `chainChanged` (network
   *  swap); a test simulating either should call this method rather
   *  than re-installing the bridge. */
  emit(event: string, ...args: unknown[]): Promise<void>;
}

/**
 * Install the test wallet on `page` so it's available the moment
 * any document loads (including pre-mount React effects). Returns
 * a {@link TestWalletHandle} for follow-up event injection; tests
 * that don't need to swap accounts mid-run can ignore the return
 * value. `addInitScript` resolves before the next page load, so
 * `await`-ing this call is enough — every subsequent `goto` sees
 * the stub. */
export async function installTestWallet(
  page: Page,
  options: TestWalletOptions,
): Promise<TestWalletHandle> {
  const opts = {
    account: options.account,
    chainId: options.chainId,
    rpcUrl: options.rpcUrl ?? "http://127.0.0.1:8545",
    isMetaMask: options.isMetaMask ?? true,
    canSign: !!options.privateKey,
  };

  if (options.privateKey) {
    // Node-side signer. Lives in the test runner's process; the
    // browser stub forwards signing requests through
    // `page.exposeFunction` (which Playwright surfaces as a global
    // function on the page). This keeps the browser-side init
    // script free of any secp256k1 / RLP bundle — ethers does the
    // crypto where it already lives.
    const wallet = new ethers.Wallet(options.privateKey);
    if (wallet.address.toLowerCase() !== options.account.toLowerCase()) {
      throw new Error(
        `[test-wallet] privateKey derives ${wallet.address} but options.account is ${options.account} — fix one or the other before installing the bridge.`,
      );
    }
    // Lazy-initialise the broadcast-capable signer. Sign-only tests
    // (`personal_sign`, `eth_signTypedData_v4`) don't need an RPC
    // connection at all; opening one at install time would burn a
    // keepalive socket against an anvil that may not even be running.
    let connected: ethers.Wallet | null = null;
    function getConnected(): ethers.Wallet {
      if (!connected) {
        const signerProvider = new ethers.JsonRpcProvider(opts.rpcUrl);
        connected = wallet.connect(signerProvider);
      }
      return connected;
    }

    await page.exposeFunction(
      "__testWalletSign",
      async (kind: string, payload: unknown): Promise<string> => {
        switch (kind) {
          case "personal_sign": {
            // EIP-191 — payload is the message bytes, hex-encoded.
            // ethers' `signMessage` re-applies the personal-prefix
            // wrapper that the EIP-191 spec mandates, so the value
            // we feed it is just the underlying bytes.
            const bytes = ethers.getBytes(payload as string);
            return wallet.signMessage(bytes);
          }
          case "eth_signTypedData_v4": {
            // EIP-712 — payload is the parsed typed-data object the
            // browser stub built from the JSON the dapp passed.
            // ethers' signTypedData adds `EIP712Domain` automatically,
            // so we strip it from the inbound `types` if present.
            const td = payload as {
              domain: ethers.TypedDataDomain;
              types: Record<string, ethers.TypedDataField[]> & { EIP712Domain?: unknown };
              message: Record<string, unknown>;
            };
            const types = { ...td.types };
            delete types.EIP712Domain;
            return wallet.signTypedData(td.domain, types, td.message);
          }
          case "eth_sendTransaction": {
            // Sign + broadcast in one shot. ethers populates
            // missing fields (nonce, gas, fees) from the connected
            // RPC. Returns the broadcast tx hash to the caller —
            // matches what `eth_sendTransaction` is contractually
            // supposed to return.
            const tx = await getConnected().sendTransaction(
              payload as ethers.TransactionRequest,
            );
            return tx.hash;
          }
          default:
            throw new Error(`[test-wallet] unknown sign kind: ${kind}`);
        }
      },
    );
  }

  await page.addInitScript((cfg) => {
    // ----- Inside the browser context from here. No imports allowed -----
    // The init script runs before any `<script>` on the page, so
    // `window.ethereum` is set before Pay's bundle reads it.
    const account = cfg.account.toLowerCase();
    const chainIdHex = "0x" + cfg.chainId.toString(16);
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

    // Monotonic JSON-RPC request id. `Date.now()` collides when two
    // requests happen within the same millisecond (common during a
    // React render that fans out `eth_call` + `eth_chainId` from
    // multiple effects in one tick).
    let nextRpcId = 1;

    // Shape of the bridge between the in-page provider and the
    // node-side ethers signer (set by `page.exposeFunction` when the
    // install includes a privateKey). Declared here rather than as a
    // top-level type because the init script is its own scope —
    // names from outside the closure aren't visible.
    type TestSignWindow = Window & {
      __testWalletSign(kind: string, payload: unknown): Promise<string>;
    };

    function makeUnsupported(method: string): Error {
      return new Error(
        `[test-wallet] ${method} not supported — install with { privateKey } to enable, or see apps/pay/e2e/README.md "What this harness does NOT cover (yet)".`,
      );
    }

    async function rpcPassthrough(method: string, params: unknown): Promise<unknown> {
      // Forward the method to the configured RPC. Read-side methods
      // (`eth_blockNumber`, `eth_call`, `eth_getLogs`, etc.) all land
      // here; the wallet doesn't need to know about them individually.
      let res: Response;
      try {
        res = await fetch(cfg.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method,
            params: params ?? [],
            id: nextRpcId++,
          }),
        });
      } catch (e) {
        // Network-level failure — RPC server down, DNS, refused
        // connection. Surface the URL so the test author knows
        // exactly which target they're missing.
        throw new Error(
          `[test-wallet] RPC ${method} fetch failed against ${cfg.rpcUrl}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      if (!res.ok) {
        throw new Error(
          `[test-wallet] RPC ${method} ${cfg.rpcUrl} HTTP ${res.status}: ${await res.text()}`,
        );
      }
      const json = (await res.json()) as { result?: unknown; error?: { message: string; code: number } };
      if (json.error) {
        const err = new Error(`[test-wallet] RPC ${method}: ${json.error.message}`);
        (err as { code?: number }).code = json.error.code;
        throw err;
      }
      return json.result;
    }

    const provider = {
      isMetaMask: cfg.isMetaMask,

      async request(args: { method: string; params?: unknown }): Promise<unknown> {
        const { method, params } = args;
        switch (method) {
          // Identity / chain — answered locally so a fresh page load
          // sees the connected state immediately, before any RPC
          // round-trip can race the React mount.
          case "eth_accounts":
          case "eth_requestAccounts":
            return [account];
          case "eth_chainId":
            return chainIdHex;
          case "net_version":
            return String(cfg.chainId);

          // Sign / send — when the install was given a privateKey,
          // forward to the node-side signer via the exposed function.
          // Without a privateKey, throw the same loud "not supported"
          // error so read-only tests still fail clearly.
          case "eth_sendTransaction": {
            if (!cfg.canSign) throw makeUnsupported(method);
            const tx = (params as Array<unknown> | undefined)?.[0];
            return (window as unknown as TestSignWindow).__testWalletSign(
              "eth_sendTransaction",
              tx,
            );
          }
          case "personal_sign": {
            if (!cfg.canSign) throw makeUnsupported(method);
            // EIP-1474 wire format: `[message, address]`. Earlier
            // drafts swapped them, but every modern wallet (MetaMask,
            // Rabby, Coinbase, WalletConnect) emits the EIP-1474
            // order — and a heuristic to "auto-detect" doesn't
            // actually work, since both args are 0x-prefixed. Pick
            // index 0 verbatim and let any test that hits a swapped
            // dapp fail loudly.
            const arr = params as [string, string] | undefined;
            return (window as unknown as TestSignWindow).__testWalletSign(
              "personal_sign",
              arr?.[0],
            );
          }
          case "eth_signTypedData_v4":
          case "eth_signTypedData_v3": {
            if (!cfg.canSign) throw makeUnsupported(method);
            // EIP-712 v4 wire format: `[address, jsonString]`.
            const arr = params as [string, string] | undefined;
            const json = arr?.[1];
            const parsed = json ? JSON.parse(json) : null;
            return (window as unknown as TestSignWindow).__testWalletSign(
              "eth_signTypedData_v4",
              parsed,
            );
          }
          case "eth_signTransaction":
          case "eth_sign":
            // Deprecated / dangerous methods — never wire them, even
            // when canSign is true. dapps that hit them should fail
            // loudly so they migrate.
            throw makeUnsupported(method);

          // Chain switch — pretend success when the target is the
          // already-active chain; reject otherwise so a test that
          // tries to switch into an unconfigured chain fails loudly.
          case "wallet_switchEthereumChain": {
            const target = (params as Array<{ chainId: string }> | undefined)?.[0]?.chainId;
            if (target === chainIdHex) return null;
            throw new Error(
              `[test-wallet] wallet_switchEthereumChain rejected: target=${target} active=${chainIdHex}`,
            );
          }

          // Everything else: forward to the configured RPC.
          default:
            return rpcPassthrough(method, params);
        }
      },

      on(event: string, handler: (...args: unknown[]) => void): void {
        (listeners[event] ??= []).push(handler);
      },

      removeListener(event: string, handler: (...args: unknown[]) => void): void {
        const list = listeners[event];
        if (!list) return;
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      },
    };

    // Required by the SDK: `packages/sdk/src/react/wallet.tsx`
    // listens for `ethereum#initialized` to re-bind on a wallet that
    // injects after first paint. Without dispatching this, late
    // hydration paths would miss the bridge.
    Object.defineProperty(window, "ethereum", {
      value: provider,
      configurable: true,
      writable: true,
    });
    // Stash a separate reference for the post-install handle. Tests
    // reach this via `page.evaluate(...)` in the returned
    // `TestWalletHandle.emit`. Kept distinct from `window.ethereum`
    // so a future test that swaps the public provider (e.g. to
    // simulate a wallet disconnect by reassigning `window.ethereum`)
    // doesn't lose the bridge's event-emit channel.
    (window as unknown as Record<string, unknown>).__testWallet = {
      emit(event: string, ...args: unknown[]) {
        const list = listeners[event];
        if (!list) return;
        for (const handler of list.slice()) {
          try {
            handler(...args);
          } catch (err) {
            console.error(`[test-wallet] listener for ${event} threw`, err);
          }
        }
      },
    };
    window.dispatchEvent(new Event("ethereum#initialized"));
  }, opts);

  return {
    async emit(event, ...args) {
      await page.evaluate(
        ({ event, args }) => {
          const t = (window as unknown as { __testWallet?: { emit(e: string, ...a: unknown[]): void } }).__testWallet;
          t?.emit(event, ...args);
        },
        { event, args },
      );
    },
  };
}

/**
 * Convenience: anvil's first hardcoded private key + its derived
 * address. `dev.sh --mock` deploys with this key, so it's the one
 * funded with everything by default. Treat as test-only — these are
 * the well-known anvil values, never use them on a public chain. */
export const ANVIL_DEFAULT = {
  // Anvil's account #0 — derived from the first private key in its
  // hardcoded mnemonic test-junk. Public knowledge, not a secret.
  account: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  privateKey:
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  chainId: 31337,
} as const;
