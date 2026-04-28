import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Static HTML export — Pay deploys to Firebase Hosting, which only
  // serves static assets. Every route must be statically generatable;
  // the previously dynamic `[id]` / `[link]` segments were rewritten
  // to `?id=` query params (Next requires `<Suspense>` around any
  // `useSearchParams` consumer in this mode). `next build` writes
  // the prerendered tree into `out/`.
  output: "export",
  // The `<Image>` component would normally proxy through a Next
  // server; static export has no server, so the optimiser path
  // breaks. Pay only ships its own bundled assets so we just
  // disable optimisation rather than wiring an external loader.
  images: { unoptimized: true },
  // Zero-build dev for shared packages — UI ships as TypeScript
  // source from packages/ui. transpilePackages tells Next to
  // compile it through the same pipeline as app code so we don't
  // need a separate tsc/dist step.
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
