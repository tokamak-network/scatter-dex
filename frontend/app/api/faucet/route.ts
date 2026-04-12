import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { checkRateLimit, getClientIp } from "../../lib/rate-limit";
import { EXPECTED_CHAIN_ID, RPC_URL } from "../../lib/config";
import { getTokenList } from "../../lib/tokens";
import { MOCK_TOKEN_ABI } from "../../lib/contracts";

const LOCAL_CHAIN_ID = 31337;
const RATE_LIMIT = { limit: 3, windowMs: 60 * 60_000 };

const ETH_DRIP = ethers.parseEther("10");
const USDC_DRIP_WHOLE = 10_000n;

// Anvil account #0 — funded at genesis. Safe to hard-code: anvil ships this
// key publicly and the faucet refuses to run off chain 31337.
const DEFAULT_FAUCET_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

let _wallet: ethers.Wallet | null = null;
function getFaucetWallet(): ethers.Wallet {
  if (_wallet) return _wallet;
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  _wallet = new ethers.Wallet(
    process.env.FAUCET_PRIVATE_KEY || DEFAULT_FAUCET_KEY,
    provider,
  );
  return _wallet;
}

function getUsdcAddress(): string | null {
  const usdc = getTokenList().find(
    (t) => t.symbol.toUpperCase() === "USDC" && !t.isNative,
  );
  return usdc?.address ?? null;
}

export async function POST(req: NextRequest) {
  if (EXPECTED_CHAIN_ID !== LOCAL_CHAIN_ID) {
    return NextResponse.json({ error: "Faucet is only available on localhost." }, { status: 403 });
  }

  const ip = getClientIp(req.headers);
  const rl = checkRateLimit(`faucet:${ip}`, RATE_LIMIT);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) },
      },
    );
  }

  let body: { address?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const address = body.address;
  if (!address || !ethers.isAddress(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  const usdcAddress = getUsdcAddress();
  if (!usdcAddress) {
    return NextResponse.json({ error: "USDC address not configured" }, { status: 500 });
  }

  try {
    const wallet = getFaucetWallet();
    const token = new ethers.Contract(usdcAddress, MOCK_TOKEN_ABI, wallet);

    const decimals: number = await token.decimals();
    const usdcAmount = USDC_DRIP_WHOLE * 10n ** BigInt(decimals);

    const [ethTx, usdcTx] = await Promise.all([
      wallet.sendTransaction({ to: address, value: ETH_DRIP }),
      token.mint(address, usdcAmount),
    ]);
    await Promise.all([ethTx.wait(), usdcTx.wait()]);

    return NextResponse.json({
      ok: true,
      address,
      eth: { amount: ETH_DRIP.toString(), txHash: ethTx.hash },
      usdc: { amount: usdcAmount.toString(), decimals, txHash: usdcTx.hash },
    });
  } catch (e) {
    console.error("[faucet] drip failed:", e);
    return NextResponse.json({ error: "Faucet drip failed. See server logs." }, { status: 502 });
  }
}
