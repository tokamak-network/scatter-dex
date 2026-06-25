#!/usr/bin/env node
/**
 * Patch each `contracts/src/zk/BatchAuthorizeVerifier{,_64,_128}.sol`'s
 * Groth16 verifying-key constants with the values from the matching
 * `circuits/build/authorize{,_64,_128}_final.zkey`.
 *
 * Why this script exists: the BatchAuthorizeVerifier contracts are
 * hand-written (5-pairing aggregator over two authorize.circom proofs — see
 * docs/design/contracts/supporting-contracts.md `BatchAuthorizeVerifier
 * 최적화`), so unlike the snarkjs-generated `AuthorizeVerifier*.sol`
 * they can't be re-exported by `build.sh` step 6. Without this script
 * a batch verifier's VK silently diverges from its zkey every time
 * phase-2 is re-run, and any `setBatchAuthorizeVerifier` deploy then
 * reverts every same-tier `settleAuth` with `InvalidProof()` — exactly
 * the failure mode that already cost a session on the per-side
 * `AuthorizeVerifier.sol` drift (PR #708).
 *
 * Every tier shares the same hand-tuned 5-pairing assembly; only the 78
 * VK numerics (46 named consts above + IC0..IC15) differ per tier, so the
 * patch is a surgical regex-replace that leaves the assembly untouched.
 *
 * Usage:
 *   node circuits/scripts/sync-batch-verifier-vk.mjs           # write all tiers
 *   node circuits/scripts/sync-batch-verifier-vk.mjs --check   # verify in sync (CI gate)
 *
 * Exit codes:
 *   0  all tiers in sync (--check) or successfully patched (default)
 *   1  any tier out of sync (--check), or any IO / parse failure
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHECK_MODE = process.argv.includes("--check");

// Each tier: the zkey/vkey it's proven against and the hand-written verifier
// whose VK constants mirror it. tier 16 uses the unsuffixed artifacts.
const TIERS = [
  { tier: 16, slug: "authorize", verifier: "BatchAuthorizeVerifier.sol" },
  { tier: 64, slug: "authorize_64", verifier: "BatchAuthorizeVerifier_64.sol" },
  { tier: 128, slug: "authorize_128", verifier: "BatchAuthorizeVerifier_128.sol" },
];

function die(msg) {
  console.error(`[sync-batch-verifier-vk] ${msg}`);
  process.exit(1);
}

// G2 element packing matches what snarkjs's `zkey export solidityverifier`
// emits — the "imaginary" part (index 1) maps to the `*1` solidity
// constant, the "real" part (index 0) to `*2`. Inverting these would
// type-check but produce a verifier whose pairing check always fails.
const g2 = (arr, axis) => ({ x1: arr[axis][1], x2: arr[axis][0] });
const prefix = (n, x, y) => ({ [`${n}x1`]: x.x1, [`${n}x2`]: x.x2, [`${n}y1`]: y.x1, [`${n}y2`]: y.x2 });

async function loadVk(slug) {
  // Prefer the cached vkey JSON (build.sh writes it as step 5), else
  // extract straight from the zkey so the script stays callable from
  // `start-e2e-env.sh`'s leaner sync step that skips the JSON export.
  const vkJson = path.join(ROOT, `circuits/build/${slug}_vkey.json`);
  const zkey = path.join(ROOT, `circuits/build/${slug}_final.zkey`);
  if (fs.existsSync(vkJson)) return JSON.parse(fs.readFileSync(vkJson, "utf8"));
  if (fs.existsSync(zkey)) {
    const snarkjs = await import("snarkjs");
    return snarkjs.zKey.exportVerificationKey(zkey);
  }
  die(`neither ${vkJson} nor ${zkey} exists — run circuits/scripts/build.sh first`);
}

function wantedConstants(vk, slug) {
  const wanted = {
    alphax: vk.vk_alpha_1[0],
    alphay: vk.vk_alpha_1[1],
    ...prefix("beta", g2(vk.vk_beta_2, 0), g2(vk.vk_beta_2, 1)),
    ...prefix("gamma", g2(vk.vk_gamma_2, 0), g2(vk.vk_gamma_2, 1)),
    ...prefix("delta", g2(vk.vk_delta_2, 0), g2(vk.vk_delta_2, 1)),
  };
  const expectedIcCount = 16; // 15 public signals + IC0 (same across tiers)
  if (vk.IC.length !== expectedIcCount) {
    die(`${slug}: expected ${expectedIcCount} IC entries, got ${vk.IC.length} — authorize.circom signal count changed; review the BatchAuthorizeVerifier IC loop before regenerating`);
  }
  for (let i = 0; i < expectedIcCount; i++) {
    wanted[`IC${i}x`] = vk.IC[i][0];
    wanted[`IC${i}y`] = vk.IC[i][1];
  }
  return wanted;
}

/** @returns {boolean} true if the file was already in sync */
async function syncTier({ tier, slug, verifier }) {
  const file = path.join(ROOT, "contracts/src/zk", verifier);
  if (!fs.existsSync(file)) die(`missing ${file}`);
  const wanted = wantedConstants(await loadVk(slug), slug);

  let src = fs.readFileSync(file, "utf8");
  const before = src;
  let touched = 0;
  for (const [name, value] of Object.entries(wanted)) {
    const re = new RegExp(`(uint256\\s+constant\\s+${name}\\s*=\\s*)(\\d+)(\\s*;)`);
    if (!re.test(src)) die(`could not find constant '${name}' in ${verifier} — file structure changed`);
    src = src.replace(re, (_, head, oldVal, tail) => {
      if (oldVal !== value) touched++;
      return `${head}${value}${tail}`;
    });
  }

  const inSync = src === before;
  if (inSync) return true;
  if (CHECK_MODE) {
    console.error(`[sync-batch-verifier-vk] tier ${tier} OUT OF SYNC — ${touched}/${Object.keys(wanted).length} constants differ from ${slug}_final.zkey`);
    return false;
  }
  fs.writeFileSync(file, src);
  console.log(`[sync-batch-verifier-vk] tier ${tier}: patched ${touched}/${Object.keys(wanted).length} constants in ${path.relative(ROOT, file)}`);
  return false;
}

let allInSync = true;
for (const t of TIERS) {
  const inSync = await syncTier(t);
  allInSync = allInSync && inSync;
}

if (CHECK_MODE) {
  if (allInSync) {
    console.log("[sync-batch-verifier-vk] all tiers in sync");
    process.exit(0);
  }
  console.error("  run: node circuits/scripts/sync-batch-verifier-vk.mjs");
  process.exit(1);
}
if (allInSync) console.log("[sync-batch-verifier-vk] all tiers already in sync (no write)");
