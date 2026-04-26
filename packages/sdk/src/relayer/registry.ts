import { ethers } from "ethers";
import { RELAYER_REGISTRY_ABI } from "../core/contracts";
import { RelayerClient } from "./client";
import type { RelayerInfo, RelayerOnChain } from "./types";

/** Read the registry contract's active list and return the full
 *  on-chain row for each. Pure read; no side effects. */
export async function loadActiveRelayers(
  registryAddress: string,
  provider: ethers.Provider,
): Promise<RelayerOnChain[]> {
  const registry = new ethers.Contract(registryAddress, RELAYER_REGISTRY_ABI, provider);
  const activeAddresses = (await registry.getActiveRelayers()) as string[];
  return Promise.all(
    activeAddresses.map(async (addr): Promise<RelayerOnChain> => {
      const r = await registry.relayers(addr);
      return {
        address: addr,
        url: r.url,
        fee: Number(r.fee),
        bond: r.bond,
        registeredAt: Number(r.registeredAt),
        exitRequestedAt: Number(r.exitRequestedAt),
        active: r.active,
      };
    }),
  );
}

interface LoadOpts {
  /** Per-relayer probe timeout. Defaults to 3 s — long enough for
   *  a healthy node, short enough that one stuck node doesn't drag
   *  the whole list. */
  probeTimeoutMs?: number;
}

/** Combine on-chain registry data with a live `/api/info` probe per
 *  relayer. Probes run in parallel; offline relayers come back
 *  with `online: false` and `api: undefined`. */
export async function loadRelayersWithApiInfo(
  registryAddress: string,
  provider: ethers.Provider,
  opts: LoadOpts = {},
): Promise<RelayerInfo[]> {
  const onChain = await loadActiveRelayers(registryAddress, provider);
  return Promise.all(
    onChain.map(async (r): Promise<RelayerInfo> => {
      const client = new RelayerClient(r.url, { timeoutMs: opts.probeTimeoutMs ?? 3_000 });
      try {
        const api = await client.getInfo();
        return { ...r, api, online: true };
      } catch {
        return { ...r, online: false };
      }
    }),
  );
}
