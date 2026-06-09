"use client";

import Link from "next/link";
import { NavDropdown, type NavDropdownItem } from "@zkscatter/ui";
import { useWallet } from "@zkscatter/sdk/react";

/** Identity dropdown for operators — links to the operator's own
 *  identity / cert status.
 *
 *  Platform-owner governance (RelayerRegistry authorities and
 *  IssuanceApprovalRegistry approvals) is NOT surfaced here: it lives
 *  in the admin console (apps/admin → Protocol › RelayerRegistry and
 *  Operator-CA › KYC review), so the relayer app stays self-service only.
 *
 *  Register-relayer placement: that link lives solely under MyMenu
 *  (surfaced as the primary action when the connected wallet is not yet
 *  a registered relayer), so it's intentionally absent here too. */
export function IdentityMenu() {
  const { account } = useWallet();
  if (!account) return null;

  const items: NavDropdownItem[] = [
    { href: "/operator-ca", label: "My status" },
  ];
  return <NavDropdown LinkComponent={Link} label="Identity" items={items} />;
}
