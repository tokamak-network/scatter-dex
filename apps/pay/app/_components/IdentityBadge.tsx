"use client";

import { useIdentityForAddress } from "../_lib/identity";

/** Small inline verification indicator next to a recipient
 *  address. Renders nothing while the lookup is pending so the
 *  table doesn't flicker between states; once resolved, shows a
 *  green ✓ for verified addresses and an amber ⚠ for everything
 *  else. */
export function IdentityBadge({ address }: { address: string | undefined | null }) {
  const { status } = useIdentityForAddress(address);
  if (!address || !status) return null;
  if (status.state.kind === "verified" || status.state.kind === "expiring") {
    return (
      <span
        title="zk-X509 verified"
        className="inline-flex items-center rounded-full bg-[var(--color-success-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-success)]"
      >
        ✓ Verified
      </span>
    );
  }
  return (
    <span
      title="Not verified — recipient must verify before claiming"
      className="inline-flex items-center rounded-full bg-[var(--color-warning-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-warning)]"
    >
      ⚠ Unverified
    </span>
  );
}
