"use client";

import Link from "next/link";
import { NavDropdown } from "@zkscatter/ui";

export function MyMenu() {
  return (
    <NavDropdown LinkComponent={Link}
      label="My"
      width="narrow"
      items={[
        { href: "/dashboard", label: "Dashboard" },
        { href: "/orders", label: "Orders" },
        { href: "/treasury", label: "Earnings" },
        { href: "/runtime", label: "Controls" },
        { href: "/profile", label: "Profile" },
      ]}
    />
  );
}
