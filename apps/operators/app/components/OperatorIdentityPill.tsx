"use client";

import { useOperatorIdentityStatus } from "../lib/identity";
import { OperatorIdentityBadge } from "./OperatorIdentityBadge";

/** Header-aligned pill — wraps `OperatorIdentityBadge` so the
 *  badge stays self-contained / reusable while the pill applies
 *  header-specific spacing. Rendered next to the wallet dropdown
 *  trigger so a glance at the top-right confirms whether the
 *  connected wallet can execute on-chain register / addBond /
 *  updateInfo without burning a tx. */
export function OperatorIdentityPill() {
  const status = useOperatorIdentityStatus();
  // No point cluttering the header when the wallet isn't even
  // connected — the connect pill already communicates that state.
  if (status.kind === "unconnected") return null;
  return <OperatorIdentityBadge status={status} />;
}
