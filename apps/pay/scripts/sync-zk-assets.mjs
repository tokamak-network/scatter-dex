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

const force = process.argv.includes("--force") || process.env.SYNC_ZK_FORCE === "1";

for (const f of FILES) {
  const s = resolve(src, f);
  const d = resolve(dst, f);
  // Skip the 19 MB re-write only when dst is byte-equivalent AND not
  // older than src. Size alone is not enough — if a circuit rebuild
  // produces a same-size zkey (rare but possible), Pay would silently
  // keep stale assets and the prover would fail with an opaque
  // verifier mismatch. mtime catches that. `--force` (or
  // SYNC_ZK_FORCE=1) bypasses the cache entirely.
  if (!force && existsSync(d)) {
    const ss = statSync(s);
    const ds = statSync(d);
    if (ss.size === ds.size && ds.mtimeMs >= ss.mtimeMs) continue;
  }
  copyFileSync(s, d);
  console.log(`[sync-zk-assets] copied ${f} (${statSync(d).size} bytes)`);
}
