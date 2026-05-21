"use client";

import { NavDropdown } from "@zkscatter/ui";

export function OrdersMenu() {
  return (
    <NavDropdown
      label="Orders"
      items={[
        { href: "/orders", label: "My orders", subLabel: "(this workspace)" },
        { href: "/orderbook", label: "Shared order book", subLabel: "(everyone)" },
      ]}
    />
  );
}
