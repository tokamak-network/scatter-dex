"use client";

import { NavDropdown, type NavDropdownItem } from "@zkscatter/ui";
import { useWallet } from "@zkscatter/sdk/react";
import { useIsIdentityGateAdmin } from "../_lib/identity";

/** Identity dropdown for Pay. Queries `IdentityGate.owner()` via
 *  `useIsIdentityGateAdmin` to surface the admin entry — operators
 *  use a different hook against `RelayerRegistry.owner()`. The two
 *  apps gate on different contracts; see `dual_ca_gate_model` memory. */
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
