import { promises as dns } from "dns";
import net from "net";

/**
 * SSRF guard for relayer URLs that the shared orderbook accepts via the
 * `x-relayer-url` header (registration + auto-register on order POST)
 * and that the zk-relayer later `fetch`es when matching cross-relayer
 * orders.
 *
 * Background: registration is authenticated only by an EIP-191
 * signature — there is no allow-list and `RelayerRegistry.minBond`
 * defaults to 0, so any caller with any Ethereum keypair can register
 * any URL. Without this guard a hostile registrant could pin the
 * registry's `relayerUrl` to `http://127.0.0.1:8545`, an internal RPC,
 * or the cloud metadata endpoint, and every other relayer that fans a
 * trade-offer out to the matched maker would issue an outbound HTTP
 * POST to that target.
 *
 * The guard:
 *   - Rejects non-http(s) schemes.
 *   - Rejects literal IP hostnames in private / loopback / link-local /
 *     CGNAT / IPv4-mapped-v6 ranges (covers `127.0.0.1`, `10.x.x.x`,
 *     `169.254.169.254` IMDSv1, ULA `fc00::/7`, etc.).
 *   - DNS-resolves bare hostnames and rejects when any returned A/AAAA
 *     record falls in the same forbidden ranges.
 *
 * DNS-rebinding (host resolves safely once at register time, then
 * resolves to a private IP at fetch time) is mitigated by re-running
 * the same guard before every outbound `fetch` — see callers in
 * `zk-relayer/src/core/authorize-cross-relayer-matcher.ts` and
 * `shared-orderbook-client.ts`. We don't pin the looked-up IP into a
 * custom dispatcher because the bounded gap between two adjacent
 * lookups is acceptable for the trust model (semi-trusted peer
 * relayers, not internet-wide attackers).
 *
 * Redirect bypass: this guard only vets the URL it is handed, so a peer
 * that registers a benign public host could still 30x-redirect the
 * outbound request to a private IP / metadata endpoint. The guard alone
 * cannot see that — callers MUST pass `redirect: "error"` to `fetch`
 * (peer endpoints are machine-to-machine JSON APIs that never
 * legitimately redirect).
 *
 * Dev escape hatch: `scripts/dev.sh` sets
 * `ALLOW_PRIVATE_RELAYER_URLS=1` so local stacks can register
 * `http://localhost:3002` style URLs. The flag MUST stay unset in
 * production deployments. */

function allowPrivate(): boolean {
  return process.env.ALLOW_PRIVATE_RELAYER_URLS === "1";
}

function isForbiddenIp(addr: string): boolean {
  if (net.isIPv4(addr)) {
    const parts = addr.split(".").map(Number);
    const a = parts[0]!;
    const b = parts[1]!;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + IMDSv1
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (net.isIPv6(addr)) {
    const lower = addr.toLowerCase();
    if (lower === "::1" || lower === "::") return true;

    // Unique local (fc00::/7) — both `fc..` and `fd..` first byte.
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;

    // Link-local fe80::/10 covers the entire `fe80::` .. `febf::` band,
    // so a prefix-on-`fe80` check would miss `fe9*` / `fea*` / `feb*`.
    // The first hextet is `fe` + a hex nibble whose top two bits are
    // `10` → 0x80..0xbf, i.e. characters 8..b. We tolerate any zero-
    // pad form by reading just the two chars after `fe`.
    if (lower.startsWith("fe") && lower.length >= 4) {
      const c = lower.charCodeAt(2);
      // hex 8 (0x38) .. b (0x62) — covers '8','9','a','b'
      if ((c >= 0x38 && c <= 0x39) || (c >= 0x61 && c <= 0x62)) return true;
    }

    // IPv4-mapped IPv6 — accept both dotted-quad (`::ffff:127.0.0.1`)
    // and hex (`::ffff:7f00:1`) forms. Inspect the last 32 bits regardless
    // of representation: split on `:` and grab the trailing two hextets.
    if (lower.startsWith("::ffff:")) {
      const tail = lower.slice(7);
      if (net.isIPv4(tail)) return isForbiddenIp(tail);
      const segs = tail.split(":");
      if (segs.length === 2) {
        const hi = parseInt(segs[0] ?? "", 16);
        const lo = parseInt(segs[1] ?? "", 16);
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
          const a = (hi >> 8) & 0xff;
          const b = hi & 0xff;
          const c = (lo >> 8) & 0xff;
          const d = lo & 0xff;
          return isForbiddenIp(`${a}.${b}.${c}.${d}`);
        }
      }
    }
    return false;
  }
  return false;
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

/**
 * Async — preferred for both registration and outbound-fetch paths.
 * Resolves the hostname via DNS and rejects if any record points at a
 * forbidden range. Throws `UnsafeUrlError` on rejection so callers can
 * distinguish from generic network errors.
 */
export async function assertSafeOutboundUrl(rawUrl: string): Promise<URL> {
  const url = parseHttpUrl(rawUrl);
  if (allowPrivate()) return url;

  const hostname = url.hostname;
  if (net.isIP(hostname)) {
    if (isForbiddenIp(hostname)) {
      throw new UnsafeUrlError(`URL hostname ${hostname} is a private/loopback IP`);
    }
    return url;
  }

  let addresses: string[];
  try {
    const records = await dns.lookup(hostname, { all: true });
    addresses = records.map((r) => r.address);
  } catch (e) {
    throw new UnsafeUrlError(
      `DNS lookup failed for ${hostname}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  for (const addr of addresses) {
    if (isForbiddenIp(addr)) {
      throw new UnsafeUrlError(
        `URL hostname ${hostname} resolves to a private/loopback IP (${addr})`,
      );
    }
  }
  return url;
}

function parseHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError(`URL protocol ${url.protocol} not allowed (http/https only)`);
  }
  if (!url.hostname) throw new UnsafeUrlError("URL hostname is empty");
  return url;
}
