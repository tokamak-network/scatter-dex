/** Single source of truth for the demo operator identity rendered
 *  across the v1 console. Replaces the per-file hardcodes in
 *  layout.tsx and OperatorIdentityBar — when wallet auth lands in
 *  v1.1, swap callers to a `useOperator()` hook keyed on the
 *  connected address; the shape stays the same. */
export type OperatorStatus = "active" | "cooldown" | "offline";

export interface OperatorIdentity {
  name: string;
  /** 0x-prefixed checksummed EOA. */
  address: string;
  /** HTTPS endpoint published on-chain. Optional — pre-registration
   *  state has none. */
  url?: string;
  status: OperatorStatus;
}

export const MOCK_OPERATOR: OperatorIdentity = {
  name: "Acme Relayer",
  address: "0xA1c6d3b5e2f4e8c1d9b7a6c5d4e3f2a1b0c9d8f4",
  url: "https://relayer.acme-relayer.xyz",
  status: "active",
};

/** Truncate an Ethereum address to `0xABCD…WXYZ` for display.
 *  Keeps the full value available for `title` / aria-labels. */
export function shortenAddress(addr: string, head = 4, tail = 4): string {
  if (addr.length <= head + tail + 2) return addr;
  return `${addr.slice(0, 2 + head)}…${addr.slice(-tail)}`;
}

/** Two-letter initials from a display name. Falls back to "?" so
 *  the avatar slot never collapses on a pathological name. */
export function operatorInitials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((w) => w.charAt(0).toUpperCase()).join("");
  return letters || "?";
}
