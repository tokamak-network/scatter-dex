import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "../../lib/rate-limit";

// 60 requests per minute per IP (price polling)
const RATE_LIMIT = { limit: 60, windowMs: 60_000 };

/** Server-side proxy for Upbit API to avoid CORS restrictions in browser. */
export async function GET(req: NextRequest) {
  const ip = getClientIp(req.headers);
  const rl = checkRateLimit(`upbit:${ip}`, RATE_LIMIT);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    );
  }
  const markets = req.nextUrl.searchParams.get("markets");
  if (!markets) {
    return NextResponse.json({ error: "markets param required" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `https://api.upbit.com/v1/ticker?markets=${encodeURIComponent(markets)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) {
      return NextResponse.json({ error: "upstream error" }, { status: res.status });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "timeout" }, { status: 504 });
  }
}
