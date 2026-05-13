#!/usr/bin/env node
/**
 * Patch `contracts/src/zk/BatchAuthorizeVerifier.sol`'s Groth16
 * verifying-key constants with the values from the current
 * `circuits/build/authorize_final.zkey`.
 *
 * Why this script exists: BatchAuthorizeVerifier is hand-written
 * (5-pairing aggregator over two authorize.circom proofs — see
 * docs/design/contracts/supporting-contracts.md `BatchAuthorizeVerifier
 * 최적화`), so unlike the snarkjs-generated `AuthorizeVerifier.sol`
 * it can't be re-exported by `build.sh` step 6. Without this script
 * the batch verifier's VK silently diverges from the zkey every time
 * phase-2 is re-run, and any `setBatchAuthorizeVerifier` deploy then
 * reverts every same-tier `settleAuth` with `InvalidProof()` — exactly
 * the failure mode that already cost a session on the per-side
 * `AuthorizeVerifier.sol` drift (PR #708).
 *
 * Works by surgical regex-replace on the existing constant block —
 * only the 46 VK numerics change between rebuilds, and keeping the
 * surrounding assembly + structure untouched matters because that's
 * the hand-tuned 5-pairing optimisation.
 *
 * Usage:
 *   node circuits/scripts/sync-batch-verifier-vk.mjs           # write
 *   node circuits/scripts/sync-batch-verifier-vk.mjs --check   # verify in sync (CI gate)
 *
 * Exit codes:
 *   0  in sync (--check) or successfully patched (default)
 *   1  out of sync (--check), or any IO / parse failure
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ZKEY = path.join(ROOT, "circuits/build/authorize_final.zkey");
const ZKEY_VK = path.join(ROOT, "circuits/build/authorize_vkey.json");
const VERIFIER = path.join(ROOT, "contracts/src/zk/BatchAuthorizeVerifier.sol");

const CHECK_MODE = process.argv.includes("--check");

function die(msg) {
  console.error(`[sync-batch-verifier-vk] ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(VERIFIER)) {
  die(`missing ${VERIFIER}`);
}

// Prefer the cached vkey JSON (build.sh writes it as step 5), else
// extract straight from the zkey so the script stays callable from
// `start-e2e-env.sh`'s leaner sync step that skips the JSON export.
let vk;
if (fs.existsSync(ZKEY_VK)) {
  vk = JSON.parse(fs.readFileSync(ZKEY_VK, "utf8"));
} else if (fs.existsSync(ZKEY)) {
  const snarkjs = await import("snarkjs");
  vk = await snarkjs.zKey.exportVerificationKey(ZKEY);
} else {
  die(`neither ${ZKEY_VK} nor ${ZKEY} exists — run circuits/scripts/build.sh first`);
}
// G2 element packing matches what snarkjs's `zkey export solidityverifier`
// emits — the "imaginary" part (index 1) maps to the `*1` solidity
// constant, the "real" part (index 0) to `*2`. Inverting these would
// type-check but produce a verifier whose pairing check always fails.
const g2 = (arr, axis) => ({ x1: arr[axis][1], x2: arr[axis][0] });

const wanted = {
  alphax: vk.vk_alpha_1[0],
  alphay: vk.vk_alpha_1[1],
  ...prefix("beta", g2(vk.vk_beta_2, 0), g2(vk.vk_beta_2, 1)),
  ...prefix("gamma", g2(vk.vk_gamma_2, 0), g2(vk.vk_gamma_2, 1)),
  ...prefix("delta", g2(vk.vk_delta_2, 0), g2(vk.vk_delta_2, 1)),
};
function prefix(n, x, y) {
  return { [`${n}x1`]: x.x1, [`${n}x2`]: x.x2, [`${n}y1`]: y.x1, [`${n}y2`]: y.x2 };
}
const expectedIcCount = 16; // 15 public signals + IC0
if (vk.IC.length !== expectedIcCount) {
  die(`expected ${expectedIcCount} IC entries in vkey, got ${vk.IC.length} — authorize.circom signal count changed; review the BatchAuthorizeVerifier IC loop before regenerating`);
}
for (let i = 0; i < expectedIcCount; i++) {
  wanted[`IC${i}x`] = vk.IC[i][0];
  wanted[`IC${i}y`] = vk.IC[i][1];
}

let src = fs.readFileSync(VERIFIER, "utf8");
const before = src;
let touched = 0;
for (const [name, value] of Object.entries(wanted)) {
  const re = new RegExp(`(uint256\\s+constant\\s+${name}\\s*=\\s*)(\\d+)(\\s*;)`);
  if (!re.test(src)) {
    die(`could not find constant '${name}' in ${VERIFIER} — file structure changed`);
  }
  src = src.replace(re, (_, head, oldVal, tail) => {
    if (oldVal !== value) touched++;
    return `${head}${value}${tail}`;
  });
}

const inSync = src === before;
if (CHECK_MODE) {
  if (inSync) {
    console.log("[sync-batch-verifier-vk] in sync");
    process.exit(0);
  }
  console.error(`[sync-batch-verifier-vk] OUT OF SYNC — ${touched}/${Object.keys(wanted).length} constants differ from current zkey`);
  console.error(`  run: node circuits/scripts/sync-batch-verifier-vk.mjs`);
  process.exit(1);
}
if (inSync) {
  console.log("[sync-batch-verifier-vk] already in sync (no write)");
  process.exit(0);
}
fs.writeFileSync(VERIFIER, src);
console.log(`[sync-batch-verifier-vk] patched ${touched}/${Object.keys(wanted).length} constants in ${path.relative(ROOT, VERIFIER)}`);
