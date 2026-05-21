"use client";

import Link from "next/link";
import { NavDropdown } from "@zkscatter/ui";

export function DocsMenu() {
  return (
    <NavDropdown LinkComponent={Link}
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
