"use client";

import { NavDropdown } from "@zkscatter/ui";

export function MyMenu() {
  return (
    <NavDropdown
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
