"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { bigintToHex } from "@zkscatter/sdk/util";
import { listFiles, loadFile, removeFile, saveFile } from "@zkscatter/sdk/storage";
import { useWallet } from "@zkscatter/sdk/react";
import { useActiveNetwork } from "./activeNetwork";
import { useFolder } from "./folder";
import { newId } from "./newId";

export type OrderStatus = "matching" | "claimable" | "claimed" | "cancelled";

/** Claim material captured at order-submit time so the user can
 *  release their proceeds later via the claim flow. Phase 5 will
 *  read this from on-chain settlement events instead of carrying
 *  it client-side. */
export interface OrderClaim {
  secret: bigint;
  recipient: string;
  /** Token address as 0x-prefixed hex. */
  token: string;
  amount: bigint;
  /** Unix-seconds release time the order set. */
  releaseTime: bigint;
  /** Index of this claim in the settlement's claims tree (0 for
   *  the demo's single-claim distribution). */
  leafIndex: number;
  /** Bytes32 hex of the claims-tree root the order was settled
   *  under. The reconciler uses this together with `secret` and
   *  `leafIndex` to compute the per-row nullifier and match against
   *  on-chain `PrivateClaim` events. Optional because legacy
   *  rows from earlier app versions may not carry it. */
  claimsRoot?: string;
}

/** A submitted private limit order. Persisted per-chain into an
 *  aggregate JSON file in the user's notes folder
 *  (`zkscatter-pro-orders-{chainId}.json`). Pro mounts behind
 *  `<FolderGate>` so by the time OrdersProvider runs a folder is
 *  guaranteed to be selected — there is no IndexedDB fallback,
 *  the folder is the single source of truth. */
export interface OrderRecord {
  /** Stable id used as the React key and IDB primary key. */
  id: string;
  /** Display label (`ord-1`, `ord-2`…). */
  label: string;
  side: "sell" | "buy";
  pair: string;
  price: string;
  size: string;
  status: OrderStatus;
  /** First recipient's claim material — kept for backward
   *  compatibility with orders persisted before `claims` (the full
   *  list) landed. New writes set both fields; readers should
   *  prefer `claims` and fall back to wrapping `claim` in an
   *  array when only the singular is present. */
  claim?: OrderClaim;
  /** Full per-recipient claim list. Each entry carries its own
   *  `leafIndex` into the order's claims tree so a per-row claim
   *  flow can target the right recipient without re-deriving from
   *  the recipients form. */
  claims?: OrderClaim[];
  /** Authorize-circuit nonce used at order-submit time. Required
   *  later for the cancel proof (the cancel circuit publishes
   *  `nonceNullifier(secret, nonce)` to kill *this* order
   *  specifically). Optional because legacy rows from earlier app
   *  versions may not carry
   *  it. */
  nonce?: bigint;
  /** Vault note id that funded the order — needed by the cancel
   *  flow to look up the spending note and rotate it. */
  noteId?: string;
  /** Commitment hash of the change (residual) note pre-saved at
   *  order-submit time when `sellAmount < note.amount`. Lets
   *  downstream surfaces — note-status panel, cancel cleanup —
   *  find the matching vault row by commitment without
   *  re-deriving from `note + newSalt`. Undefined when the order
   *  spent the funding note in full (no residual). */
  changeCommitment?: bigint;
  /** Settle deadline (unix-seconds) bound into the authorize proof's
   *  `expiry` input. The on-chain `block.timestamp ≤ expiry` check
   *  fails after this point — the order is then unservable and the
   *  user should cancel to recover the funding note. Set at submit
   *  to `min(earliestClaim − 5 min, now + 1 h)`. */
  expiry?: bigint;
  /** Relayer the order is bound to. Captured at submit so the
   *  detail panel can show "who's going to settle this" without
   *  re-resolving from the registry (which may move) and so the
   *  user can audit fee transparency after the fact. */
  relayer?: {
    /** Registry-display name (e.g. "Tokamak Relayer"). Optional
     *  because the simulated path with no selected relayer can't
     *  carry one. */
    name?: string;
    address: string;
    /** Display URL when the user picked a configured relayer; the
     *  zero-address simulated path leaves this undefined. */
    url?: string;
    /** Quoted bps at signing — what the relayer charges in the
     *  common case. */
    feeBps: number;
    /** On-chain `maxFee` cap (bps) the user actually signed —
     *  authorize circuit enforces `relayerFeeBps ≤ maxFee`. */
    maxFeeBps: number;
  };
  /** When the order was submitted (ms epoch). */
  createdAt: number;
}

interface OrdersState {
  orders: OrderRecord[];
  /** False until the first hydrate from the folder adapter
   *  resolves. Note-status callers must wait on this — otherwise
   *  a vault that hydrates *before* the orders file does sees an
   *  empty `orders` and flags locked notes as Available for the
   *  duration of the race, briefly enabling Withdraw on a note
   *  that's actually funding an open order. */
  loaded: boolean;
  add(
    o: Omit<OrderRecord, "id" | "label" | "createdAt" | "status">,
  ): OrderRecord;
  /** Mark an order as claimed. Idempotent. */
  markClaimed(id: string): void;
  /** Mark an order as cancelled. Only valid for `matching` orders;
   *  no-op when the order is already filled / claimed / cancelled. */
  markCancelled(id: string): void;
  /** Delete the local record entirely. Used to clear orders whose
   *  on-chain lifecycle ended outside the app (e.g. a long-expired
   *  matching order that the user wants out of the UI) — does NOT
   *  touch any chain state, just drops the persisted row + file. */
  remove(id: string): Promise<void>;
}

const OrdersCtx = createContext<OrdersState | null>(null);

export function useOrders(): OrdersState {
  const ctx = useContext(OrdersCtx);
  if (!ctx) throw new Error("useOrders must be used inside <OrdersProvider>");
  return ctx;
}

// ── Folder persistence ──────────────────────────────────────────
// Bigints (secret, amount, releaseTime, nonce) are hex-encoded on
// the wire so JSON serialisation round-trips cleanly. One aggregate
// file per chain — orders are small + bounded (tens, occasionally
// hundreds), so re-serialise-on-each-write beats Pay's per-file
// runs model.

/** Wire shape — exported only so the unit test can pin the
 *  on-disk schema and round-trip every field; do not depend on
 *  the WireOrder shape from app code. */
interface WireClaim {
  secretHex: string;
  recipient: string;
  token: string;
  amountHex: string;
  releaseTimeHex: string;
  leafIndex: number;
  claimsRoot?: string;
}

export interface WireOrder {
  id: string;
  label: string;
  side: "sell" | "buy";
  pair: string;
  price: string;
  size: string;
  status: OrderStatus;
  claim?: WireClaim;
  claims?: WireClaim[];
  nonceHex?: string;
  noteId?: string;
  changeCommitmentHex?: string;
  expiryHex?: string;
  relayer?: {
    name?: string;
    address: string;
    url?: string;
    feeBps: number;
    maxFeeBps: number;
  };
  createdAt: number;
}

function serializeClaim(c: OrderClaim): WireClaim {
  return {
    secretHex: bigintToHex(c.secret),
    recipient: c.recipient,
    token: c.token,
    amountHex: bigintToHex(c.amount),
    releaseTimeHex: bigintToHex(c.releaseTime),
    leafIndex: c.leafIndex,
    claimsRoot: c.claimsRoot,
  };
}

function deserializeClaim(w: WireClaim): OrderClaim {
  return {
    secret: BigInt(w.secretHex),
    recipient: w.recipient,
    token: w.token,
    amount: BigInt(w.amountHex),
    releaseTime: BigInt(w.releaseTimeHex),
    leafIndex: w.leafIndex,
    claimsRoot: w.claimsRoot,
  };
}

export function serialize(o: OrderRecord): WireOrder {
  return {
    id: o.id,
    label: o.label,
    side: o.side,
    pair: o.pair,
    price: o.price,
    size: o.size,
    status: o.status,
    // Always write both: `claim` for back-compat with readers that
    // haven't been updated to the plural; `claims` for the full
    // recipient list new readers should prefer.
    claim: o.claim ? serializeClaim(o.claim) : undefined,
    claims: o.claims ? o.claims.map(serializeClaim) : undefined,
    nonceHex: o.nonce !== undefined ? bigintToHex(o.nonce) : undefined,
    noteId: o.noteId,
    changeCommitmentHex: o.changeCommitment !== undefined ? bigintToHex(o.changeCommitment) : undefined,
    expiryHex: o.expiry !== undefined ? bigintToHex(o.expiry) : undefined,
    relayer: o.relayer,
    createdAt: o.createdAt,
  };
}

export function deserialize(w: WireOrder): OrderRecord {
  // Prefer `claims` (plural) — that's the full recipient list.
  // Fall back to wrapping `claim` in a singleton array for orders
  // persisted before the plural landed, so the panel can render
  // them through the same code path. `claim` (singular) stays
  // populated for the same back-compat reason on the read side.
  const claimsList = w.claims && w.claims.length > 0
    ? w.claims.map(deserializeClaim)
    : w.claim
      ? [deserializeClaim(w.claim)]
      : undefined;
  return {
    id: w.id,
    label: w.label,
    side: w.side,
    pair: w.pair,
    price: w.price,
    size: w.size,
    status: w.status,
    claim: w.claim ? deserializeClaim(w.claim) : claimsList?.[0],
    claims: claimsList,
    nonce: w.nonceHex !== undefined ? BigInt(w.nonceHex) : undefined,
    noteId: w.noteId,
    changeCommitment: w.changeCommitmentHex !== undefined ? BigInt(w.changeCommitmentHex) : undefined,
    expiry: w.expiryHex !== undefined ? BigInt(w.expiryHex) : undefined,
    relayer: w.relayer,
    createdAt: w.createdAt,
  };
}

/** Adapter-scoped one-warning-per-reason logger. Module-level
 *  global was too coarse — once any single failure tripped it,
 *  every later failure (including a different category like a JSON
 *  parse error after a write timeout) was silently swallowed for
 *  the page lifetime. Per-(instance × reason-key) lets genuinely
 *  new failure modes still surface, while still de-duping bursts
 *  of the same failure (e.g. one bad save retried). */
function makeWarner(): (reason: string, err?: unknown) => void {
  const seen = new Set<string>();
  return (reason, err) => {
    if (seen.has(reason)) return;
    seen.add(reason);
    // eslint-disable-next-line no-console
    console.warn(`[scatter pro orders] ${reason}`, err);
  };
}

export interface OrdersAdapter {
  loadAll(): Promise<OrderRecord[]>;
  put(o: OrderRecord): Promise<void>;
  /** Delete the persisted order file by id. Idempotent — a missing
   *  id is a no-op. Used by cleanup flows (clear an expired order
   *  whose cancel never landed) and by the post-cancel rotation
   *  hook when the on-chain nullifier burns the record. */
  remove(id: string): Promise<void>;
}

/** Identifier injected into every per-order filename so the same
 *  folder can host orders from multiple wallets without leaking
 *  one user's trade graph into another's UI. Lowercased on the
 *  caller side; we pass through verbatim. */
type AccountKey = string;

interface FolderEntry {
  filename: string;
  read(): Promise<string>;
}

/** IO surface for the per-order adapter. Defaults bind to the SDK
 *  folder primitives; tests inject an in-memory fake that mirrors
 *  the same four operations. */
export interface OrdersAdapterIO {
  listFiles(matches: (filename: string) => boolean): Promise<FolderEntry[]>;
  loadFile(name: string): Promise<string | null>;
  saveFile(name: string, content: string): Promise<void>;
  removeFile(name: string): Promise<void>;
}

const DEFAULT_IO: OrdersAdapterIO = { listFiles, loadFile, saveFile, removeFile };

/** Pro orders are persisted **one file per order** in the user's
 *  notes folder, mirroring Pay's `zkscatter-run-<id>.json` pattern.
 *  Each file is `zkscatter-pro-order-{chainId}-{accountKey}-{id}.json`
 *  and holds a single `WireOrder` JSON object.
 *
 *  ## Why per-file
 *  - **Privacy isolation.** The previous single-aggregate file
 *    keyed only on chainId leaked every order to anyone using the
 *    same folder under a different wallet account. Per-(chain,
 *    account) prefixing closes that.
 *  - **Per-order delete.** Cancel rotation, expiry cleanup, and
 *    manual user-driven cleanup can now drop a single file
 *    instead of editing JSON inside a shared aggregate.
 *  - **No write amplification.** A status flip on one order writes
 *    its own file instead of re-serialising every other order.
 *  - **Corruption is local.** A bad file is skipped at load time
 *    and the rest of the orders survive. The old aggregate model
 *    had to refuse all writes on a parse error to avoid clobbering
 *    the rest.
 *
 *  ## Identity
 *  `accountKey` should be the lowercased 0x-prefixed wallet
 *  address that submitted these orders. An empty / "anon" string
 *  is allowed pre-wallet-connect; rows persisted under that key
 *  stay parked until the same anonymous session continues. */
export function createFolderOrdersAdapter(
  chainId: number,
  accountKey: AccountKey,
  io: OrdersAdapterIO = DEFAULT_IO,
): OrdersAdapter {
  // Lowercase defensively. Callers (OrdersProvider) already do
  // this, but the adapter is exported and EIP-55-checksummed
  // addresses are easy to forward verbatim. A mixed-case key on
  // write + a lowercased key on read would produce two disjoint
  // filename namespaces and silently isolate the user's own
  // orders from themselves.
  const normalizedAccount = accountKey.toLowerCase();
  const prefix = `zkscatter-pro-order-${chainId}-${normalizedAccount}-`;
  const fileFor = (orderId: string): string => `${prefix}${orderId}.json`;
  const warn = makeWarner();
  // Per-order in-memory mirror, keyed by order id. Populated on
  // first `loadAll`, kept warm across subsequent `put` / `remove`
  // calls so the adapter doesn't re-walk the directory on each
  // mutation. Tests rely on the cache hit count to verify this.
  const mem = new Map<string, OrderRecord>();
  let loadedPromise: Promise<void> | null = null;

  function ensureLoaded(): Promise<void> {
    if (loadedPromise) return loadedPromise;
    loadedPromise = (async () => {
      let entries: FolderEntry[];
      try {
        entries = await io.listFiles((name) => name.startsWith(prefix) && name.endsWith(".json"));
      } catch (e) {
        warn("listFiles failed — starting with empty in-memory state", e);
        return;
      }
      // Parallelise the per-file read; tens-to-hundreds of small
      // JSON blobs would otherwise serialise into a noticeable
      // hydration delay. Each inner task swallows its own errors
      // (read / parse / deserialize), but use `allSettled` as a
      // belt-and-suspenders guard in case a future inner branch
      // forgets to wrap and lets a rejection escape — without it,
      // one unhandled throw would abort every sibling parse.
      await Promise.allSettled(
        entries.map(async (entry) => {
          let content: string;
          try {
            content = await entry.read();
          } catch (e) {
            warn(`read failed for ${entry.filename} — skipping`, e);
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(content);
          } catch (e) {
            warn(`invalid JSON in ${entry.filename} — skipping`, e);
            return;
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            warn(`${entry.filename} is not a JSON object — skipping`);
            return;
          }
          const w = parsed as WireOrder;
          if (typeof w.id !== "string") {
            warn(`${entry.filename} missing id field — skipping`);
            return;
          }
          try {
            mem.set(w.id, deserialize(w));
          } catch (e) {
            warn(`deserialize failed for ${entry.filename}`, e);
          }
        }),
      );
    })();
    return loadedPromise;
  }

  return {
    async loadAll() {
      await ensureLoaded();
      return Array.from(mem.values()).sort((a, b) => a.createdAt - b.createdAt);
    },
    async put(o) {
      await ensureLoaded();
      mem.set(o.id, o);
      try {
        await io.saveFile(fileFor(o.id), JSON.stringify(serialize(o), null, 2));
      } catch (e) {
        warn(`saveFile failed for order ${o.id}`, e);
      }
    },
    async remove(id) {
      await ensureLoaded();
      mem.delete(id);
      try {
        await io.removeFile(fileFor(id));
      } catch (e) {
        warn(`removeFile failed for order ${id}`, e);
      }
    },
  };
}

export function OrdersProvider({ children }: { children: React.ReactNode }) {
  const { network } = useActiveNetwork();
  const chainId = network.chainId;
  // Folder-only adapter, but re-create it when the workspace
  // identity changes — `currentId` covers folder pick + folder
  // switch, `accountKey` mirrors Pay's per-account keying so the
  // hydration effect re-fires on wallet swap. Without these the
  // pre-pick adapter would stay cached and orders would never load
  // after the user picks a folder mid-session.
  const { currentId } = useFolder();
  const { account } = useWallet();
  const accountKey = account?.toLowerCase() ?? "anon";
  // The folder adapter is keyed by (chainId, accountKey) — the
  // wallet that owns these orders. Different wallets sharing the
  // same folder write into disjoint filename namespaces, so
  // switching accounts in MetaMask never leaks one user's trade
  // graph (recipients, amounts, claim secrets) to another.
  // `currentId` is in the dep array so a folder swap also forces a
  // fresh adapter instance.
  const adapter = useMemo(
    () => createFolderOrdersAdapter(chainId, accountKey),
    [chainId, currentId, accountKey],
  );

  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Latest committed `orders` for use inside event-driven callbacks
  // (markClaimed / markCancelled / promote). Read here keeps the
  // side-effect (`adapter.put`) outside the setState updater, which
  // React 18 Strict Mode otherwise invokes twice — without this we'd
  // double-write to IDB in dev for every mutation.
  const ordersRef = useRef<OrderRecord[]>([]);
  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);
  const labelCounter = useRef(0);
  // Tracks demo-lifecycle promote timers so they're cleared on
  // unmount (HMR, route swap) and don't fire setOrders against an
  // unmounted provider.
  const promoteTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Hydrate from IDB on mount / chain change. Clears the previous
  // chain's rows + in-flight timers synchronously so:
  //   (a) the UI never paints the old chain's orders against the
  //       new chain's identity,
  //   (b) a promote scheduled against the previous chain's adapter
  //       can't write back to the new one.
  // The async `loadAll` resolves into a *functional* setOrders that
  // dedupes by id against anything added during the hydration
  // window (e.g. a fast user click), and labelCounter is computed
  // monotonically over the merged set so labels can't collide.
  useEffect(() => {
    let cancelled = false;
    const timers = promoteTimers.current;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    scheduledIds.current.clear();
    setOrders([]);
    setLoaded(false);
    labelCounter.current = 0;
    adapter.loadAll().then((loaded) => {
      if (cancelled) return;
      setOrders((pending) => {
        const byId = new Map<string, OrderRecord>();
        for (const o of loaded) byId.set(o.id, o);
        for (const o of pending) byId.set(o.id, o);
        const merged = Array.from(byId.values()).sort(
          (a, b) => b.createdAt - a.createdAt,
        );
        let maxSeq = 0;
        for (const o of merged) {
          const m = /^ord-(\d+)$/.exec(o.label);
          if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
        }
        labelCounter.current = maxSeq;
        return merged;
      });
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  useEffect(() => {
    const timers = promoteTimers.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // Scheduled-id set kept for the hydrate effect's `.clear()`
  // bookkeeping (chain-switch cleanup). No timer schedules anything
  // here — the order lifecycle is driven exclusively by chain
  // events:
  //   - `claimable` is set when ClaimReconciler observes the
  //     matching `PrivateClaim` event;
  //   - `cancelled` is set when CancelOrderModal's on-chain cancel
  //     resolves.
  // The earlier 8-second auto-promote was scaffolding for the
  // pre-settle demo and made every submitted order falsely appear
  // as "Ready to claim" even when nothing had settled, which the
  // user (correctly) flagged as a misleading lifecycle. Removed.
  const scheduledIds = useRef<Set<string>>(new Set());

  const add = useCallback(
    (o: Omit<OrderRecord, "id" | "label" | "createdAt" | "status">) => {
      const seq = ++labelCounter.current;
      const order: OrderRecord = {
        ...o,
        id: newId(),
        label: `ord-${seq}`,
        createdAt: Date.now(),
        status: "matching",
      };
      setOrders((prev) => [order, ...prev]);
      adapter.put(order);
      return order;
    },
    [adapter],
  );

  const markClaimed = useCallback(
    (id: string) => {
      const target = ordersRef.current.find((o) => o.id === id);
      // Bail when the id isn't present or the order is already
      // claimed — keeps the put + setState idempotent across repeat
      // calls and avoids re-rendering with an identical-content list.
      if (!target || target.status === "claimed") return;
      const next: OrderRecord = { ...target, status: "claimed" };
      adapter.put(next);
      setOrders((prev) => prev.map((o) => (o.id === id ? next : o)));
    },
    [adapter],
  );

  const markCancelled = useCallback(
    (id: string) => {
      const target = ordersRef.current.find((o) => o.id === id);
      if (!target || target.status !== "matching") return;
      const next: OrderRecord = { ...target, status: "cancelled" };
      adapter.put(next);
      setOrders((prev) => prev.map((o) => (o.id === id ? next : o)));
    },
    [adapter],
  );

  const remove = useCallback(
    async (id: string) => {
      // Drop in-memory state first so the UI reacts immediately.
      // If the disk-side removeFile fails we log inside the adapter
      // but don't surface a rejection — the local row is gone
      // either way, and stale ghosts on disk are picked up by the
      // next loadAll and reconciled.
      setOrders((prev) => prev.filter((o) => o.id !== id));
      await adapter.remove(id);
    },
    [adapter],
  );

  const value = useMemo<OrdersState>(
    () => ({ orders, loaded, add, markClaimed, markCancelled, remove }),
    [orders, loaded, add, markClaimed, markCancelled, remove],
  );

  return <OrdersCtx.Provider value={value}>{children}</OrdersCtx.Provider>;
}
