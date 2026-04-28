import nextra from "nextra";
import path from "path";
import type { NextConfig } from "next";

// Wrap Next with Nextra's MDX + page-map loader. We point `contentDir`
// at the existing `developers/` directory so the Mintlify-style mdx
// keeps working as the canonical source — no duplication.
const withNextra = nextra({
  contentDirBasePath: "/",
  defaultShowCopyCode: true,
  search: { codeblocks: false },
});

const nextConfig: NextConfig = {
  // Each app under apps/* has its own package-lock.json; pin the
  // turbopack root to the repo so we don't re-detect per-app.
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
  async redirects() {
    return [
      // No `index.mdx` in `developers/` — land on the Document tab.
      { source: "/", destination: "/docs/introduction", permanent: false },
      // Old flat URLs → new nested ones (kept around so external
      // links and stale bookmarks survive the IA reorg).
      { source: "/introduction", destination: "/docs/introduction", permanent: false },
      { source: "/installation", destination: "/docs/installation", permanent: false },
      { source: "/quickstart", destination: "/docs/quickstart", permanent: false },
      { source: "/faq", destination: "/docs/faq", permanent: false },
      { source: "/concepts/:path*", destination: "/docs/concepts/:path*", permanent: false },
      { source: "/guides/:path*", destination: "/docs/guides/:path*", permanent: false },
      { source: "/protocol/:path*", destination: "/docs/protocol/:path*", permanent: false },
      { source: "/operate/:path*", destination: "/docs/operate/:path*", permanent: false },
      { source: "/api/:path*", destination: "/sdk/api/:path*", permanent: false },
      { source: "/rest/:path*", destination: "/sdk/rest/:path*", permanent: false },
    ];
  },
};

export default withNextra(nextConfig);
