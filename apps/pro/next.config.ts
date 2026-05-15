import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Static export for Firebase Hosting (Spark plan, no SSR runtime).
  // All data fetching is client-side (wagmi/relayer), so SSG is sufficient.
  output: "export",
  images: { unoptimized: true },
  // Zero-build dev for shared packages — SDK + UI ship as TypeScript
  // source from packages/* (see packages/sdk/README.md > Distribution).
  // transpilePackages tells Next to compile them through the same
  // pipeline as app code so we don't need a separate tsc/dist step.
  transpilePackages: [
    "@zkscatter/recipients",
    "@zkscatter/sdk",
    "@zkscatter/ui",
  ],
  turbopack: {
    // Each app under apps/* has its own package-lock.json, which makes
    // Turbopack auto-detect the app dir as project root. That refuses
    // to follow symlinked file: deps to packages/*. Pin the root to
    // the repo so packages/sdk and packages/ui resolve.
    root: path.join(__dirname, "..", ".."),
  },
};

export default nextConfig;
