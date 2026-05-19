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
import { loadFile, saveFile } from "@zkscatter/sdk/storage";
import { useActiveNetwork } from "./activeNetwork";
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
   *  on-chain `PrivateClaim` events. Optional because seeded demo
   *  rows don't carry it. */
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
  /** Material the user needs to claim once the order settles.
   *  Optional because seeded demo rows don't carry it. */
  claim?: OrderClaim;
  /** Authorize-circuit nonce used at order-submit time. Required
   *  later for the cancel proof (the cancel circuit publishes
   *  `nonceNullifier(secret, nonce)` to kill *this* order
   *  specifically). Optional because seeded demo rows don't carry
   *  it. */
  nonce?: bigint;
  /** Vault note id that funded the order — needed by the cancel
   *  flow to look up the spending note and rotate it. */
  noteId?: string;
  /** When the order was submitted (ms epoch). */
  createdAt: number;
}

interface OrdersState {
  orders: OrderRecord[];
  add(
    o: Omit<OrderRecord, "id" | "label" | "createdAt" | "status">,
  ): OrderRecord;
  /** Mark an order as claimed. Idempotent. */
  markClaimed(id: string): void;
  /** Mark an order as cancelled. Only valid for `matching` orders;
   *  no-op when the order is already filled / claimed / cancelled. */
  markCancelled(id: string): void;
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
export interface WireOrder {
  id: string;
  label: string;
  side: "sell" | "buy";
  pair: string;
  price: string;
  size: string;
  status: OrderStatus;
  claim?: {
    secretHex: string;
    recipient: string;
    token: string;
    amountHex: string;
    releaseTimeHex: string;
    leafIndex: number;
    claimsRoot?: string;
  };
  nonceHex?: string;
  noteId?: string;
  createdAt: number;
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
    claim: o.claim
      ? {
          secretHex: bigintToHex(o.claim.secret),
          recipient: o.claim.recipient,
          token: o.claim.token,
          amountHex: bigintToHex(o.claim.amount),
          releaseTimeHex: bigintToHex(o.claim.releaseTime),
          leafIndex: o.claim.leafIndex,
          claimsRoot: o.claim.claimsRoot,
        }
      : undefined,
    nonceHex: o.nonce !== undefined ? bigintToHex(o.nonce) : undefined,
    noteId: o.noteId,
    createdAt: o.createdAt,
  };
}

export function deserialize(w: WireOrder): OrderRecord {
  return {
    id: w.id,
    label: w.label,
    side: w.side,
    pair: w.pair,
    price: w.price,
    size: w.size,
    status: w.status,
    claim: w.claim
      ? {
          secret: BigInt(w.claim.secretHex),
          recipient: w.claim.recipient,
          token: w.claim.token,
          amount: BigInt(w.claim.amountHex),
          releaseTime: BigInt(w.claim.releaseTimeHex),
          leafIndex: w.claim.leafIndex,
          claimsRoot: w.claim.claimsRoot,
        }
      : undefined,
    nonce: w.nonceHex !== undefined ? BigInt(w.nonceHex) : undefined,
    noteId: w.noteId,
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
}

/** Folder-backed orders adapter. Persists every order as a single
 *  aggregate JSON file `zkscatter-pro-orders-{chainId}.json` in the
 *  active notes folder — same folder Pay's run records and the
 *  shared address book live in, so the user has one place to back
 *  up. In-memory map mirrors the file so a put → loadAll round-
 *  trip doesn't hit disk twice.
 *
 *  IO injection (`io`) exists for tests; production callers omit
 *  it and the helpers default to the SDK's folder primitives. */
export function createFolderOrdersAdapter(
  chainId: number,
  io: {
    loadFile: (name: string) => Promise<string | null>;
    saveFile: (name: string, content: string) => Promise<void>;
  } = { loadFile, saveFile },
): OrdersAdapter {
  const filename = `zkscatter-pro-orders-${chainId}.json`;
  const warn = makeWarner();
  const mem = new Map<string, OrderRecord>();
  let loadedPromise: Promise<void> | null = null;
  // True when the on-disk file existed but couldn't be parsed.
  // `put()` refuses to flush in that state — otherwise the next
  // write would replace the corrupt-but-recoverable file with
  // {only the new order}, destroying every previously-persisted
  // order beyond recovery.
  let loadCorrupted = false;

  function ensureLoaded(): Promise<void> {
    if (loadedPromise) return loadedPromise;
    loadedPromise = (async () => {
      let content: string | null;
      try {
        content = await io.loadFile(filename);
      } catch (e) {
        // Any loadFile failure (transient permission revoke, file
        // held open by the OS, etc.) means we don't know what's on
        // disk. Marking corrupt prevents the next put() from
        // overwriting whatever the file actually contained.
        loadCorrupted = true;
        // eslint-disable-next-line no-console
        console.error(
          `[scatter pro orders] ${filename} loadFile rejected — refusing further writes to avoid overwriting recoverable data`,
          e,
        );
        return;
      }
      if (!content) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        loadCorrupted = true;
        // eslint-disable-next-line no-console
        console.error(
          `[scatter pro orders] ${filename} is not valid JSON — refusing further writes to avoid overwriting recoverable data`,
          e,
          { rawHead: content.slice(0, 200) },
        );
        return;
      }
      if (!Array.isArray(parsed)) {
        // JSON parsed but isn't the expected `WireOrder[]` shape
        // (e.g. someone wrote `null` or a single object into the
        // file). Same posture as a parse failure: don't overwrite.
        loadCorrupted = true;
        // eslint-disable-next-line no-console
        console.error(
          `[scatter pro orders] ${filename} is not a JSON array — refusing further writes`,
          { actualType: parsed === null ? "null" : typeof parsed },
        );
        return;
      }
      const wire = parsed as WireOrder[];
      for (const w of wire) {
        if (!w || typeof w.id !== "string") {
          warn(`skipping malformed order <no id>`);
          continue;
        }
        try {
          mem.set(w.id, deserialize(w));
        } catch (e) {
          warn(`skipping malformed order ${w.id}`, e);
        }
      }
    })();
    return loadedPromise;
  }

  async function flush(): Promise<void> {
    if (loadCorrupted) return;
    try {
      const wire = Array.from(mem.values())
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(serialize);
      await io.saveFile(filename, JSON.stringify(wire, null, 2));
    } catch (e) {
      warn("folder put failed", e);
    }
  }

  return {
    async loadAll() {
      await ensureLoaded();
      return Array.from(mem.values()).sort((a, b) => a.createdAt - b.createdAt);
    },
    async put(o) {
      await ensureLoaded();
      if (loadCorrupted) {
        warn("refusing put: backing file is corrupt — repair or remove it");
        return;
      }
      mem.set(o.id, o);
      await flush();
    },
  };
}

export function OrdersProvider({ children }: { children: React.ReactNode }) {
  const { network } = useActiveNetwork();
  const chainId = network.chainId;
  // OrdersProvider mounts inside <FolderGate>, so a folder is
  // guaranteed by the time this runs. Adapter is folder-only — no
  // IDB fallback. Switching chains creates a fresh adapter against
  // the per-chain file in the same folder.
  const adapter = useMemo(
    () => createFolderOrdersAdapter(chainId),
    [chainId],
  );

  const [orders, setOrders] = useState<OrderRecord[]>([]);
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

  // Track which order ids already have a pending promotion timer so
  // we don't double-schedule on every `orders` change (the array
  // identity changes on any add / mark*, which would otherwise leak
  // a new timer per matching row per state transition).
  const scheduledIds = useRef<Set<string>>(new Set());

  // Demo lifecycle: matching → claimable 8 s after createdAt.
  // Schedules a one-shot timer per matching order we haven't
  // scheduled yet. Persists the transition through the adapter.
  useEffect(() => {
    const timers = promoteTimers.current;
    const scheduled = scheduledIds.current;
    for (const o of orders) {
      if (o.status !== "matching") continue;
      if (scheduled.has(o.id)) continue;
      const elapsed = Date.now() - o.createdAt;
      const remaining = Math.max(0, 8_000 - elapsed);
      const id = o.id;
      const handle = setTimeout(() => {
        timers.delete(handle);
        scheduled.delete(id);
        const target = ordersRef.current.find((x) => x.id === id);
        if (!target || target.status !== "matching") return;
        const promoted: OrderRecord = { ...target, status: "claimable" };
        adapter.put(promoted);
        setOrders((prev) => prev.map((x) => (x.id === id ? promoted : x)));
      }, remaining);
      timers.add(handle);
      scheduled.add(id);
    }
  }, [orders, adapter]);

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

  const value = useMemo<OrdersState>(
    () => ({ orders, add, markClaimed, markCancelled }),
    [orders, add, markClaimed, markCancelled],
  );

  return <OrdersCtx.Provider value={value}>{children}</OrdersCtx.Provider>;
}
