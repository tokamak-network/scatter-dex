/** Single source of truth for the demo operator identity rendered
 *  across the v1 console. Replaces the per-file hardcodes in
 *  layout.tsx and OperatorIdentityBar — when wallet auth lands in
 *  v1.1, swap callers to a `useOperator()` hook keyed on the
 *  connected address; the shape stays the same. */
export type OperatorStatus = "active" | "cooldown" | "offline";

export interface OperatorIdentity {
  name: string;
  /** 0x-prefixed EOA. May be lowercase or EIP-55 mixed-case;
   *  display helpers should not depend on the casing — use
   *  `shortenAddress` for rendering. */
  address: string;
  /** Endpoint URL published on-chain. Untrusted input — validate
   *  with `safeOperatorUrl` before rendering as an `<a href>`. */
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

const ALLOWED_URL_PROTOCOLS = new Set(["https:", "http:"]);

/** Parse and validate an operator-published URL before it touches
 *  an `<a href>`. Returns the URL when the scheme is in the
 *  allowlist (https/http only — `javascript:` / `data:` rejected),
 *  otherwise null. The published URL is operator-controlled and
 *  must be treated as untrusted. */
export function safeOperatorUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return ALLOWED_URL_PROTOCOLS.has(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}
