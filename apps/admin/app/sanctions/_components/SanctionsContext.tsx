"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Contract, type EventLog, type Log } from "ethers";
import { useWallet } from "@zkscatter/sdk/react";
import { normalizeEvmAddress } from "../../lib/x509";

// Combined ABI: events for the scan path + view fns for the contract-info
// summary. Keeping them in one Contract instance per provider means a single
// queryFilter + view-fn batch on each refresh instead of three sibling
// useEffects each instantiating their own Contract.
const ABI = [
  "event AddressSanctioned(address indexed addr)",
  "event AddressUnsanctioned(address indexed addr)",
  "function owner() external view returns (address)",
  "function externalOracle() external view returns (address)",
];

export const LOOKBACK_OPTIONS: Array<{ label: string; blocks: bigint }> = [
  { label: "10k blocks", blocks: 10_000n },
  { label: "100k blocks", blocks: 100_000n },
  { label: "1M blocks", blocks: 1_000_000n },
  { label: "Full history", blocks: 0n },
];

export interface EventRow {
  kind: "add" | "remove";
  address: string;
  block: number;
  txIndex: number;
  logIndex: number;
  txHash: string;
}

interface SanctionsData {
  events: EventRow[];
  /** Lowercase addresses currently in the self-list, derived from
   *  event replay. Empty during the very first load. */
  currentSet: Set<string>;
  /** Block of the add that put each currently-listed address into the
   *  set — i.e. the latest add since the last remove. An address
   *  added → removed → re-added thus shows the re-add block, not the
   *  stale initial one. Limited to the scan window. */
  activeAddBlock: Map<string, number>;
  /** Contract owner — cached so ContractInfo and AdminBadge don't
   *  re-issue the same RPC. `null` until first load completes. */
  owner: string | null;
  /** External-oracle slot value — shared with the oracle-health probe
   *  so a single read drives the stat card + the probe input. */
  externalOracle: string | null;
  loading: boolean;
  /** Non-fatal warning (e.g. one of the two queryFilter calls
   *  rejected so the set is partial). Render alongside data. */
  warning: string | null;
  error: string | null;
  lookback: bigint;
  setLookback: (n: bigint) => void;
  refresh: () => void;
}

const SanctionsCtx = createContext<SanctionsData | null>(null);

interface ProviderProps {
  address: string;
  children: ReactNode;
}

/** Pull a 0x-address string out of a PromiseSettledResult, treating
 *  any non-string or malformed value as `null`. Delegates to
 *  `normalizeEvmAddress` so address validation has a single source
 *  of truth across user-input paths (LookupPanel/WritePanel) and
 *  RPC-decode paths (here). */
function extractAddress(res: PromiseSettledResult<string>): string | null {
  if (res.status !== "fulfilled") return null;
  const v = res.value as unknown;
  return typeof v === "string" ? normalizeEvmAddress(v) : null;
}

function toRow(e: EventLog | Log, kind: "add" | "remove"): EventRow | null {
  if (!("args" in e) || e.args?.addr == null) return null;
  return {
    kind,
    address: (e.args.addr as string).toLowerCase(),
    block: e.blockNumber,
    txIndex: e.transactionIndex,
    logIndex: e.index,
    txHash: e.transactionHash,
  };
}

/** Replay a chronologically-ordered event stream into (a) the set of
 *  currently-listed addresses and (b) the block number of the add
 *  that put each one there. Exported so the invariant — every add
 *  overwrites the block; every remove drops both set + map entry,
 *  so an `add → remove → re-add` cycle records the re-add block,
 *  not the stale initial one — is unit-testable. */
export function deriveSelfList(events: ReadonlyArray<EventRow>): {
  currentSet: Set<string>;
  activeAddBlock: Map<string, number>;
} {
  const set = new Set<string>();
  const activeAdd = new Map<string, number>();
  for (const r of events) {
    if (r.kind === "add") {
      set.add(r.address);
      activeAdd.set(r.address, r.block);
    } else {
      set.delete(r.address);
      activeAdd.delete(r.address);
    }
  }
  return { currentSet: set, activeAddBlock: activeAdd };
}

function compareEvents(a: EventRow, b: EventRow): number {
  if (a.block !== b.block) return a.block - b.block;
  if (a.txIndex !== b.txIndex) return a.txIndex - b.txIndex;
  return a.logIndex - b.logIndex;
}

export function SanctionsProvider({ address, children }: ProviderProps) {
  const { readProvider } = useWallet();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [owner, setOwner] = useState<string | null>(null);
  const [externalOracle, setExternalOracle] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lookback, setLookback] = useState<bigint>(100_000n);
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setWarning(null);
    setError(null);

    async function load() {
      try {
        const contract = new Contract(address, ABI, readProvider);
        const head = BigInt(await readProvider.getBlockNumber());
        // lookback === 0n means "full history" — start from genesis.
        const from = lookback === 0n ? 0n : head > lookback ? head - lookback : 0n;
        const [addsRes, removesRes, ownerRes, oracleRes] = await Promise.allSettled([
          contract.queryFilter(contract.filters.AddressSanctioned(), from, head),
          contract.queryFilter(contract.filters.AddressUnsanctioned(), from, head),
          contract.owner() as Promise<string>,
          contract.externalOracle() as Promise<string>,
        ]);
        if (cancelled) return;

        // If either event-side query rejected, the derived set is
        // corrupt: missing adds under-report sanctioned addresses,
        // missing removes leave already-cleared addresses listed as
        // live. Surface as a hard error and clear `events` rather
        // than rendering an incomplete CurrentSetTable behind a
        // yellow warning that operators may overlook.
        if (addsRes.status === "rejected" || removesRes.status === "rejected") {
          const which = [
            addsRes.status === "rejected" ? "additions" : null,
            removesRes.status === "rejected" ? "removals" : null,
          ]
            .filter(Boolean)
            .join(" + ");
          setEvents([]);
          setOwner(extractAddress(ownerRes));
          setExternalOracle(extractAddress(oracleRes));
          setWarning(null);
          setError(
            `Event scan failed for ${which} — derived self-list suppressed to avoid acting on stale data. Try a narrower lookback or check the RPC.`,
          );
          setLoading(false);
          return;
        }

        const rows: EventRow[] = [];
        for (const e of addsRes.value) {
          const r = toRow(e, "add");
          if (r) rows.push(r);
        }
        for (const e of removesRes.value) {
          const r = toRow(e, "remove");
          if (r) rows.push(r);
        }
        rows.sort(compareEvents);

        setEvents(rows);
        // Type-guard the RPC return: ethers v6 ABI-decodes address
        // returns to checksummed strings, but defend against a
        // malicious / misbehaving RPC returning the wrong shape. A
        // garbage `as string` cast downstream would corrupt
        // shortAddr / eqAddr comparisons in the badge / lookup.
        setOwner(extractAddress(ownerRes));
        setExternalOracle(extractAddress(oracleRes));
        setWarning(null);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [address, readProvider, lookback, reloadKey]);

  // Derive current set + active-add-block index. Pure function so
  // the invariant ("active block = latest add since last remove") is
  // unit-testable without spinning up the React provider.
  const { currentSet, activeAddBlock } = useMemo(() => deriveSelfList(events), [events]);

  // Memoize the context value so consumers re-render only when
  // something they actually read has changed. Without this, every
  // SanctionsProvider re-render (e.g. on reloadKey bump that doesn't
  // alter data) cascades a re-render through every consumer.
  const value = useMemo<SanctionsData>(
    () => ({
      events,
      currentSet,
      activeAddBlock,
      owner,
      externalOracle,
      loading,
      warning,
      error,
      lookback,
      setLookback,
      refresh,
    }),
    [
      events,
      currentSet,
      activeAddBlock,
      owner,
      externalOracle,
      loading,
      warning,
      error,
      lookback,
      refresh,
    ],
  );

  return <SanctionsCtx.Provider value={value}>{children}</SanctionsCtx.Provider>;
}

export function useSanctions(): SanctionsData {
  const ctx = useContext(SanctionsCtx);
  if (!ctx) throw new Error("useSanctions must be used inside <SanctionsProvider>");
  return ctx;
}
