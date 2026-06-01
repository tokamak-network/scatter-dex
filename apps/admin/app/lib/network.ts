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
      issuanceApprovalRegistry:
        pick(process.env.NEXT_PUBLIC_ISSUANCE_APPROVAL_REGISTRY_ADDRESS) || undefined,
    },
    tokens: parseTokenList(process.env.NEXT_PUBLIC_TOKENS),
  };
}

export const DEMO_NETWORK: NetworkConfig = resolveNetwork();

// The Relayer-CA IdentityRegistry used by the Operator-CA attestation step is
// no longer read from an env var — it's read on-chain from
// RelayerRegistry.identityRegistry() (see app/lib/useRelayerIdentityRegistry.ts)
// so the page always reflects what the Identity (relayer) tab set.

/** Address of the project's `SanctionsList` (the self-managed
 *  multisig-governed list, not the Chainalysis OFAC oracle).
 *  Empty string disables the sanctions admin page actions and
 *  surfaces a configuration banner instead.
 */
export const SANCTIONS_LIST_ADDRESS: string = pick(
  process.env.NEXT_PUBLIC_SANCTIONS_LIST_ADDRESS,
  "",
);
