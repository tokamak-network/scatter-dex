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
  // Static export for Firebase Hosting (Spark plan, no SSR runtime).
  // Nextra v4 supports static export; redirects move to firebase.json
  // because Next's `redirects()` requires the Node runtime.
  output: "export",
  images: { unoptimized: true },
  // Each app under apps/* has its own package-lock.json; pin the
  // turbopack root to the repo so we don't re-detect per-app.
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
};

export default withNextra(nextConfig);
