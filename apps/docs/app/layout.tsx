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
    logo={
      <span style={{ fontWeight: 700, letterSpacing: "-0.01em" }}>
        zkScatter Docs
      </span>
    }
    projectLink="https://github.com/tokamak-network/scatter-dex"
  />
);

const footer = (
  <Footer>
    <span style={{ fontSize: "0.85rem", opacity: 0.7 }}>
      © {new Date().getFullYear()} Tokamak Network · zkScatter
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
