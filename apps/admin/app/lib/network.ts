import { parseTokenList, ZERO_ADDRESS, type NetworkConfig } from "@zkscatter/sdk";

const ZERO = ZERO_ADDRESS;

function pick(value: string | undefined, fallback = ""): string {
  return value && value.length > 0 ? value : fallback;
}

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

/** Address of the Relayer-CA IdentityRegistry. The admin app uses
 *  this for the on-chain attestation step after issuing an X.509
 *  cert — leaving it unset disables the on-chain leg and surfaces
 *  the cert artifacts only.
 */
export const IDENTITY_REGISTRY_ADDRESS: string = pick(
  process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ADDRESS,
  "",
);
