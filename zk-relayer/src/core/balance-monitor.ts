/**
 * Periodic ETH balance probe that emits warn/info webhook alerts
 * on the healthy↔low transition. The relayer can't settle once
 * the operator wallet runs out of gas; this monitor closes the
 * "we ran out and nobody noticed" loop without depending on
 * dashboard polling.
 *
 * Mirrors the transition-only contract of health-monitor.ts —
 * first probe sets the baseline silently, only flips emit alerts.
 */

import { config } from "../config.js";
import type { PrivateSubmitter } from "./private-submitter.js";
import { sendAlert } from "./alerts.js";

export type BalanceState = "healthy" | "low";

let lastState: BalanceState | null = null;
let lastProbeAt: number | null = null;
let lastBalanceWei: bigint | null = null;
let intervalHandle: NodeJS.Timeout | null = null;

export function getLastBalance(): {
  state: BalanceState | null;
  at: number | null;
  balanceWei: string | null;
  thresholdWei: string;
} {
  return {
    state: lastState,
    at: lastProbeAt,
    balanceWei: lastBalanceWei?.toString() ?? null,
    thresholdWei: config.lowBalanceWei.toString(),
  };
}

export function startBalanceMonitor(
  submitter: PrivateSubmitter,
  intervalMs = 60_000,
): () => void {
  if (intervalHandle) return () => stopBalanceMonitor();
  void runProbe(submitter);
  intervalHandle = setInterval(() => {
    void runProbe(submitter);
  }, intervalMs);
  return () => stopBalanceMonitor();
}

export function stopBalanceMonitor(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export function _resetBalanceMonitorForTests(): void {
  stopBalanceMonitor();
  lastState = null;
  lastProbeAt = null;
  lastBalanceWei = null;
}

/** Test-only hook to run a single probe synchronously. */
export async function _runProbeOnceForTests(
  submitter: PrivateSubmitter,
): Promise<void> {
  await runProbe(submitter);
}

async function runProbe(submitter: PrivateSubmitter): Promise<void> {
  let balance: bigint;
  try {
    const wallet = submitter.getWallet();
    balance = await submitter.getProvider().getBalance(wallet.address);
  } catch (e) {
    // Don't transition on a probe error — the RPC could be flaky and
    // the health monitor already flags that. Silently skip this tick.
    console.warn("[balance-monitor] probe failed:", e instanceof Error ? e.message : e);
    return;
  }
  lastProbeAt = Date.now();
  lastBalanceWei = balance;
  const state: BalanceState = balance < config.lowBalanceWei ? "low" : "healthy";
  const previous = lastState;
  lastState = state;
  if (previous === null) return; // baseline
  if (previous === state) return;

  if (state === "low") {
    void sendAlert({
      type: "balance_low",
      severity: "warn",
      text: `Relayer wallet balance is below the configured threshold.`,
      payload: {
        balanceWei: balance.toString(),
        thresholdWei: config.lowBalanceWei.toString(),
      },
    });
  } else {
    void sendAlert({
      type: "balance_recovered",
      severity: "info",
      text: `Relayer wallet balance is back above the threshold.`,
      payload: {
        balanceWei: balance.toString(),
        thresholdWei: config.lowBalanceWei.toString(),
      },
    });
  }
}
