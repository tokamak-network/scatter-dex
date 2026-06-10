#!/usr/bin/env node
// Generate circuits/zk-manifest.json from the canonical circuits/build
// artifacts. The manifest is the git-committed source of truth for which
// zkey/wasm bytes the frontends MUST serve — each entry pins a sha256 so
// fetch-zk-assets.mjs can download + verify the exact canonical bytes from
// GCS (large, non-reproducible binaries stay out of git history).
//
// Run after a circuit rotation (rebuild + redeploy verifiers), then upload
// with scripts/upload-zk-artifacts.sh. See README "Deployed networks".
//
//   node scripts/gen-zk-manifest.mjs            # write circuits/zk-manifest.json
//   node scripts/gen-zk-manifest.mjs --check    # verify manifest matches build, exit 1 on drift

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUCKET, BUILD_DIR, MANIFEST_PATH, buildSources, sha256File } from "./lib/zk.mjs";

function build() {
  const artifacts = {};
  const missing = [];
  for (const [name, rel] of Object.entries(buildSources())) {
    const p = resolve(BUILD_DIR, rel);
    if (!existsSync(p)) { missing.push(rel); continue; }
    artifacts[name] = { sha256: sha256File(p), bytes: statSync(p).size, src: rel };
  }
  if (missing.length) {
    console.error(`[gen-zk-manifest] missing in circuits/build (build circuits first):\n  ${missing.join("\n  ")}`);
    process.exit(2);
  }
  return { bucket: BUCKET, artifacts };
}

const serialized = JSON.stringify(build(), null, 2) + "\n";

if (process.argv.includes("--check")) {
  const cur = existsSync(MANIFEST_PATH) ? readFileSync(MANIFEST_PATH, "utf8") : "";
  if (cur !== serialized) {
    console.error("[gen-zk-manifest] DRIFT: circuits/zk-manifest.json is out of date. Run: node scripts/gen-zk-manifest.mjs");
    process.exit(1);
  }
  console.log("[gen-zk-manifest] manifest matches circuits/build ✓");
} else {
  writeFileSync(MANIFEST_PATH, serialized);
  console.log(`[gen-zk-manifest] wrote ${MANIFEST_PATH}`);
}
