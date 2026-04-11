import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "../../lib/rate-limit";

// 10 requests per minute per IP (claim submissions are infrequent)
const RATE_LIMIT = { limit: 10, windowMs: 60_000 };
const FETCH_TIMEOUT_MS = 30_000;

// Default relayer URL (server-only, not NEXT_PUBLIC_)
const DEFAULT_RELAYER_URL = process.env.ZK_RELAYER_URL || process.env.NEXT_PUBLIC_ZK_RELAYER_URL || "http://localhost:3002";

// Allowed relayer origins — only these can be proxied to.
// In production, populate from env or a registry contract query.
const ALLOWED_RELAYER_ORIGINS = (
  process.env.ALLOWED_RELAYER_ORIGINS?.trim()
    ? process.env.ALLOWED_RELAYER_ORIGINS.split(",")
    : [DEFAULT_RELAYER_URL]
).map(s => {
  try { return new URL(s.trim()).origin; } catch { return null; }
}).filter((s): s is string => s !== null);

/** Validate that a relayer URL is in the allowlist. */
function validateRelayerOrigin(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    if (ALLOWED_RELAYER_ORIGINS.includes(origin)) return origin;
  } catch { /* invalid URL */ }
  return null;
}

/**
 * POST /api/relay — server-side proxy to relayer's /api/private-claim.
 *
 * Why server-side:
 *   - Prevents client-side SSRF: user-provided relayer URLs are validated
 *     against an allowlist on the server, not in the browser (where checks
 *     can be bypassed via devtools)
 *   - Internal network addresses are never reachable from this proxy
 *   - Rate limiting protects relayers from abuse
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);
  const rl = checkRateLimit(`relay:${ip}`, RATE_LIMIT);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Determine relayer URL: explicit from body, or default
  const relayerUrl = typeof body.relayerUrl === "string" ? body.relayerUrl : DEFAULT_RELAYER_URL;
  const validOrigin = validateRelayerOrigin(relayerUrl);
  if (!validOrigin) {
    return NextResponse.json(
      { error: "Relayer URL not in allowlist. Contact admin to add this relayer." },
      { status: 403 },
    );
  }

  // Validate required claim fields
  const { proofA, proofB, proofC, claimsRoot, claimNullifier, amount, token, recipient, releaseTime } = body;
  if (!proofA || !proofB || !proofC || !claimsRoot || !claimNullifier ||
      !amount || !token || !recipient || !releaseTime) {
    return NextResponse.json({ error: "Missing required claim fields" }, { status: 400 });
  }

  try {
    const res = await fetch(`${validOrigin}/api/private-claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proofA, proofB, proofC, claimsRoot, claimNullifier, amount, token, recipient, releaseTime }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const data = await res.json().catch(() => ({ error: "Non-JSON response from relayer" }));

    if (!res.ok) {
      return NextResponse.json(
        { error: data.error || "Relayer rejected the claim" },
        { status: res.status >= 500 ? 502 : res.status },
      );
    }

    return NextResponse.json(data);
  } catch (e) {
    const isTimeout = e instanceof DOMException && e.name === "AbortError";
    const message = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json(
      { error: `Relayer unreachable: ${message}` },
      { status: isTimeout ? 504 : 502 },
    );
  }
}
