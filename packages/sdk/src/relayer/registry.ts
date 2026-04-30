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
 *  with `online: false` and `api: undefined`.
 *
 *  When `withStats` is set, also probes `/api/relayer/stats` in
 *  parallel with `/api/info`. The two probes are independent — a
 *  relayer can be `online: true` (info ok) but have `stats: undefined`
 *  if it's an older build that doesn't expose the endpoint. */
export async function loadRelayersWithApiInfo(
  registryAddress: string,
  provider: ethers.Provider,
  opts: LoadOpts & { withStats?: boolean } = {},
): Promise<RelayerInfo[]> {
  const onChain = await loadActiveRelayers(registryAddress, provider);
  const timeoutMs = opts.probeTimeoutMs ?? 3_000;
  return Promise.all(
    onChain.map(async (r): Promise<RelayerInfo> => {
      const client = new RelayerClient(r.url, { timeoutMs });
      const [infoResult, statsResult] = await Promise.all([
        client.getInfo().then((api) => ({ ok: true as const, api })).catch(() => ({ ok: false as const })),
        opts.withStats
          ? client.getStats().then((stats) => ({ ok: true as const, stats })).catch(() => ({ ok: false as const }))
          : Promise.resolve({ ok: false as const }),
      ]);
      if (!infoResult.ok) return { ...r, online: false };
      return {
        ...r,
        api: infoResult.api,
        stats: statsResult.ok ? statsResult.stats : undefined,
        online: true,
      };
    }),
  );
}
