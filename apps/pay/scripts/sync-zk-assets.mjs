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

// Tier-16 + deposit must always be present — Pay's worker requires
// them at runtime and a missing copy means the prover silently
// 404s mid-flow. Fail the sync if any of these are absent from the
// source tree.
const REQUIRED = [
  "authorize.wasm",
  "authorize_final.zkey",
  "claim.wasm",
  "claim_final.zkey",
  "deposit.wasm",
  "deposit_final.zkey",
  // Pool-withdraw flow (per-commitment Withdraw button on the
  // dashboard pool card). Required so the Withdraw modal's prover
  // can fetch /zk/withdraw.* at runtime.
  "withdraw.wasm",
  "withdraw_final.zkey",
];

// Tier-64 / tier-128 — produced only once the per-tier ceremony has
// run. Sync them when present; silently skip when absent so a
// tier-16-only circuits/ tree (e.g. before PR-B's ACTIVE_TIERS flip
// or on a clean clone that hasn't built circuits yet) still lets
// Pay come up. `pickActiveTier` already filters to ACTIVE_TIERS, so
// the 404 risk is bounded — Pay never asks for a tier whose verifier
// isn't on-chain.
const OPTIONAL = [
  "authorize_64.wasm",
  "authorize_64_final.zkey",
  "authorize_128.wasm",
  "authorize_128_final.zkey",
  "claim_64.wasm",
  "claim_64_final.zkey",
  "claim_128.wasm",
  "claim_128_final.zkey",
];

if (!existsSync(src)) {
  console.error(`[sync-zk-assets] source missing: ${src}`);
  process.exit(1);
}
mkdirSync(dst, { recursive: true });

const force = process.argv.includes("--force") || process.env.SYNC_ZK_FORCE === "1";

function syncFile(f, { required }) {
  const s = resolve(src, f);
  const d = resolve(dst, f);
  if (!existsSync(s)) {
    if (required) {
      console.error(`[sync-zk-assets] required asset missing in source: ${s}`);
      process.exit(1);
    }
    if (process.env.SYNC_ZK_VERBOSE === "1") {
      console.log(`[sync-zk-assets] skipped ${f} (not present in source)`);
    }
    return;
  }
  // Skip the 19 MB re-write only when dst is byte-equivalent AND not
  // older than src. Size alone is not enough — if a circuit rebuild
  // produces a same-size zkey (rare but possible), Pay would silently
  // keep stale assets and the prover would fail with an opaque
  // verifier mismatch. mtime catches that. `--force` (or
  // SYNC_ZK_FORCE=1) bypasses the cache entirely.
  if (!force && existsSync(d)) {
    const ss = statSync(s);
    const ds = statSync(d);
    if (ss.size === ds.size && ds.mtimeMs >= ss.mtimeMs) return;
  }
  copyFileSync(s, d);
  console.log(`[sync-zk-assets] copied ${f} (${statSync(d).size} bytes)`);
}

for (const f of REQUIRED) syncFile(f, { required: true });
for (const f of OPTIONAL) syncFile(f, { required: false });
