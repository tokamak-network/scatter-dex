// Shared helpers for the zk-asset tooling (gen-zk-manifest, fetch-zk-assets,
// check-zk-pairing). Single source of truth for the canonical circuit list,
// build-path mapping, and GCS layout. See README "Deployed networks".

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BUCKET = "zkscatter-zk-artifacts";

// Canonical circuits the browsers prove against (one .wasm + one _final.zkey
// each). Keep in sync with circuits/scripts/build.sh.
export const CIRCUITS = [
  "authorize", "authorize_64", "authorize_128",
  "claim", "claim_64", "claim_128",
  "deposit", "withdraw", "cancel",
];

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BUILD_DIR = resolve(projectRoot, "circuits/build");
export const MANIFEST_PATH = resolve(projectRoot, "circuits/zk-manifest.json");

// Public object URL for a content-addressed artifact. Pass the manifest's
// bucket so the download follows the committed pinset (BUCKET is only a default).
export const gcsObjectUrl = (sha256, bucket = BUCKET) =>
  `https://storage.googleapis.com/${bucket}/zk/${sha256}`;

export const sha256File = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

// Served artifact name -> path within circuits/build.
export function buildSources(circuits = CIRCUITS) {
  const out = {};
  for (const base of circuits) {
    out[`${base}.wasm`] = `${base}_js/${base}.wasm`;
    out[`${base}_final.zkey`] = `${base}_final.zkey`;
  }
  return out;
}

export const loadManifest = () =>
  JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
