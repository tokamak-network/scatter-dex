import type { NextConfig } from "next";
import path from "path";

const isDev = process.env.NODE_ENV === "development";

// Additional CSP connect-src origins for custom RPC/relayer endpoints.
// Set CSP_EXTRA_CONNECT_SRC="https://rpc.example.com https://relayer.example.com" in .env
const extraConnectSrc = process.env.CSP_EXTRA_CONNECT_SRC?.trim() || "";

const nextConfig: NextConfig = {
  // SDK ships as TypeScript source from packages/sdk; transpile it
  // through the same pipeline as app code so we don't need a
  // separate tsc/dist step.
  transpilePackages: ["@zkscatter/sdk"],
  turbopack: {
    // Pin Turbopack's project root to the monorepo root so it
    // follows the symlinked `file:` dep at packages/sdk instead of
    // refusing because frontend has its own lockfile.
    root: path.join(__dirname, ".."),
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // [L-6] CSP: restrict script/connect sources to mitigate XSS-based key theft.
          //
          // No `unsafe-eval` in `script-src`. snarkjs runs only inside the
          // `*-worker.ts` files (claim / authorize / deposit / cancel) —
          // `warmProverAssets` in `lib/zk/zkey-cache.ts` is the only
          // dynamic `import("snarkjs")`, and grep confirms it's invoked
          // exclusively from worker context. The main thread never
          // touches `Function()` / `eval`, so the historical
          // `'unsafe-eval'` allowance is vestigial and removing it closes
          // the XSS → RCE escalation route. If a future change reintroduces
          // a main-thread snarkjs call site, the browser console will flag
          // a CSP violation — fix the call site, don't loosen the header.
          //
          // 'self' + 'unsafe-inline' on script-src still required for
          // Next.js hydration scripts. connect-src enumerates RPC +
          // relayer endpoints; localhost is dev-only.
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "img-src 'self' data: blob:",
              "font-src 'self' https://fonts.gstatic.com",
              `connect-src 'self' blob:${isDev ? " http://localhost:* ws://localhost:*" : ""} https://*.1inch.dev https://*.infura.io https://*.alchemy.com wss://*.infura.io wss://*.alchemy.com${extraConnectSrc ? " " + extraConnectSrc : ""}`,
              "worker-src 'self' blob:",
              "frame-ancestors 'none'",
            ].join("; "),
          },
          // COOP/COEP enable SharedArrayBuffer for snarkjs Worker pool
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
};

export default nextConfig;
