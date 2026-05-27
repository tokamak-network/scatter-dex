"use client";

import Link from "next/link";
import { NavDropdown, type NavDropdownItem } from "@zkscatter/ui";
import { useWallet } from "@zkscatter/sdk/react";
import { useIsRegisteredRelayer } from "../lib/identity";

/** "My" dropdown. Two shapes depending on whether the connected
 *  wallet is a registered relayer:
 *
 *  - **Registered**: the full operator surface (Dashboard, Orders,
 *    Analytics, Earnings, Controls, Profile).
 *  - **Not registered (or RPC pending)**: those pages would be empty
 *    or broken without a relayer record, so we swap in "Register
 *    relayer" (mirrored from the Identity menu) as the only enabled
 *    item and grey out the rest with a tooltip. This gives a new
 *    visitor a single obvious next action from the My menu instead
 *    of a dropdown full of dead ends.
 *
 *  Unconnected wallet → render nothing (matches IdentityMenu's
 *  null-on-disconnect behavior so the header doesn't show empty
 *  shells). */
export function MyMenu() {
  const { account } = useWallet();
  const isRelayer = useIsRegisteredRelayer();

  if (!account) return null;

  const operatorItems: NavDropdownItem[] = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/orders", label: "Orders" },
    { href: "/analytics", label: "Analytics" },
    { href: "/treasury", label: "Earnings" },
    { href: "/runtime", label: "Controls" },
    { href: "/profile", label: "Profile" },
  ];

  // `isRelayer === null` covers loading + missing-registry; treat
  // both as "not yet a relayer" so the gate fails closed. False
  // positives just delay access by one RPC tick.
  if (isRelayer !== true) {
    const disabledTitle = "Register a relayer first to access operator pages";
    const items: NavDropdownItem[] = [
      { href: "/register", label: "Register relayer" },
      ...operatorItems.map((it) => ({ ...it, disabled: true, disabledTitle })),
    ];
    return <NavDropdown LinkComponent={Link} label="My" width="narrow" items={items} />;
  }

  return <NavDropdown LinkComponent={Link} label="My" width="narrow" items={operatorItems} />;
}
