import { NextRequest, NextResponse } from "next/server";

/** Server-side proxy for Upbit API to avoid CORS restrictions in browser. */
export async function GET(req: NextRequest) {
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
