import { ethers } from "ethers";
import { MULTICALL3_ADDRESS, MULTICALL3_ABI } from "./multicall";

/** Build a read-only JsonRpcProvider for a chain's RPC.
 *
 *  No singleton/cache here — caller decides lifetime. The React wallet
 *  hook caches one per `NetworkConfig` so React renders share an
 *  instance, but Node scripts and tests usually want fresh providers.
 *
 *  This is the *fallback* read path: it's used when no wallet is
 *  connected (or the wallet is on the wrong chain). A `JsonRpcProvider`
 *  already auto-batches same-tick calls into one HTTP POST, so it needs
 *  no Multicall help. Once a wallet is connected, reads route through
 *  `InjectedMulticallProvider` instead so they run on the user's own
 *  node — see `useWallet` in `@zkscatter/sdk/react`. */
export function getReadProvider(rpcUrl: string): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(rpcUrl);
}

interface PendingCall {
  tx: ethers.TransactionRequest;
  resolve: (value: string) => void;
  reject: (reason: unknown) => void;
}

/** Multicall3 chunk ceiling — mirrors `multicall()`'s MAX_BATCH_SIZE. */
const MAX_BATCH_SIZE = 100;

/** A view call is safe to fold into a Multicall3 `aggregate3` only when
 *  it has no `from` (Multicall3 would execute as itself, changing
 *  `msg.sender`), no `value`, and targets the latest block. Anything
 *  else falls through to a plain per-call `eth_call`. */
function isBatchableView(tx: ethers.TransactionRequest): boolean {
  return (
    typeof tx.to === "string" &&
    typeof tx.data === "string" &&
    tx.from == null &&
    (tx.value == null || tx.value === 0n || tx.value === 0) &&
    (tx.blockTag == null || tx.blockTag === "latest")
  );
}

/** A read provider backed by the user's injected wallet (MetaMask et al.)
 *  that transparently coalesces concurrent view reads into a single
 *  Multicall3 `aggregate3` request.
 *
 *  Why this exists: ethers forces `BrowserProvider` to `batchMaxCount: 1`,
 *  so EIP-1193 cannot batch JSON-RPC calls — every `contract.view()`
 *  becomes its own `window.ethereum.request`, i.e. its own hit on the
 *  wallet's (often rate-limited public) RPC. Pointing app reads at the
 *  wallet without batching would multiply traffic by N and trip
 *  MetaMask's `-32002` circuit breaker. Overriding `call()` to gather a
 *  microtask-window of view reads and fire them as ONE `aggregate3`
 *  keeps the wallet-RPC cost at ~1 request per refresh, regardless of
 *  how many fields a page reads.
 *
 *  Drop-in for `JsonRpcProvider`: callers keep doing
 *  `new Contract(addr, abi, readProvider)` and `contract.foo()`.
 *  Non-view calls, calls with an explicit `from`/`value`/`blockTag`, and
 *  chains without the Multicall3 predeploy all fall back to a plain
 *  per-call `eth_call` (a reverting view still throws its real revert
 *  reason).
 *
 *  Caveat: a batched sub-call executes with `msg.sender = Multicall3`, not
 *  the zero address an unbatched `from`-less `eth_call` uses. This only
 *  matters for `msg.sender`-sensitive view functions — pass an explicit
 *  `from` for those and `isBatchableView` sends them unbatched. */
export class InjectedMulticallProvider extends ethers.BrowserProvider {
  readonly #mcIface = new ethers.Interface(MULTICALL3_ABI);
  #queue: PendingCall[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #stallMs: number;
  // Latched once we learn this chain has no Multicall3 predeploy (e.g. a
  // local anvil), so we don't pay a doomed aggregate3 attempt on every
  // flush. Only set on a decode/empty result — NOT on a transient network
  // error — so one RPC blip can't permanently disable batching for the
  // session.
  #multicall3Unsupported = false;

  constructor(
    eip1193: ethers.Eip1193Provider,
    network?: ethers.Networkish,
    opts?: { stallMs?: number },
  ) {
    super(eip1193, network);
    // ethers' own JSON-RPC batcher uses a 10ms stall; match it so a
    // page's same-tick reads land in one window without adding
    // noticeable latency.
    this.#stallMs = opts?.stallMs ?? 10;
  }

  override async call(tx: ethers.TransactionRequest): Promise<string> {
    if (!isBatchableView(tx)) {
      return super.call(tx);
    }
    return new Promise<string>((resolve, reject) => {
      this.#queue.push({ tx, resolve, reject });
      if (this.#timer == null) {
        this.#timer = setTimeout(() => {
          void this.#flush();
        }, this.#stallMs);
      }
    });
  }

  async #flush(): Promise<void> {
    this.#timer = null;
    const batch = this.#queue;
    this.#queue = [];

    // A lone read isn't worth the Multicall3 round-trip (and avoids the
    // aggregate3 re-entering call() for a single sub-request).
    if (batch.length === 1) {
      await this.#passthrough(batch[0]!);
      return;
    }

    // Chunks are independent (each resolves its own sub-promises), so on the
    // rare >100-read window fire them concurrently rather than serially.
    const chunks: Promise<void>[] = [];
    for (let i = 0; i < batch.length; i += MAX_BATCH_SIZE) {
      chunks.push(this.#flushChunk(batch.slice(i, i + MAX_BATCH_SIZE)));
    }
    await Promise.all(chunks);
  }

  async #flushChunk(chunk: PendingCall[]): Promise<void> {
    // Skip the aggregate entirely once we know this chain lacks Multicall3.
    if (this.#multicall3Unsupported) {
      await Promise.all(chunk.map((c) => this.#passthrough(c)));
      return;
    }
    const calls = chunk.map((c) => ({
      target: c.tx.to as string,
      allowFailure: true,
      callData: c.tx.data as string,
    }));
    let decoded: ReadonlyArray<{ success: boolean; returnData: string }>;
    try {
      const data = this.#mcIface.encodeFunctionData("aggregate3", [calls]);
      // `super.call` (not `this.call`) so the aggregate request itself
      // isn't re-queued — one plain eth_call to Multicall3.
      const raw = await super.call({ to: MULTICALL3_ADDRESS, data });
      decoded = this.#mcIface.decodeFunctionResult("aggregate3", raw)[0] as ReadonlyArray<{
        success: boolean;
        returnData: string;
      }>;
    } catch (err) {
      // A decode/empty failure (`BAD_DATA`) means there's no Multicall3 code
      // at the address (local/anvil) — latch it off so future flushes skip
      // straight to passthrough. A transient network error degrades just
      // this once without latching.
      if ((err as { code?: string }).code === "BAD_DATA") {
        this.#multicall3Unsupported = true;
      }
      await Promise.all(chunk.map((c) => this.#passthrough(c)));
      return;
    }
    chunk.forEach((c, idx) => {
      const r = decoded[idx];
      // A reverted sub-call comes back as success=false. Re-run it on its
      // own so the caller sees the authentic revert error a normal
      // `call()` would throw, instead of undecodable returnData.
      if (r && r.success) c.resolve(r.returnData);
      else void this.#passthrough(c);
    });
  }

  /** Run one queued call as a plain `eth_call`, settling its promise. */
  async #passthrough(c: PendingCall): Promise<void> {
    try {
      c.resolve(await super.call(c.tx));
    } catch (err) {
      c.reject(err);
    }
  }
}
