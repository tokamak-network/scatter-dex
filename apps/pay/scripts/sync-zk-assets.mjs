#!/usr/bin/env node
// Mirror the authorize-circuit assets from apps/pro/public/zk into
// apps/pay/public/zk so the worker can fetch /zk/authorize.* at
// runtime without committing 24 MB of binaries twice. Pro's copy is
// the canonical one; this runs as `predev` / `prebuild` on Pay.

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../pro/public/zk");
const dst = resolve(here, "../public/zk");

const FILES = ["authorize.wasm", "authorize_final.zkey"];

if (!existsSync(src)) {
  console.error(`[sync-zk-assets] source missing: ${src}`);
  process.exit(1);
}
mkdirSync(dst, { recursive: true });

for (const f of FILES) {
  const s = resolve(src, f);
  const d = resolve(dst, f);
  // Skip when dst is already an up-to-date copy — avoids a 19 MB
  // re-write on every dev / build invocation.
  if (existsSync(d) && statSync(s).size === statSync(d).size) continue;
  copyFileSync(s, d);
  console.log(`[sync-zk-assets] copied ${f} (${statSync(d).size} bytes)`);
}
