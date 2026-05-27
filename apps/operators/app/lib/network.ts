import { parseTokenList, ZERO_ADDRESS, type NetworkConfig } from "@zkscatter/sdk";

const ZERO = ZERO_ADDRESS;

function pick(value: string | undefined, fallback = ""): string {
  return value && value.length > 0 ? value : fallback;
}

/** Operators-app network config — env-driven so a single build can
 *  target any chain (anvil localhost during dev, Sepolia/mainnet in
 *  deploy environments). Each `process.env.NEXT_PUBLIC_*` access is
 *  a literal key so Next inlines the value into the client bundle
 *  at build time. The Sepolia placeholders below are the dev
 *  fallbacks for missing env — they keep every existing page that
 *  imports `DEMO_NETWORK.name` rendering coherent strings even when
 *  no `.env.local` is present.
 *
 *  Resolved at module load and exported as a const so existing
 *  imports (`DEMO_NETWORK.contracts.relayerRegistry`,
 *  `DEMO_NETWORK.chainId`, …) keep working unchanged.
 */
function resolveNetwork(): NetworkConfig {
  return {
    chainId: Number(pick(process.env.NEXT_PUBLIC_CHAIN_ID, "11155111")),
    name: pick(process.env.NEXT_PUBLIC_CHAIN_NAME, "Sepolia"),
    rpcUrl: pick(process.env.NEXT_PUBLIC_RPC_URL, "https://rpc.sepolia.org"),
    explorerBase: pick(process.env.NEXT_PUBLIC_EXPLORER_BASE) || undefined,
    contracts: {
      privateSettlement: pick(process.env.NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS, ZERO),
      commitmentPool: pick(process.env.NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS, ZERO),
      identityGate: pick(process.env.NEXT_PUBLIC_IDENTITY_GATE_ADDRESS, ZERO),
      relayerRegistry: pick(process.env.NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS, ZERO),
      feeVault: pick(process.env.NEXT_PUBLIC_FEE_VAULT_ADDRESS, ZERO),
      weth: pick(process.env.NEXT_PUBLIC_WETH_ADDRESS, ZERO),
    },
    tokens: parseTokenList(process.env.NEXT_PUBLIC_TOKENS),
  };
}

export const DEMO_NETWORK: NetworkConfig = resolveNetwork();

/** External URL where operators can request verification from the
 *  Relayer-CA — typically the zk-X509 frontend that this network's
 *  IdentityRegistry trusts. Empty string means "not configured"; the
 *  /operator-ca and /register pages render the registration button
 *  disabled in that case rather than fabricating a link.
 *
 *  Reads `NEXT_PUBLIC_CA_REGISTRATION_URL` first (production name)
 *  and falls back to the legacy `NEXT_PUBLIC_ZK_X509_URL` so existing
 *  dev-stack `.env.local` files keep working without an extra edit. */
export const CA_REGISTRATION_URL: string = pick(
  process.env.NEXT_PUBLIC_CA_REGISTRATION_URL,
  pick(process.env.NEXT_PUBLIC_ZK_X509_URL, ""),
);
