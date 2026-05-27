"use client";

import Link from "next/link";
import { NavDropdown, type NavDropdownItem } from "@zkscatter/ui";
import { useWallet } from "@zkscatter/sdk/react";
import { useIsRegisteredRelayer, useIsRelayerRegistryAdmin } from "../lib/identity";

/** Identity dropdown for operators. Reads `RelayerRegistry.owner()`
 *  via `useIsRelayerRegistryAdmin` to decide whether to surface the
 *  admin entry — Pay/Pro have their own equivalent that queries
 *  `IdentityGate.owner()` instead. See `dual_ca_gate_model` memory:
 *  the two apps gate on different contracts, so the admin hook
 *  stays app-local even though the dropdown shell is shared.
 *
 *  Register-relayer placement: shown here once the account already
 *  is a relayer (re-registration is rare but legal). For non-relayer
 *  accounts the MyMenu surfaces "Register relayer" as the primary
 *  action so the user finds it where they naturally look. Hiding
 *  the duplicate here keeps a single source of truth per menu state. */
export function IdentityMenu() {
  const { account } = useWallet();
  const isAdmin = useIsRelayerRegistryAdmin();
  const isRelayer = useIsRegisteredRelayer();
  if (!account) return null;

  const items: NavDropdownItem[] = [
    { href: "/operator-ca", label: "My status" },
  ];
  if (isRelayer === true) {
    items.push({ href: "/register", label: "Register relayer" });
  }
  if (isAdmin) {
    items.push({
      href: "/admin/identity",
      label: "Manage authorities",
      subLabel: "(admin)",
    });
  }
  return <NavDropdown LinkComponent={Link} label="Identity" items={items} />;
}
