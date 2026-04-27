import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Zero-build dev for shared packages — UI ships as TypeScript
  // source from packages/ui. transpilePackages tells Next to
  // compile it through the same pipeline as app code so we don't
  // need a separate tsc/dist step.
  transpilePackages: ["@zkscatter/ui"],
  turbopack: {
    // Each app under apps/* has its own package-lock.json, which
    // makes Turbopack auto-detect the app dir as project root.
    // That refuses to follow symlinked file: deps to packages/*.
    // Pin the root to the repo so packages/ui resolves.
    root: path.join(__dirname, "..", ".."),
  },
};

export default nextConfig;
