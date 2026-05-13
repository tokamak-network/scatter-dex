/**
 * Shared helpers for E2E test scripts.
 * Used by e2e-private-flow.ts, e2e-market-order.ts, e2e-cross-relayer.ts.
 */

import fs from "node:fs";
import nodePath from "node:path";
import { poseidon2, poseidon3, poseidon5, poseidon7, poseidon9 } from "poseidon-lite";
import { TAG_COMMITMENT_V2 } from "../../src/core/tags.js";

export const BN254_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export function poseidonHash(inputs: bigint[]): bigint {
  switch (inputs.length) {
    case 2: return poseidon2(inputs);
    case 3: return poseidon3(inputs);
    case 5: return poseidon5(inputs);
    case 7: return poseidon7(inputs);
    case 9: return poseidon9(inputs);
    default: throw new Error(`poseidonHash: unsupported arity ${inputs.length}`);
  }
}

export function computeCommitmentV2(
  secret: bigint, token: bigint, amount: bigint,
  salt: bigint, pubKeyAx: bigint, pubKeyAy: bigint,
): bigint {
  return poseidonHash([TAG_COMMITMENT_V2, secret, token, amount, salt, pubKeyAx, pubKeyAy]);
}

export function randomFieldElement(): bigint {
  let value: bigint;
  do {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    bytes[0] &= 0x3f;
    value = 0n;
    for (const b of bytes) value = (value << 8n) | BigInt(b);
  } while (value >= BN254_ORDER);
  return value;
}

export function toHex(n: bigint, bytes: number): string {
  return "0x" + n.toString(16).padStart(bytes * 2, "0");
}

export function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
  console.log(`  ✓ ${msg}`);
}

export async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function buildTree(leaves: bigint[], depth: number) {
  const zeros: bigint[] = [0n];
  for (let i = 1; i <= depth; i++) zeros.push(poseidonHash([zeros[i - 1], zeros[i - 1]]));
  const size = 2 ** depth;
  const padded = [...leaves];
  while (padded.length < size) padded.push(zeros[0]);
  const layers: bigint[][] = [padded];
  let current = padded;
  for (let i = 0; i < depth; i++) {
    const next: bigint[] = [];
    for (let j = 0; j < current.length; j += 2) next.push(poseidonHash([current[j], current[j + 1]]));
    layers.push(next);
    current = next;
  }
  return { root: current[0], layers };
}

export function getMerkleProof(layers: bigint[][], idx: number) {
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];
  let index = idx;
  for (let i = 0; i < layers.length - 1; i++) {
    const isRight = index % 2;
    const siblingIndex = isRight ? index - 1 : index + 1;
    pathElements.push(layers[i][siblingIndex] ?? 0n);
    pathIndices.push(isRight);
    index = Math.floor(index / 2);
  }
  return { pathElements, pathIndices };
}

export function formatProof(proof: any) {
  return {
    proofA: [proof.pi_a[0], proof.pi_a[1]],
    proofB: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ],
    proofC: [proof.pi_c[0], proof.pi_c[1]],
  };
}

// Resolve a deployed contract / token address from the latest Foundry
// broadcast log of DeployLocal.s.sol. Lets E2E scripts avoid hard-coding
// addresses that move every time the deploy script changes (proxy
// migration, contract reordering, etc.). Environment override via
// `envVar` always wins so CI can pin or shadow as needed.
//
// `name` matches the contract or token name as it appears in the
// broadcast JSON. For MockTokens (which all share `contractName ==
// "MockToken"`) pass `tokenSymbol` to disambiguate by constructor arg.
// Parallel jq logic lives in scripts/run-e2e.sh — keep both in sync.
export function resolveBroadcastAddress(args: {
  name: string;
  tokenSymbol?: string;
  envVar?: string;
  rootDir: string;
}): string {
  if (args.envVar) {
    const override = process.env[args.envVar];
    if (override) return override;
  }
  const broadcastFile = nodePath.join(
    args.rootDir,
    "contracts/broadcast/DeployLocal.s.sol/31337/run-latest.json",
  );
  let raw: string;
  try {
    raw = fs.readFileSync(broadcastFile, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new Error(`broadcast file not found: ${broadcastFile} — run DeployLocal first`);
    }
    throw err;
  }
  const txs = JSON.parse(raw).transactions ?? [];
  let addr: string | undefined;
  if (args.tokenSymbol) {
    // MockToken constructor: (string name, string symbol, uint8 decimals)
    addr = txs.find((t: any) =>
      t.contractName === args.name && t.arguments?.[1] === args.tokenSymbol,
    )?.contractAddress;
  } else {
    // Upgradeable contracts surface as `Name` impl + immediately-following
    // `TransparentUpgradeableProxy` tx (DeployLocal.s.sol uses Transparent,
    // not ERC1967, per OZ's deployUpgradeable pattern). Prefer the proxy.
    // Non-upgradeable contracts (e.g. WETH9, Poseidon libraries) just have
    // the single tx — return that. We deliberately do NOT return the impl
    // when a proxy is expected-but-missing: silently sending production
    // calls to a storage-less impl is the failure mode the guard exists
    // to prevent. Add the contract name to PROXY_DEPLOYED below when a
    // new upgradeable surface ships.
    const PROXY_DEPLOYED = new Set([
      "BatchExecutor", "CommitmentPool", "FeeVault", "IdentityGate",
      "PrivateSettlement", "RelayerRegistry", "SanctionsList",
    ]);
    const idx = txs.findIndex((t: any) => t.contractName === args.name);
    if (idx >= 0) {
      const next = txs[idx + 1];
      if (PROXY_DEPLOYED.has(args.name)) {
        if (next?.contractName !== "TransparentUpgradeableProxy") {
          throw new Error(
            `expected TransparentUpgradeableProxy after ${args.name} in broadcast, got '${next?.contractName ?? "<eof>"}' — DeployLocal tx order may have changed`,
          );
        }
        addr = next.contractAddress;
      } else {
        addr = txs[idx].contractAddress;
      }
    }
  }
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new Error(
      `failed to resolve ${args.name}${args.tokenSymbol ? `(${args.tokenSymbol})` : ""} from broadcast — got '${addr}'`,
    );
  }
  return addr;
}

// Raw JSON-RPC balance reads. ethers' provider caches the "latest" block
// across `tx.wait()` boundaries, so `provider.getBalance(addr)` (or any
// `contract.balanceOf(addr)` call) right after a tx confirmation can
// return the pre-tx value even though the on-chain state already
// updated (verified independently via `cast balance --block N`). These
// helpers bypass that cache by going straight to JSON-RPC.
//
// Use in any E2E test that snapshots a balance immediately before/after
// a tx and asserts on the delta.
export async function getEthBalanceFresh(
  provider: { send(method: string, params: any[]): Promise<string> },
  addr: string,
): Promise<bigint> {
  const hex = await provider.send("eth_getBalance", [addr, "latest"]);
  return BigInt(hex);
}

export async function getErc20BalanceFresh(
  provider: { send(method: string, params: any[]): Promise<string> },
  token: string,
  addr: string,
): Promise<bigint> {
  // balanceOf(address) selector = 0x70a08231; address padded to 32 bytes.
  const data = "0x70a08231" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const hex = await provider.send("eth_call", [{ to: token, data }, "latest"]);
  return BigInt(hex);
}
