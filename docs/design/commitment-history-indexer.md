# Commitment-history indexer (server-served Merkle leaves)

**Status:** proposed
**Author:** (design)
**Related:** `packages/sdk/src/core/pool.ts` (`loadCommitmentInsertedHistory`),
`packages/sdk/src/react/commitmentTree.tsx`, `shared-orderbook/src/verify.ts`,
`shared-orderbook/src/core/verify-runtime.ts`

## Problem

Every frontend rebuilds the on-chain commitment Merkle tree client-side by
scanning **all** `CommitmentInserted` events and replaying them into an
`IncrementalMerkleTree`. The scan runs in the browser via `eth_getLogs`.

This has two failure modes on the keyless public-node default:

1. **Range cap.** A single `getLogs` over `[0, latest]` (or even
   `[deployBlock, latest]` once the chain advances) exceeds public Sepolia's
   50 000-block cap → `exceed maximum block range: 50000` → the tree never
   hydrates and spend flows see an empty tree.
2. **Cost / latency.** As the pool grows, every client re-scans the whole
   history on every load — N clients × full-history `getLogs`, rate-limited and
   slow.

A first fix already shipped (chunked `getLogs` from the pool deploy block — see
`loadCommitmentInsertedHistory`). That keeps the **client path** correct and is
the right *fallback*, but it doesn't remove the per-client full re-scan. The
durable answer is to index the history **once, server-side**, and serve it.

## Why not The Graph / a subgraph

A subgraph is real extra infra (graph-node + postgres + IPFS, or Subgraph
Studio + API keys) and breaks the "wallet-only, no infra" property of the dev
setup. We already run a central, chain-aware indexer — the **settlement
verifier** (`shared-orderbook/src/verify.ts`) — that scans events in windowed
`getLogs` passes and writes to a shared SQLite DB. The commitment indexer is the
same shape pointed at a different event, so we reuse that pattern instead of
standing up The Graph.

## Architecture

Mirror the existing **verifier split**:

```
┌─────────────────────────┐        ┌──────────────────────────────┐
│ commitment-indexer      │  write │ shared-orderbook SQLite DB    │
│ (separate entrypoint,   │───────▶│   commitments(chainId, leaf…) │
│  watch-loop, has RPC)   │        │   commitment_cursor(chainId…) │
└─────────────────────────┘        └──────────────┬───────────────┘
                                                   │ read
                                    ┌──────────────▼───────────────┐
                                    │ shared-orderbook API (:4000)  │
                                    │   GET /api/commitments        │
                                    └──────────────┬───────────────┘
                                                   │ HTTP (fetch)
                                    ┌──────────────▼───────────────┐
                                    │ SDK loadCommitmentInserted…   │
                                    │   try server → fallback getLogs│
                                    └───────────────────────────────┘
```

The indexer is a **separate process** (`npm run index:commitments`), exactly
like `npm run verify` today. The main API server (`src/index.ts`) stays
RPC-free and only **reads** the DB to serve `/api/commitments`. They share the
SQLite file, so the API never touches the chain.

### Why the shared-orderbook server (not the relayer)

- It's the **central, always-on** service the frontends already hit
  (`SCATTER_ORDERBOOK_URL`, :4000), and it's already **chainId-multitenant**.
- The relayer (:3002) is per-relayer and may be plural; it's about order
  matching / claims, not a canonical read store.
- The verifier infra to copy already lives here.

## Data model (SQLite, in `shared-orderbook/src/core/db.ts`)

```sql
CREATE TABLE IF NOT EXISTS commitments (
  chainId     INTEGER NOT NULL,
  leafIndex   INTEGER NOT NULL,
  commitment  TEXT    NOT NULL,   -- 0x-hex of the uint256
  blockNumber INTEGER NOT NULL,
  PRIMARY KEY (chainId, leafIndex)
);

-- one row per chain: how far the indexer has scanned
CREATE TABLE IF NOT EXISTS commitment_cursor (
  chainId        INTEGER PRIMARY KEY,
  lastScanBlock  INTEGER NOT NULL
);
```

`leafIndex` is the natural monotonic key (the pool inserts monotonically), so
`(chainId, leafIndex)` as PK gives idempotent upserts — a re-scanned window
overwrites identical rows instead of duplicating. Storing `blockNumber` lets the
cursor resume and aids debugging.

> **No separate `(chainId, leafIndex)` index.** The PRIMARY KEY already builds
> the index that `WHERE chainId=? AND leafIndex>=? ORDER BY leafIndex` uses — a
> second one would be dead weight on every write.

> **Multi-process SQLite.** With the indexer added there are now **three**
> processes on one DB file: the API (reads), the settlement verifier (writes),
> and this indexer (writes). WAL is already on (`journal_mode = WAL`) but
> `busy_timeout` is **not** — without it a write that collides with the other
> writer throws `SQLITE_BUSY` immediately instead of waiting. Set
> `busy_timeout = 5000` in `db.ts` before running two writers.

All access uses better-sqlite3 **prepared statements with bound params** — never
string-interpolate `chainId` / `fromLeaf` / `limit`.

DB methods to add:
- `upsertCommitments(rows: {chainId, leafIndex, commitment, blockNumber}[])`
  (single transaction, `INSERT … ON CONFLICT(chainId,leafIndex) DO UPDATE`).
- `listCommitments(chainId, fromLeaf, limit)` → ordered by `leafIndex ASC`.
- `getCommitmentCursor(chainId)` / `setCommitmentCursor(chainId, block)`.
- `maxCommitmentLeaf(chainId)` → for the response's `total`.

## Indexer loop (`shared-orderbook/src/core/commitment-indexer.ts`)

Reuse the `runVerifyLoop` skeleton (`verify-runtime.ts`): immediate first pass,
`intervalSec` sleep, abort-signal aware, errors logged but non-fatal.

Per pass, per chain:
1. `latest = provider.getBlockNumber() - blockSafetyMargin` (reorg margin, as
   the verifier does).
2. `from = max(deployBlock, cursor.lastScanBlock + 1)`; `to = latest`.
3. Walk `[from, to]` in **≤50 000-block windows** (the same cap the SDK uses),
   `queryFilter(CommitmentInserted, start, end)`, project `{leafIndex,
   commitment, blockNumber}`.
4. `upsertCommitments(rows)` then `setCommitmentCursor(chainId, end)` **after
   each window** (so a crash mid-backfill resumes, not restarts).

**Backfill speed (optimization).** Because the PK is `(chainId, leafIndex)`,
upserts are **order-independent and idempotent**, so the *initial* backfill may
run windows with **bounded concurrency** (mirror the verifier's `CONCURRENCY =
8`) to cut first-sync wall-clock. The cursor must then advance to the lowest
*contiguous* completed window (don't jump the cursor past a still-in-flight
gap). Steady-state tail scanning stays sequential and tiny.

**Reorg.** `blockSafetyMargin` keeps the cursor a few confirmations behind head.
A reorg that *shrinks* the leaf set could leave stale high-`leafIndex` rows; if
a pass sees the on-chain leaf count (`pool.nextIndex()` / event tail) below the
stored max, prune rows above it. The client-side root check (below) is the
backstop regardless.

Config mirrors `verify.ts`'s `CHAINS` JSON, with two new per-chain fields:

```jsonc
// COMMITMENT_CHAINS (JSON array) — else single-chain env fallback
[{ "chainId": 11155111,
   "rpcUrl": "https://…",
   "commitmentPoolAddress": "0xa711…2150",
   "deployBlock": 11008264 }]
```

Single-chain env fallback: `RPC_URL`, `COMMITMENT_POOL_ADDRESS`,
`COMMITMENT_DEPLOY_BLOCK`, `CHAIN_ID`.

ABI: a one-line hand-written fragment for `CommitmentInserted` (same
self-contained approach as `PRIVATE_SETTLED_AUTH_ABI`) — no artifact dep.

## Read endpoint (`shared-orderbook/src/routes/commitments.ts`)

```
GET /api/commitments?chainId=<id>&fromLeaf=<n>&limit=<n>
→ 200 {
    chainId, fromLeaf,
    total,                       // max leafIndex+1 known for the chain
    commitments: [ { leafIndex, commitment, blockNumber }, … ]  // leafIndex ASC
  }
```

- `chainId` required (consistent with `/api/orders?chainId=`). Validate it
  parses to a **non-negative integer**; reject `NaN`/negative with 400.
- `fromLeaf` (default 0) enables **incremental** fetch: a client that already
  has leaves 0..k requests `fromLeaf=k+1`. Same non-negative-integer validation.
- `limit` (default e.g. 5000) is **hard-capped** server-side (e.g. 10 000) so a
  `limit=10^9` can't force a giant query/response; clients page with `fromLeaf`.
- Read-limiter + CORS, same as other public GETs. Prepared-statement params
  only.

## SDK change (fetch-first, getLogs-fallback)

`loadCommitmentInsertedHistory` gains an optional `serverUrl`. Behaviour:

1. If `serverUrl` set: page `GET /api/commitments?chainId&fromLeaf` until
   `commitments.length < limit`, assemble rows. On **any** failure (non-2xx,
   network, shape mismatch) → fall through to (2).
2. Else / on fallback: the existing chunked `getLogs` from `fromBlock`.

Either path then hits the **required `isKnownRoot` check** (above) before the
tree is marked `ready`; a server path that fails the check auto-falls-back to
`getLogs`. `chainId` is read from the provider (`provider.getNetwork()`), or
passed by the caller. The React provider gets a `serverUrl?` prop; pay/pro pass
`SCATTER_ORDERBOOK_URL`.

**Client leaf cache (optimization, later).** Combine `fromLeaf` with a per
-`(chainId, poolAddress)` localStorage/IndexedDB cache of fetched leaves: on
reload, fetch only the tail (`fromLeaf = cachedCount`). The `isKnownRoot` check
makes a poisoned/stale cache self-detecting (mismatch → drop cache, re-fetch).

### Trust: REQUIRED on-chain root verification (new — closes a pre-existing gap)

The server is **untrusted convenience, not authority** — but the current code
does **not** actually verify that, and the original draft of this design wrongly
claimed it did. Today hydration's only integrity check is `idx !== row.leafIndex`
(contiguous insertion order). That catches a dropped/reordered log **only if it
breaks `leafIndex` contiguity**; it does **not** catch a *self-consistent but
wrong* leaf set — a substituted commitment value at some index, or a truncated
tail. Such a tree has contiguous indices but a root that diverges from chain.

With a wallet RPC as the (semi-trusted) source this was a tolerated DoS: a wrong
tree just fails at settle time. Promoting a **central server** to leaf source
raises the blast radius — one compromised orderbook could feed every client a
subtly-wrong tree → mass settlement failures + wasted gas. So this design
**requires** a verification step, applied to **both** the server and `getLogs`
paths:

> After hydration, two cheap `eth_call`s (work on a public node), required
> before `ready`:
> 1. **`pool.isKnownRoot(localRoot)` must be `true`** — catches a *substituted*
>    commitment value (the resulting root isn't any root the pool ever had).
> 2. **`localLeafCount >= pool.nextIndex() − margin`** — catches a *truncated
>    tail*. `margin` is a few leaves to tolerate inserts landing mid-scan.
>
> On failure from the server path → **fall back to `getLogs`** and re-check; if
> `getLogs` also fails, stay `not-ready` and surface the divergence.

Both checks are needed, and `isKnownRoot` alone is **not** sufficient:

- `isKnownRoot` (not `getLastRoot`) tolerates being a few leaves behind head —
  the pool keeps a root **history ring buffer** (`ROOT_HISTORY_SIZE`, default 30;
  ABI confirmed), so a slightly-stale client still matches a recent historical
  root without a false alarm.
- **But that tolerance is exactly the truncation hole:** a server that drops the
  last `k < ROOT_HISTORY_SIZE` leaves yields a root that *is* a legitimate past
  root → `isKnownRoot` returns `true`. The **`nextIndex()` leaf-count** check
  closes it: a truncated tree's count sits well below the on-chain count. (A
  depositor whose own note is in the dropped tail would otherwise just see
  "commitment not found" — an availability bug, not fund loss — but we detect it
  up front.)

These two eth_calls also harden the **existing** getLogs path, which has no root
check today.

### Privacy

Commitments are **public on-chain** and every client fetches the **whole** leaf
set regardless, so the endpoint exposes no per-user query — which leaf is "yours"
isn't revealed. It is **not** zero-leak though: like the wallet RPC it sees the
requester's IP and fetch timing. Net: **no more exposure than the wallet RPC the
getLogs path already uses**, and no on-chain-private data is served.

## Rollout

0. **Harden the existing client first:** add the `isKnownRoot` post-hydration
   check to today's `getLogs` path (ships independently of the server, closes the
   pre-existing trust gap, and is the safety net the rest of the rollout leans
   on). Also set `busy_timeout` in `db.ts`.
1. **Server, dark:** DB tables + indexer process + `GET /api/commitments`,
   deployed and backfilling. No client change yet; verify the endpoint returns
   leaves matching an on-chain scan.
2. **SDK opt-in:** add `serverUrl`; default it **off** so behaviour is identical
   until explicitly wired. Server path gated behind the same `isKnownRoot` check.
3. **Apps:** pay first (`serverUrl = SCATTER_ORDERBOOK_URL`), watch it hydrate
   from the server with the chunked `getLogs` fallback intact; then pro.
4. The shipped client chunking remains the permanent fallback for anyone not
   pointed at an orderbook (wallet-only, no infra).

## Testing

- **db:** upsert idempotency, `listCommitments` ordering + `fromLeaf` paging,
  cursor get/set.
- **indexer:** windowing from `deployBlock`, cursor resume after a simulated
  mid-backfill abort, idempotent re-scan (mock fetcher, no live RPC — mirror
  `verifier.test.ts`).
- **route:** chainId required, `fromLeaf`/`limit` paging, shape.
- **sdk:** server path assembles paged rows; falls back to `getLogs` on a 500 /
  bad shape; identical rows from either path. **Root check:** a tampered server
  set (wrong commitment / truncated tail) fails `isKnownRoot` and triggers
  `getLogs` fallback; a correct set passes. Extend `pool.test.ts`.

## Open questions

1. **Endpoint auth.** Public read like `/api/orders`, or relayer-auth? (Leaning
   public — data is on-chain.)
2. **`limit` default / hard cap** — balance round-trips vs payload size.
3. **Indexer cadence** (`intervalSec`) and `blockSafetyMargin` — reuse the
   verifier's defaults (e.g. 6 confirmations) or tune for the pool.
4. **Backfill block windows** — keep 50 000, or expose `INDEX_BLOCK_RANGE`
   (like the relayer's chunked-query) for keyed nodes that allow more?
```
