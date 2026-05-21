import * as React from "react";
import Link from "next/link";

const HUB_HREF =
  process.env.NEXT_PUBLIC_HUB_URL ?? "https://zkscatter-hub.web.app";

function BrandImpl({ homeHref = "/" }: { homeHref?: string }) {
  return (
    <span
      className="inline-flex items-baseline gap-1"
      style={{ color: "var(--color-primary)" }}
    >
      <a
        href={HUB_HREF}
        aria-label="Back to zkScatter Hub"
        className="inline-flex items-center"
        style={{
          fontFamily: "ui-serif, Georgia, 'Times New Roman', serif",
          fontStyle: "italic",
          fontWeight: 700,
          fontSize: "1.25rem",
          letterSpacing: "-0.02em",
          lineHeight: 1,
          opacity: 0.6,
        }}
      >
        zk·
      </a>
      <Link
        href={homeHref}
        className="hover:opacity-80"
        style={{
          fontFamily: "ui-serif, Georgia, 'Times New Roman', serif",
          fontStyle: "italic",
          fontWeight: 700,
          fontSize: "1.5rem",
          letterSpacing: "-0.02em",
          lineHeight: 1,
        }}
      >
        Scatter Admin
      </Link>
    </span>
  );
}

export const Brand = React.memo(BrandImpl);
