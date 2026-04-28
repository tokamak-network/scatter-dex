import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Zero-build dev for shared packages — both `@zkscatter/ui` and
  // `@zkscatter/sdk` ship as TypeScript source. `transpilePackages`
  // tells Next to compile them through the same pipeline as app
  // code so we don't need a separate tsc/dist step. Pro and
  // frontend already list both for parity.
  transpilePackages: ["@zkscatter/ui", "@zkscatter/sdk"],
  turbopack: {
    // Each app under apps/* has its own package-lock.json, which
    // makes Turbopack auto-detect the app dir as project root.
    // That refuses to follow symlinked file: deps to packages/*.
    // Pin the root to the repo so packages/ui resolves.
    root: path.join(__dirname, "..", ".."),
  },
};

export default nextConfig;
