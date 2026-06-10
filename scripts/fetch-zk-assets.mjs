#!/usr/bin/env node
// Populate an app's public/zk with the canonical zk prover assets pinned in
// circuits/zk-manifest.json. Runs on predev/prebuild and in CI so a clean
// clone "just works" without committing 256 MB of binaries to git.
//
// Per artifact, in order (every path is sha256-verified against the manifest):
//   1) already in public/zk with the right hash  -> skip
//   2) present in circuits/build with the right hash -> copy (local canonical)
//   3) otherwise download from the public GCS bucket -> verify -> write
//
//   node scripts/fetch-zk-assets.mjs <app>     # app = pro | pay
//   node scripts/fetch-zk-assets.mjs <app> --force
//
// Exits non-zero if any required artifact can't be obtained or fails its hash.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUILD_DIR, CIRCUITS, gcsObjectUrl, loadManifest, projectRoot, sha256File } from "./lib/zk.mjs";

const manifest = loadManifest();

// Which circuits each app's browser proves against, derived from the canonical
// list so a new circuit flows in automatically. Pay has no cancel-order flow.
const APP_CIRCUITS = {
  pro: CIRCUITS,
  pay: CIRCUITS.filter((c) => c !== "cancel"),
};

const app = process.argv[2];
const force = process.argv.includes("--force") || process.env.SYNC_ZK_FORCE === "1";
if (!app || !APP_CIRCUITS[app]) {
  console.error(`[fetch-zk-assets] usage: fetch-zk-assets.mjs <${Object.keys(APP_CIRCUITS).join("|")}>`);
  process.exit(2);
}

const names = APP_CIRCUITS[app].flatMap((c) => [`${c}.wasm`, `${c}_final.zkey`]);
const dstDir = resolve(projectRoot, "apps", app, "public/zk");
mkdirSync(dstDir, { recursive: true });

async function download(url, dst, expected) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== expected) throw new Error(`sha256 mismatch from ${url}: got ${got}, want ${expected}`);
  const tmp = `${dst}.tmp`;
  writeFileSync(tmp, buf);
  renameSync(tmp, dst);
}

async function ensure(name) {
  const meta = manifest.artifacts[name];
  if (!meta) throw new Error(`${name} not in manifest`);
  const dst = resolve(dstDir, name);

  if (!force && existsSync(dst) && sha256File(dst) === meta.sha256) return "ok";

  const local = resolve(BUILD_DIR, meta.src);
  if (existsSync(local) && sha256File(local) === meta.sha256) {
    copyFileSync(local, dst);
    return "copied from circuits/build";
  }

  await download(gcsObjectUrl(meta.sha256), dst, meta.sha256);
  return "downloaded from GCS";
}

let failed = 0;
for (const name of names) {
  try {
    const how = await ensure(name);
    if (how !== "ok") console.log(`[fetch-zk-assets] ${app}/${name}: ${how}`);
  } catch (e) {
    console.error(`[fetch-zk-assets] FAILED ${app}/${name}: ${e.message}`);
    failed++;
  }
}
if (failed) {
  console.error(`[fetch-zk-assets] ${failed} artifact(s) unavailable. On a fresh clone the GCS bucket must be populated (scripts/upload-zk-artifacts.sh) or circuits built locally.`);
  process.exit(1);
}
console.log(`[fetch-zk-assets] ${app}: ${names.length} artifacts present & verified.`);
