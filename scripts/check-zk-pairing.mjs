#!/usr/bin/env node
// Guardrail: verify each canonical zkey (circuits/build, pinned by
// circuits/zk-manifest.json) actually pairs with the on-chain verifier the
// deployments ledger points at. Catches the drift class that surfaces only as
// `InvalidProof()` (0x09bde339) at proof time — see README "Deployed networks".
//
// Method: a Groth16 verifier hard-codes its verification key as constants in
// bytecode. We take the circuit-specific G1 points (alpha_1 + IC[]) from the
// vkey and check each appears as a 32-byte word in the verifier's on-chain
// runtime code (eth_getCode). G2 generators are skipped (shared across
// verifiers -> false matches).
//
//   node scripts/check-zk-pairing.mjs                 # chain 11155111 (Sepolia)
//   ZK_PAIRING_RPC=<url> node scripts/check-zk-pairing.mjs --chain 11155111
//
// Exit: 0 all pass, 1 any mismatch, 2 setup error.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { BUILD_DIR, projectRoot } from "./lib/zk.mjs";

// Run the CLI script via `node` (not the .bin shim) so it works on Windows too.
const SNARKJS = resolve(projectRoot, "circuits/node_modules/snarkjs/cli.js");
const chain = (() => { const i = process.argv.indexOf("--chain"); return i > -1 ? process.argv[i + 1] : "11155111"; })();
const RPC = process.env.ZK_PAIRING_RPC || process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com";
const ledger = JSON.parse(readFileSync(resolve(projectRoot, `contracts/deployments/${chain}.json`), "utf8"));

// ledger verifier key -> circuit base. `optional` entries are skipped when the
// ledger has no address for them.
const MAP = [
  ["authorizeVerifier16", "authorize"],
  ["authorizeVerifier64", "authorize_64"],
  ["authorizeVerifier128", "authorize_128"],
  ["claimVerifier16", "claim"],
  ["claimVerifier64", "claim_64"],
  ["claimVerifier128", "claim_128"],
  ["depositVerifier", "deposit"],
  ["withdrawVerifier", "withdraw"],
  ["cancelVerifier", "cancel", { optional: true }],
];

async function getCode(addr) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "eth_getCode", params: [addr, "latest"] }),
  });
  if (!res.ok) throw new Error(`eth_getCode HTTP ${res.status} ${res.statusText} for ${addr}`);
  const j = await res.json();
  if (!j.result) throw new Error(`eth_getCode failed for ${addr}: ${JSON.stringify(j.error || j)}`);
  return j.result.toLowerCase();
}

// Prefer the committed vkey JSON; fall back to exporting it from the zkey.
function loadVkey(base) {
  const direct = resolve(BUILD_DIR, `${base}_vkey.json`);
  if (existsSync(direct)) return JSON.parse(readFileSync(direct, "utf8"));
  const zkey = resolve(BUILD_DIR, `${base}_final.zkey`);
  if (!existsSync(zkey)) return null;
  const dir = mkdtempSync(resolve(tmpdir(), "zkpair-"));
  try {
    const out = resolve(dir, "vk.json");
    execFileSync("node", [SNARKJS, "zkey", "export", "verificationkey", zkey, out], { stdio: "ignore" });
    return JSON.parse(readFileSync(out, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function g1Constants(vk) {
  const pts = [vk.vk_alpha_1[0], vk.vk_alpha_1[1]];
  for (const ic of vk.IC || []) pts.push(ic[0], ic[1]);
  return pts.map((d) => BigInt(d).toString(16).padStart(64, "0"));
}

let fail = 0, checked = 0;
for (const [key, base, opts] of MAP) {
  const addr = ledger[key];
  if (!addr || /^0x0+$/.test(addr)) { if (!opts?.optional) console.warn(`[check-zk-pairing] no ledger address for ${key} — skipped`); continue; }
  const vk = loadVkey(base);
  if (!vk) { console.warn(`[check-zk-pairing] ${base} vkey/zkey not in circuits/build — skipped`); continue; }
  let code;
  try { code = await getCode(addr); }
  catch (e) { console.error(`[check-zk-pairing] ${key}: ${e.message}`); fail++; continue; }
  const g1 = g1Constants(vk);
  const found = g1.filter((h) => code.includes(h)).length;
  const ok = found >= g1.length - 1; // 1 tolerated: rare leading-zero encoding artifact
  checked++;
  console.log(`${ok ? "✓" : "✗"} ${key.padEnd(20)} ${addr}  ${base}  G1 ${found}/${g1.length}`);
  if (!ok) fail++;
}

if (fail) {
  console.error(`\n[check-zk-pairing] ${fail} mismatch(es). A served zkey does NOT pair with its on-chain verifier — proofs will revert InvalidProof(). Re-fetch the canonical zkey, or redeploy+re-point the verifier. See README "Deployed networks".`);
  process.exit(1);
}
console.log(`\n[check-zk-pairing] all ${checked} verifiers pair with circuits/build ✓`);
