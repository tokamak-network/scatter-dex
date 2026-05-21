"use client";

import Link from "next/link";
import { NavDropdown } from "@zkscatter/ui";

export function OrdersMenu() {
  return (
    <NavDropdown LinkComponent={Link}
      label="Orders"
      items={[
        { href: "/orders", label: "My orders", subLabel: "(this workspace)" },
        { href: "/orderbook", label: "Shared order book", subLabel: "(everyone)" },
      ]}
    />
  );
}
