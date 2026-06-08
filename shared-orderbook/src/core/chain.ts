/**
 * Network (EVM chainId) helpers for the multi-tenant orderbook. One
 * shared-orderbook instance serves several chains (e.g. Sepolia 11155111 and
 * Ethereum mainnet 1); chain_id is the outermost partition on every
 * order / match / settlement so the networks stay isolated.
 */

/**
 * Sepolia. The single network these databases held before multitenancy, used
 * to backfill legacy rows and as the default when a client omits a chainId
 * (backward compatibility with pre-chainId relayers / frontends).
 */
export const DEFAULT_CHAIN_ID = 11155111;

/**
 * Coerce an untrusted value (query string, JSON body field) into a valid EVM
 * chainId — a positive integer within JS safe-integer range. Returns
 * `undefined` for nullish/empty input so callers can fall back to
 * DEFAULT_CHAIN_ID; throws RangeError on a present-but-invalid value so the
 * API can answer 400 rather than silently mis-scoping a query to the default
 * network.
 */
export function coerceChainId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`invalid chainId: ${String(value)}`);
  }
  return n;
}

/** Like {@link coerceChainId} but falls back to DEFAULT_CHAIN_ID on nullish input. */
export function chainIdOrDefault(value: unknown): number {
  return coerceChainId(value) ?? DEFAULT_CHAIN_ID;
}

/**
 * Parse a `?chainId=` query value for a read route. Absent → the default
 * network (backward compatibility); present-but-invalid → an Error for the
 * caller to bubble as a 400. Mirrors the `parseSinceQuery` shape the
 * settlement routes already use, so every read route handles chainId the
 * same way (consistent 400, not a 500 from an uncaught throw).
 */
export function parseChainIdQuery(raw: unknown): number | Error {
  try {
    return chainIdOrDefault(raw);
  } catch {
    return new Error("chainId: must be a positive integer");
  }
}
