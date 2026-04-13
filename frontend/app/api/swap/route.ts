import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "../../lib/rate-limit";

// 30 requests per minute per IP (swap quotes)
const RATE_LIMIT = { limit: 30, windowMs: 60_000 };

/**
 * Server-side proxy for 1inch Swap API.
 *
 * Why server-side:
 *   - API key stays on the server (never exposed to browser)
 *   - Avoids CORS issues with 1inch API
 *   - Can add rate limiting, caching, logging
 *
 * Client calls: GET /api/swap?chainId=1&src=0x...&dst=0x...&amount=1000&from=0x...&slippage=0.5
 * Server calls: https://api.1inch.dev/swap/v6.0/{chainId}/swap?...
 */

const ONEINCH_BASE_URL = "https://api.1inch.dev/swap/v6.0";
const ONEINCH_API_KEY = process.env.ONEINCH_API_KEY; // server-only env var (not NEXT_PUBLIC_)
const FETCH_TIMEOUT_MS = 10_000;

// Known 1inch Aggregation Router V6 address (same on all EVM chains)
const ONEINCH_ROUTER = "0x111111125421cA6dc452d289314280a0f8842A65";

export async function GET(req: NextRequest) {
  // Rate limit: 30 req/min per IP
  const ip = getClientIp(req.headers);
  const rl = checkRateLimit(`swap:${ip}`, RATE_LIMIT);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    );
  }

  const { searchParams } = req.nextUrl;

  const chainId = searchParams.get("chainId");
  const src = searchParams.get("src");
  const dst = searchParams.get("dst");
  const amount = searchParams.get("amount");
  const from = searchParams.get("from");
  const slippage = searchParams.get("slippage") ?? "0.5";

  if (!chainId || !src || !dst || !amount || !from) {
    return NextResponse.json(
      { error: "Missing required params: chainId, src, dst, amount, from" },
      { status: 400 },
    );
  }

  // Validate chainId is a positive integer
  if (!/^\d+$/.test(chainId)) {
    return NextResponse.json({ error: "Invalid chainId" }, { status: 400 });
  }

  // Validate addresses are hex
  if (!/^0x[0-9a-fA-F]{40}$/.test(src) || !/^0x[0-9a-fA-F]{40}$/.test(dst)) {
    return NextResponse.json({ error: "Invalid token address" }, { status: 400 });
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(from)) {
    return NextResponse.json({ error: "Invalid from address" }, { status: 400 });
  }

  const queryParams = new URLSearchParams({
    src,
    dst,
    amount,
    from,
    slippage,
    disableEstimate: "true",
    compatibility: "true",
  });

  const headers: Record<string, string> = { Accept: "application/json" };
  if (ONEINCH_API_KEY) {
    headers["Authorization"] = `Bearer ${ONEINCH_API_KEY}`;
  }

  try {
    const res = await fetch(
      `${ONEINCH_BASE_URL}/${chainId}/swap?${queryParams}`,
      {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown error");
      return NextResponse.json(
        { error: `1inch API error: ${errText.slice(0, 200)}` },
        { status: res.status },
      );
    }

    const data = await res.json();

    // Validate: response must contain expected fields
    if (!data.tx?.to || !data.tx?.data || !data.dstAmount) {
      return NextResponse.json(
        { error: "Malformed 1inch API response" },
        { status: 502 },
      );
    }

    // Validate: router address must be the known 1inch router
    if (data.tx.to.toLowerCase() !== ONEINCH_ROUTER.toLowerCase()) {
      return NextResponse.json(
        { error: `Unexpected router address: ${data.tx.to}` },
        { status: 502 },
      );
    }

    return NextResponse.json({
      dexRouter: ONEINCH_ROUTER,
      dexCalldata: data.tx.data,
      estimatedOutput: data.dstAmount,
      source: "1inch",
    });
  } catch (e) {
    const isTimeout = e instanceof DOMException && e.name === "AbortError";
    const message = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json(
      { error: message },
      { status: isTimeout ? 504 : 502 },
    );
  }
}
