/** Client for the shared-orderbook claim-nullifier indexer
 *  (`/api/claim-nullifiers`). Given a list of claim nullifiers, returns the
 *  subset already spent on-chain — one batch request instead of an RPC
 *  `claimNullifiers` call per leaf (which trips public-node 429s).
 *
 *  Uses POST: a real batch (an order can have 128 recipients → ~8.6 KB of hex)
 *  would blow past proxy/CDN request-target limits as a GET query string. */

export interface FetchSpentClaimNullifiersOptions {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** POST the nullifier list to the indexer and return the spent subset as a
 *  lowercase-hex Set. Throws on any non-2xx, network error, or malformed
 *  payload so the caller can fall back to an RPC probe — a bad/incomplete
 *  server response is never silently trusted (nullifiers are monotonic, so a
 *  false "not spent" would otherwise invite a doomed re-claim). An empty input
 *  short-circuits to an empty set with no request. */
export async function fetchSpentClaimNullifiers(
  serverUrl: string,
  chainId: number | bigint,
  nullifiers: readonly string[],
  options?: FetchSpentClaimNullifiersOptions,
): Promise<Set<string>> {
  if (nullifiers.length === 0) return new Set();
  const doFetch = options?.fetchImpl ?? fetch;
  const base = serverUrl.replace(/\/$/, "");

  const res = await doFetch(`${base}/api/claim-nullifiers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId: Number(chainId), nullifiers }),
  });
  if (!res.ok) throw new Error(`claim-nullifiers endpoint returned ${res.status}`);
  const body = (await res.json()) as { spent?: unknown };
  if (!Array.isArray(body.spent)) {
    throw new Error("claim-nullifiers endpoint: malformed payload");
  }
  return new Set((body.spent as string[]).map((n) => n.toLowerCase()));
}
