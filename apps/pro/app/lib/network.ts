import {
  KNOWN_EXPLORER_BASES,
  LAUNCH_TOKENS,
  ZERO_ADDRESS,
  chainName,
  type NetworkConfig,
  type TokenInfo,
} from "@zkscatter/sdk";

// Pro's network config. Built at module load from `NEXT_PUBLIC_*`
// envs that `scripts/dev.sh --apps pro` writes after `forge script
// DeployLocal` so the running anvil's contract addresses flow into
// the UI without manual editing. Production (Sepolia, mainnet) reads
// the same keys from the deploy pipeline's env. When a key is unset,
// the entry falls back to ZERO_ADDRESS — `isConfiguredAddress` and
// `isNetworkConfigured` then short-circuit dispatch to the simulated
// path so the UI stays usable without a live chain.
//
// Each `process.env.NEXT_PUBLIC_*` access has to be a *literal* key
// for Next to inline the value into the client bundle; a dynamic
// lookup like `process.env[name]` is not statically analysable and
// would silently evaluate to `undefined` in the browser.

function pick(value: string | undefined, fallback = ""): string {
  return value && value.length > 0 ? value : fallback;
}

/** Parse a non-negative integer from an env string with a guarded
 *  fallback. `Number()` alone returns `NaN` on garbage input (e.g.
 *  `"11155111abc"`) and silently propagates it into the network
 *  config; downstream `chainId` comparisons then never match. Reject
 *  anything that isn't a clean positive integer and fall back. */
function pickInt(value: string | undefined, fallback: number): number {
  if (!value || value.length === 0) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Parse the comma-separated `NEXT_PUBLIC_TOKENS` list emitted by
 *  `scripts/dev.sh write_app_env`. Format: `<addr>:<SYMBOL>:<decimals>`
 *  per entry. Returns a symbol→address map. WETH is folded into
 *  "ETH" because Pro's UX uses ETH while the on-chain ERC-20 is
 *  WETH — `LAUNCH_TOKENS.ETH` already carries `isNative: true`. */
function parseTokenList(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const entry of raw.split(",")) {
    const [addr, sym] = entry.split(":");
    if (!addr || !sym) continue;
    const symbol = sym.toUpperCase() === "WETH" ? "ETH" : sym.toUpperCase();
    out[symbol] = addr;
  }
  return out;
}

function buildNetworkConfig(): NetworkConfig {
  const overlay = parseTokenList(process.env.NEXT_PUBLIC_TOKENS);
  // Also accept the dedicated `NEXT_PUBLIC_WETH_ADDRESS` key — it's
  // emitted whether or not the symbol-list is, and supplying it
  // independently lets a deploy provide WETH without re-stating it
  // in `NEXT_PUBLIC_TOKENS`.
  const wethAddress = pick(
    process.env.NEXT_PUBLIC_WETH_ADDRESS,
    overlay.ETH ?? ZERO_ADDRESS,
  );
  if (!overlay.ETH && wethAddress !== ZERO_ADDRESS) overlay.ETH = wethAddress;

  const tokens: TokenInfo[] = Object.values(LAUNCH_TOKENS).map((t) => {
    const addr = overlay[t.symbol];
    return addr && addr !== ZERO_ADDRESS ? { ...t, address: addr } : t;
  });

  const chainId = pickInt(process.env.NEXT_PUBLIC_CHAIN_ID, 11155111);
  return {
    chainId,
    // Derive the human-readable name from `chainName(chainId)` so a
    // chainId=31337 deploy doesn't render "Sepolia" in the header
    // pill. Env can still override for vanity labels.
    name: pick(process.env.NEXT_PUBLIC_NETWORK_NAME, chainName(chainId)),
    rpcUrl: pick(process.env.NEXT_PUBLIC_RPC_URL, "https://rpc.sepolia.org"),
    // Derive the explorer URL from the SDK's per-chain map so a
    // chainId=31337 deploy doesn't link out to sepolia.etherscan.io.
    // `undefined` is intentional: 31337 (Localhost) has no public
    // explorer; `ExplorerLink` falls back to plain text.
    explorerBase:
      pick(process.env.NEXT_PUBLIC_EXPLORER_BASE) || KNOWN_EXPLORER_BASES[chainId],
    contracts: {
      privateSettlement: pick(
        process.env.NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS,
        ZERO_ADDRESS,
      ),
      commitmentPool: pick(
        process.env.NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS,
        ZERO_ADDRESS,
      ),
      identityGate: pick(
        process.env.NEXT_PUBLIC_IDENTITY_GATE_ADDRESS,
        ZERO_ADDRESS,
      ),
      relayerRegistry: pick(
        process.env.NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS,
        ZERO_ADDRESS,
      ),
      feeVault: pick(process.env.NEXT_PUBLIC_FEE_VAULT_ADDRESS) || undefined,
      weth: wethAddress,
    },
    tokens,
    sharedOrderbookUrl:
      pick(process.env.NEXT_PUBLIC_SHARED_ORDERBOOK_URL) || undefined,
    relayer: process.env.NEXT_PUBLIC_ZK_RELAYER_URL
      ? { url: process.env.NEXT_PUBLIC_ZK_RELAYER_URL }
      : undefined,
  };
}

/** Demo / active network. Computed at module load from
 *  `NEXT_PUBLIC_*` envs (see `scripts/dev.sh write_app_env`). When
 *  the envs are unset the entries fall back to `ZERO_ADDRESS`, which
 *  the dispatch layer reads as "simulate, don't broadcast". */
export const DEMO_NETWORK: NetworkConfig = buildNetworkConfig();

/** Whether the active network has its core contracts wired up.
 *  Dispatch helpers in `lib/dispatch.ts` branch on this to fall
 *  back to a simulated path when running against unconfigured
 *  placeholders. */
export function isNetworkConfigured(cfg: NetworkConfig = DEMO_NETWORK): boolean {
  return (
    cfg.contracts.privateSettlement !== ZERO_ADDRESS &&
    cfg.contracts.commitmentPool !== ZERO_ADDRESS &&
    cfg.contracts.relayerRegistry !== ZERO_ADDRESS
  );
}

/** Full network list for the header switcher. Today this is just
 *  the active network + a "Mainnet (coming soon)" disabled entry —
 *  but the list shape is what the switcher consumes, so adding
 *  networks later is a one-line edit. */
export interface NetworkChoice {
  config: NetworkConfig;
  /** Whether the network is selectable from the switcher today. */
  available: boolean;
  /** Marketing label that appears in the dropdown. */
  label: string;
}

export const NETWORKS: readonly NetworkChoice[] = [
  { config: DEMO_NETWORK, available: true, label: DEMO_NETWORK.name ?? "Active" },
  {
    config: {
      chainId: 1,
      name: "Ethereum mainnet",
      rpcUrl: "",
      explorerBase: "https://etherscan.io",
      contracts: {
        privateSettlement: ZERO_ADDRESS,
        commitmentPool: ZERO_ADDRESS,
        identityGate: ZERO_ADDRESS,
        relayerRegistry: ZERO_ADDRESS,
        weth: ZERO_ADDRESS,
      },
      tokens: [],
    },
    available: false,
    label: "Ethereum mainnet · soon",
  },
];
