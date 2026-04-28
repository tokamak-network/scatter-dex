import "nextra-theme-docs/style.css";
import "./globals.css";

import { Footer, Layout, Navbar } from "nextra-theme-docs";
import { Head } from "nextra/components";
import { Brand } from "../components/brand";
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
const HUB_URL = process.env.NEXT_PUBLIC_HUB_URL ?? "https://zkscatter-hub.web.app";

// `logoLink={false}` opts out of Nextra's wrapping anchor so the
// Brand component can render two click targets itself: the symbol →
// hub, the wordmark → docs root.
const navbar = (
  <Navbar
    logo={<Brand hubHref={HUB_URL} />}
    logoLink={false}
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
        {/* Cross-app return path. Sits above the Nextra Layout chrome so
            it's visible from every doc page without depending on Nextra
            theme internals. */}
        <div className="zs-app-bar">
          <a href={HUB_URL} className="zs-app-bar-link">
            ← All apps
          </a>
        </div>
        <Layout
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
