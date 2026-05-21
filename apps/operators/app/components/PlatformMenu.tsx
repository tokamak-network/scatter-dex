"use client";

import { NavDropdown } from "@zkscatter/ui";

export function PlatformMenu() {
  return (
    <NavDropdown
      label="Platform"
      width="narrow"
      items={[
        { href: "/leaderboard", label: "Leaderboard" },
        { href: "/orders/shared", label: "Shared orders" },
        { href: "/cross-relayer", label: "Cross-relayer" },
        { href: "/verify-monitor", label: "Verify monitor" },
      ]}
    />
  );
}
