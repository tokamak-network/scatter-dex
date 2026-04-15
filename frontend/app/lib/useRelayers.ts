"use client";

import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { RELAYER_REGISTRY_ABI } from "./contracts";
import { getRelayerRegistryAddress } from "./config";
import { getReadProvider } from "./provider";

const provider = getReadProvider();

export interface RelayerOnChain {
  address: string;
  url: string;
  fee: number;       // basis points
  bond: bigint;
  registeredAt: number;
  exitRequestedAt: number;
  active: boolean;
}

export interface RelayerProfile {
  name?: string;
  description?: string;
  logoUrl?: string;
  contact?: string;
  socialX?: string;
  website?: string;
  updatedAt?: number;
}

// Per-field caps (mirrors the backend, kept loose so a relayer running an
// older build than us is still rendered).
const PROFILE_FIELD_MAX = 512;
type StringProfileField = "name" | "description" | "logoUrl" | "contact" | "socialX" | "website";
const URL_FIELDS = new Set<StringProfileField>(["logoUrl", "website"]);
const ALLOWED_URL_PROTOCOLS = new Set(["https:", "http:", "ipfs:"]);

function isAllowedUrl(v: string): boolean {
  try { return ALLOWED_URL_PROTOCOLS.has(new URL(v).protocol); }
  catch { return false; }
}

// Sanitize the `profile` object that `/api/info` returns from an arbitrary
// relayer URL. We trust nothing: keep only known string fields, enforce a
// length cap, and reject URL fields whose scheme isn't on the allowlist.
// This guards against UI crashes (non-string fields breaking
// `.replace`/`.includes`) and rendered-link XSS (`javascript:` / `data:`).
function sanitizeProfile(input: unknown): RelayerProfile | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const out: RelayerProfile = {};
  const fields: StringProfileField[] = ["name", "description", "logoUrl", "contact", "socialX", "website"];
  for (const k of fields) {
    const v = raw[k];
    if (typeof v !== "string") continue;
    if (v.length > PROFILE_FIELD_MAX) continue;
    if (URL_FIELDS.has(k) && !isAllowedUrl(v)) continue;
    out[k] = v;
  }
  if (typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)) {
    out.updatedAt = raw.updatedAt;
  }
  return out;
}

export interface RelayerApiInfo {
  name: string;
  version: string;
  address: string;
  fee: number;
  orderCount: number;
  settlement: string;
  profile?: RelayerProfile;
}

export interface RelayerOrderbook {
  pair: string;
  sells: { maker: string; sellAmount: string; buyAmount: string }[];
  buys: { maker: string; sellAmount: string; buyAmount: string }[];
}

export interface RelayerInfo extends RelayerOnChain {
  api?: RelayerApiInfo;
  online: boolean;
}

export function useRelayers() {
  const [relayers, setRelayers] = useState<RelayerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRelayers = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const registry = new ethers.Contract(
        getRelayerRegistryAddress(),
        RELAYER_REGISTRY_ABI,
        provider
      );

      // Get active relayer addresses
      const activeAddresses: string[] = await registry.getActiveRelayers();

      // Fetch on-chain details for each
      const onChainData: RelayerOnChain[] = await Promise.all(
        activeAddresses.map(async (addr) => {
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
        })
      );

      // Probe each relayer's API (with timeout)
      const results: RelayerInfo[] = await Promise.all(
        onChainData.map(async (r) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 3000);
          try {
            const res = await fetch(`${r.url}/api/info`, { signal: controller.signal });
            if (!res.ok) return { ...r, online: false };
            const apiRaw = await res.json();
            const api: RelayerApiInfo = {
              ...apiRaw,
              profile: sanitizeProfile(apiRaw?.profile),
            };
            return { ...r, api, online: true };
          } catch {
            return { ...r, online: false };
          } finally {
            clearTimeout(timeout);
          }
        })
      );

      setRelayers(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch relayers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRelayers(); }, [fetchRelayers]);

  return { relayers, loading, error, refresh: fetchRelayers };
}

