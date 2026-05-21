"use client";

import Link from "next/link";
import { NavDropdown } from "@zkscatter/ui";

export function PlatformMenu() {
  return (
    <NavDropdown LinkComponent={Link}
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
