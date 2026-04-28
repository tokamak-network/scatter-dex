import "nextra-theme-docs/style.css";
import "./globals.css";

import { Footer, Layout, Navbar } from "nextra-theme-docs";
import { Banner, Head } from "nextra/components";
import { getPageMap } from "nextra/page-map";
import type { ReactNode } from "react";

export const metadata = {
  title: {
    default: "zkScatter Docs",
    template: "%s — zkScatter Docs",
  },
  description:
    "Build private, compliant on-chain finance apps on the zkScatter ZK stack — OTC, payments, drops — with @zkscatter/sdk.",
};

// Two top tabs: "Document" (everything under /docs/*) and
// "SDK Reference" (everything under /sdk/*). Nextra v4 wires each
// `type: "page"` entry in the root `_meta.tsx` to the navbar AND
// scopes the sidebar to that subtree. Logo + Search + GitHub +
// theme toggle round out the navbar.
const navbar = (
  <Navbar
    logo={<span className="zs-brand">zkScatter Docs</span>}
    projectLink="https://github.com/tokamak-network/scatter-dex"
  />
);

// Static — `new Date().getFullYear()` in the render path triggers
// a hydration mismatch warning if the server renders Dec-31 and the
// client hydrates Jan-1 (or vice-versa across timezones). Bumped
// once per calendar year by hand; the cost is one diff a year.
const COPYRIGHT_YEAR = 2026;

const footer = (
  <Footer>
    <span className="zs-footer-text">
      © {COPYRIGHT_YEAR} Tokamak Network · zkScatter
    </span>
  </Footer>
);

export default async function RootLayout({ children }: { children: ReactNode }) {
  const pageMap = await getPageMap();
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head />
      <body>
        <Layout
          banner={
            <Banner storageKey="zkscatter-docs-banner" dismissible>
              Self-hosted preview — Nextra build of <code>developers/</code>.
            </Banner>
          }
          navbar={navbar}
          footer={footer}
          pageMap={pageMap}
          docsRepositoryBase="https://github.com/tokamak-network/scatter-dex/blob/main/developers"
          sidebar={{ defaultMenuCollapseLevel: 1 }}
        >
          {children}
        </Layout>
      </body>
    </html>
  );
}
