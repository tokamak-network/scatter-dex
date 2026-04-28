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
          // 'self' + 'unsafe-inline' needed for Next.js; 'unsafe-eval' for snarkjs/wasm.
          // connect-src allows relayer and RPC endpoints.
          // localhost is dev-only to prevent production data exfiltration.
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
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
