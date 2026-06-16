/** Client for the shared-orderbook claim-nullifier indexer
 *  (`/api/claim-nullifiers`). Given a list of claim nullifiers, returns the
 *  subset already spent on-chain — one batch request instead of an RPC
 *  `claimNullifiers` call per leaf (which trips public-node 429s).
 *
 *  Uses POST: a real batch (an order can have 128 recipients → ~8.6 KB of hex)
 *  would blow past proxy/CDN request-target limits as a GET query string. */

/** Max nullifiers per request — stays under the endpoint's 512 cap so an
 *  arbitrarily large inbox is paged instead of 400-ing. */
const MAX_PER_REQUEST = 500;

export interface FetchSpentClaimNullifiersOptions {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** POST the nullifier list to the indexer and return the spent subset as a
 *  lowercase-hex Set. Dedupes and pages the input into requests of at most
 *  {@link MAX_PER_REQUEST} so a large inbox doesn't exceed the endpoint's cap.
 *  Throws on any non-2xx, network error, or malformed payload so the caller can
 *  fall back to an RPC probe — a bad/incomplete server response is never
 *  silently trusted (nullifiers are monotonic, so a false "not spent" would
 *  otherwise invite a doomed re-claim). An empty input short-circuits to an
 *  empty set with no request. */
export async function fetchSpentClaimNullifiers(
  serverUrl: string,
  chainId: number | bigint,
  nullifiers: readonly string[],
  options?: FetchSpentClaimNullifiersOptions,
): Promise<Set<string>> {
  if (nullifiers.length === 0) return new Set();
  const doFetch = options?.fetchImpl ?? fetch;
  const base = serverUrl.replace(/\/$/, "");
  // Dedupe (the same nullifier can appear twice — e.g. two inbox entries that
  // share secret+leafIndex) and lowercase to the canonical form before paging.
  const unique = [...new Set(nullifiers.map((n) => n.toLowerCase()))];

  const spent = new Set<string>();
  for (let i = 0; i < unique.length; i += MAX_PER_REQUEST) {
    const chunk = unique.slice(i, i + MAX_PER_REQUEST);
    const res = await doFetch(`${base}/api/claim-nullifiers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId: Number(chainId), nullifiers: chunk }),
    });
    if (!res.ok) throw new Error(`claim-nullifiers endpoint returned ${res.status}`);
    const body = (await res.json()) as { chainId?: unknown; spent?: unknown };
    // Guard against a misrouted/cached response for a different chain mixing
    // spent state across networks. The endpoint echoes the request chainId.
    if (body.chainId !== undefined && Number(body.chainId) !== Number(chainId)) {
      throw new Error(
        `claim-nullifiers endpoint: chainId mismatch (got ${String(body.chainId)}, want ${chainId})`,
      );
    }
    if (!Array.isArray(body.spent)) {
      throw new Error("claim-nullifiers endpoint: malformed payload");
    }
    // Defensively keep only string elements before lowercasing — a stray
    // non-string (schema drift / DB anomaly) would otherwise throw a TypeError.
    for (const n of body.spent) {
      if (typeof n === "string") spent.add(n.toLowerCase());
    }
  }
  return spent;
}
