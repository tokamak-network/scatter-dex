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

let _wallet: ethers.NonceManager | null = null;
function getFaucetWallet(): ethers.NonceManager {
  if (_wallet) return _wallet;
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(
    process.env.FAUCET_PRIVATE_KEY || DEFAULT_FAUCET_KEY,
    provider,
  );
  // Wrap in NonceManager so concurrent sends get monotonically increasing
  // nonces. Without this, Promise.all below would let two populates read
  // the same pending nonce and one tx would replace the other.
  _wallet = new ethers.NonceManager(signer);
  return _wallet;
}

// Serialize populate+send across requests. NonceManager increments its
// internal counter only after sendTransaction returns, so two concurrent
// API requests could still race between populate and increment. A simple
// promise chain keeps each drip's populate→send strictly sequential while
// still letting the two txs inside one drip pipeline.
let _queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = _queue.then(task, task);
  _queue = run.catch(() => {});
  return run;
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

    // Send both txs back-to-back on the same NonceManager, serialized
    // across concurrent requests. Each send returns once the node has
    // accepted the tx with its assigned nonce; the wait()s can safely
    // run in parallel afterwards.
    const { ethTx, usdcTx } = await enqueue(async () => {
      const e = await wallet.sendTransaction({ to: address, value: ETH_DRIP });
      const u = await token.mint(address, usdcAmount);
      return { ethTx: e, usdcTx: u };
    });
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
