"use client";

import Link from "next/link";
import { NavDropdown } from "@zkscatter/ui";

/** Header "Operator CA" dropdown. Lives in its own client component so
 *  the `LinkComponent={Link}` prop (a function) never crosses the
 *  server→client boundary from the root layout. */
export function OperatorCaNav() {
  return (
    <NavDropdown
      label="Operator CA"
      items={[
        { href: "/operator-ca", label: "Verify & attest" },
        { href: "/operator-ca/kyc-review", label: "KYC review" },
      ]}
      LinkComponent={Link}
    />
  );
}
