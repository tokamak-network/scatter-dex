import { LAUNCH_TOKENS, type NetworkConfig } from "@zkscatter/sdk";

// Pay's network config. Uses NEXT_PUBLIC_* envs at build time so
// Pay never reads chain state from process.env at runtime — this
// keeps the SDK's "network is passive" contract intact.
//
// In dev with `./scripts/dev.sh --mock`, all addresses come from the
// printed deploy output. Set them via `.env.local`:
//
//   NEXT_PUBLIC_PAY_RPC_URL=http://127.0.0.1:8545
//   NEXT_PUBLIC_PAY_CHAIN_ID=31337
//   NEXT_PUBLIC_PAY_PRIVATE_SETTLEMENT=0x...
//   NEXT_PUBLIC_PAY_COMMITMENT_POOL=0x...
//   NEXT_PUBLIC_PAY_IDENTITY_GATE=0x...
//   NEXT_PUBLIC_PAY_RELAYER_REGISTRY=0x...
//   NEXT_PUBLIC_PAY_WETH=0x...
//   NEXT_PUBLIC_PAY_RELAYER_URL=http://127.0.0.1:7000

const ZERO = "0x0000000000000000000000000000000000000000";

function env(name: string, fallback = ""): string {
  // Next inlines NEXT_PUBLIC_* at build time, so this lookup is safe
  // for client and server.
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

export function getNetworkConfig(): NetworkConfig {
  return {
    chainId: Number(env("NEXT_PUBLIC_PAY_CHAIN_ID", "31337")),
    rpcUrl: env("NEXT_PUBLIC_PAY_RPC_URL", "http://127.0.0.1:8545"),
    explorerBase: env("NEXT_PUBLIC_PAY_EXPLORER_BASE") || undefined,
    contracts: {
      privateSettlement: env("NEXT_PUBLIC_PAY_PRIVATE_SETTLEMENT", ZERO),
      commitmentPool: env("NEXT_PUBLIC_PAY_COMMITMENT_POOL", ZERO),
      identityGate: env("NEXT_PUBLIC_PAY_IDENTITY_GATE", ZERO),
      relayerRegistry: env("NEXT_PUBLIC_PAY_RELAYER_REGISTRY", ZERO),
      weth: env("NEXT_PUBLIC_PAY_WETH", ZERO),
    },
    tokens: Object.values(LAUNCH_TOKENS),
    relayer: env("NEXT_PUBLIC_PAY_RELAYER_URL")
      ? { url: env("NEXT_PUBLIC_PAY_RELAYER_URL") }
      : undefined,
    deployBlock: Number(env("NEXT_PUBLIC_PAY_DEPLOY_BLOCK", "0")),
  };
}

/** Whether the current network config is fully configured. Used by
 *  the layout to decide whether to render the real WalletProvider or
 *  a "configure your env" notice. */
export function isNetworkConfigured(cfg: NetworkConfig): boolean {
  return (
    cfg.contracts.privateSettlement !== ZERO &&
    cfg.contracts.commitmentPool !== ZERO &&
    cfg.contracts.relayerRegistry !== ZERO
  );
}
