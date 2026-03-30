// Runtime config that works in both server and client (Docker) environments.
// Server: reads from process.env (set by Docker entrypoint).
// Client: reads from window.__ENV__ (injected by layout.tsx <script> tag).

declare global {
  interface Window {
    __ENV__?: Record<string, string>;
  }
}

export function getEnv(key: string): string | undefined {
  if (typeof window !== "undefined") {
    return window.__ENV__?.[key] || undefined;
  }
  return typeof process !== "undefined" ? process.env[key] : undefined;
}

function requireEnv(key: string): string {
  const value = getEnv(key);
  if (!value) {
    throw new Error(`${key} is not set`);
  }
  return value;
}

export const SETTLEMENT_ADDRESS = requireEnv("NEXT_PUBLIC_SETTLEMENT_ADDRESS");
export const RELAYER_REGISTRY_ADDRESS = requireEnv("NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS");
export const RPC_URL = getEnv("NEXT_PUBLIC_RPC_URL") || "http://localhost:8545";
