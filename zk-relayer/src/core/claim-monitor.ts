/**
 * Per-token FeeVault claimable-balance monitor. Mirrors the
 * transition-only contract of balance-monitor.ts: each tracked
 * token has its own state, the first probe seeds a baseline
 * silently, and only state flips emit alerts. The relayer never
 * auto-claims; this just nudges the operator when accruals cross
 * a threshold (and quiets down when the balance drops, signalling
 * that a manual claim landed).
 *
 * Tokens to track come from `config.feeClaimTokens`; an empty list
 * disables the monitor so a fresh deployment stays silent until
 * the operator opts in.
 */

import { ethers } from "ethers";
import { config } from "../config.js";

// Inlined ABI fragment so this module loads under vitest, which
// doesn't have the @zkscatter/sdk workspace alias wired up.
const VAULT_BALANCES_ABI = [
  "function balances(address operator, address token) view returns (uint256)",
];
import type { PrivateSubmitter } from "./private-submitter.js";
import type { PrivateOrderDB } from "./db.js";
import { sendAlert, type AlertSeverity } from "./alerts.js";
import { createLogger } from "./logger.js";

const log = createLogger("claim-monitor");

export type ClaimState = "below" | "ready";

export interface TokenProbe {
  state: ClaimState;
  balanceWei: string;
  thresholdWei: string;
  at: number;
}

/** Reads the operator's claimable balance for `token` from FeeVault.
 *  Pulled out so tests can substitute a synchronous fake without
 *  building an ethers Contract over a mock provider. */
export type ClaimReader = (operator: string, token: string) => Promise<bigint>;

// Per-token probe state. Address keys are stored lowercased so all
// reads/writes go through the same canonical form regardless of how
// the operator typed the address into the threshold config. The map
// doubles as the baseline sentinel: a missing entry means "first
// probe, no alert".
const lastProbe = new Map<string, TokenProbe>();
let intervalHandle: NodeJS.Timeout | null = null;

export function getClaimProbes(): Record<string, TokenProbe> {
  return Object.fromEntries(lastProbe);
}

export function _resetClaimMonitorForTests(): void {
  stopClaimMonitor();
  lastProbe.clear();
}

export function stopClaimMonitor(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

function ethersClaimReader(submitter: PrivateSubmitter): ClaimReader {
  const vault = new ethers.Contract(
    config.feeVaultAddress,
    VAULT_BALANCES_ABI,
    submitter.getProvider(),
  );
  return async (operator, token) =>
    (await vault.balances(operator, token)) as bigint;
}

export function startClaimMonitor(
  submitter: PrivateSubmitter,
  db: PrivateOrderDB,
  intervalMs: number = config.feeClaimProbeIntervalMs,
): () => void {
  if (intervalHandle) return () => stopClaimMonitor();
  if (config.feeClaimTokens.length === 0) return () => {};
  const reader = ethersClaimReader(submitter);
  void runProbe(submitter.getAddress(), db, reader);
  intervalHandle = setInterval(() => {
    void runProbe(submitter.getAddress(), db, reader);
  }, intervalMs);
  return () => stopClaimMonitor();
}

export async function _runProbeOnceForTests(
  operator: string,
  db: PrivateOrderDB,
  reader: ClaimReader,
): Promise<void> {
  await runProbe(operator, db, reader);
}

interface OneTokenResult {
  token: string;
  tokenLc: string;
  balance: bigint;
  thresholdWei: bigint;
}

async function probeOneToken(
  operator: string,
  token: string,
  thresholdWei: bigint,
  reader: ClaimReader,
): Promise<OneTokenResult | null> {
  try {
    const balance = await reader(operator, token);
    return { token, tokenLc: token.toLowerCase(), balance, thresholdWei };
  } catch (e) {
    // Skip this token on a bad RPC read — health-monitor surfaces
    // RPC outages and we don't want to flap state on transient
    // hiccups.
    log.warn("probe failed", {
      token,
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

async function runProbe(
  operator: string,
  db: PrivateOrderDB,
  reader: ClaimReader,
): Promise<void> {
  const thresholds = db.getClaimThresholds();
  // Independent per-token RPC calls — fan out so N tokens stay one
  // tick wide instead of N ticks deep.
  const results = await Promise.all(
    config.feeClaimTokens.map((token) =>
      probeOneToken(
        operator,
        token,
        BigInt(thresholds[token.toLowerCase()] ?? "0"),
        reader,
      ),
    ),
  );

  for (const r of results) {
    if (!r) continue;
    const { token, tokenLc, balance, thresholdWei } = r;
    // Threshold of 0 means "tracked but no nudge wanted" — the UI
    // still sees probe data, but state never flips into `ready`.
    const state: ClaimState =
      thresholdWei > 0n && balance >= thresholdWei ? "ready" : "below";
    const previous = lastProbe.get(tokenLc)?.state ?? null;
    lastProbe.set(tokenLc, {
      state,
      balanceWei: balance.toString(),
      thresholdWei: thresholdWei.toString(),
      at: Date.now(),
    });
    if (previous === null || previous === state) continue;

    const envelope: { type: string; severity: AlertSeverity; text: string } =
      state === "ready"
        ? {
            type: "claim_ready",
            severity: "warn",
            text: `FeeVault balance for ${token} crossed the claim threshold.`,
          }
        : {
            type: "claim_settled",
            severity: "info",
            text: `FeeVault balance for ${token} dropped below the claim threshold (likely just claimed).`,
          };
    void sendAlert({
      ...envelope,
      payload: {
        token,
        balanceWei: balance.toString(),
        thresholdWei: thresholdWei.toString(),
      },
    });
  }
}
