"use client";

import Link from "next/link";
import { NavDropdown, type NavDropdownItem } from "@zkscatter/ui";
import { useWallet } from "@zkscatter/sdk/react";
import { useIsRelayerRegistryAdmin } from "../lib/identity";

/** Identity dropdown for operators. Reads `RelayerRegistry.owner()`
 *  via `useIsRelayerRegistryAdmin` to decide whether to surface the
 *  admin entry — Pay/Pro have their own equivalent that queries
 *  `IdentityGate.owner()` instead. See `dual_ca_gate_model` memory:
 *  the two apps gate on different contracts, so the admin hook
 *  stays app-local even though the dropdown shell is shared.
 *
 *  Register-relayer placement: the link lives solely under MyMenu
 *  (surfaced as the primary action when the connected wallet is
 *  not yet a registered relayer). Already-registered accounts have
 *  no use for it — re-registration is a contract-level no-op — so
 *  the entry is intentionally absent here too. */
export function IdentityMenu() {
  const { account } = useWallet();
  const isAdmin = useIsRelayerRegistryAdmin();
  if (!account) return null;

  const items: NavDropdownItem[] = [
    { href: "/operator-ca", label: "My status" },
  ];
  if (isAdmin) {
    items.push({
      href: "/admin/identity",
      label: "Manage authorities",
      subLabel: "(admin)",
    });
  }
  return <NavDropdown LinkComponent={Link} label="Identity" items={items} />;
}
