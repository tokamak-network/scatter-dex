"use client";

import { NavDropdown } from "@zkscatter/ui";

export function DocsMenu() {
  return (
    <NavDropdown
      label="Docs"
      align="right"
      width="narrow"
      items={[
        { href: "/docs", label: "Reference" },
        { href: "/onboarding", label: "Get started" },
      ]}
    />
  );
}
