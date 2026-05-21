"use client";

import { NavDropdown, type NavDropdownItem } from "@zkscatter/ui";
import { useWallet } from "@zkscatter/sdk/react";
import { useIsIdentityGateAdmin } from "../lib/identity";

/** Identity dropdown for Pro. Same shape as Pay's; both query
 *  `IdentityGate.owner()` because they share the multi-CA Pay/Pro
 *  gate. Operators uses `useIsRelayerRegistryAdmin` against the
 *  single-CA `RelayerRegistry` — don't conflate (see
 *  `dual_ca_gate_model`). */
export function IdentityMenu() {
  const { account } = useWallet();
  const isAdmin = useIsIdentityGateAdmin();
  if (!account) return null;

  const items: NavDropdownItem[] = [{ href: "/identity", label: "My status" }];
  if (isAdmin) {
    items.push({
      href: "/admin/identity",
      label: "Manage authorities",
      subLabel: "(admin)",
    });
  }
  return <NavDropdown label="Identity" items={items} />;
}
