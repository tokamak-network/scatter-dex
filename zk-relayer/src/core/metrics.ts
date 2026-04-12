/**
 * [R-8] In-memory runtime metrics for relayer monitoring.
 *
 * Lightweight, zero-dependency metrics collector. No Prometheus needed —
 * metrics are served as JSON via /api/relayer/stats.
 *
 * Tracks:
 * - Settlement gas costs (ETH)
 * - Settlement durations (ms)
 * - Order throughput (orders/min rolling window)
 * - Pending TX count
 */

// ─── Ring buffer for recent samples ────────────────────────────

class RingBuffer {
  private buf: number[];
  private pos = 0;
  private count = 0;

  constructor(private capacity: number) {
    this.buf = new Array(capacity).fill(0);
  }

  push(value: number): void {
    this.buf[this.pos] = value;
    this.pos = (this.pos + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  values(): number[] {
    if (this.count < this.capacity) return this.buf.slice(0, this.count);
    // Return in chronological order
    return [...this.buf.slice(this.pos), ...this.buf.slice(0, this.pos)];
  }

  avg(): number | null {
    if (this.count === 0) return null;
    const vals = this.values();
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  min(): number | null {
    if (this.count === 0) return null;
    return Math.min(...this.values());
  }

  max(): number | null {
    if (this.count === 0) return null;
    return Math.max(...this.values());
  }

  latest(): number | null {
    if (this.count === 0) return null;
    const idx = (this.pos - 1 + this.capacity) % this.capacity;
    return this.buf[idx];
  }

  size(): number {
    return this.count;
  }
}

// ─── Throughput counter (sliding window) ───────────────────────

class ThroughputCounter {
  private timestamps: number[] = [];

  record(): void {
    this.timestamps.push(Date.now());
  }

  /** Orders per minute over the given window (default 5 min). */
  perMinute(windowMs = 5 * 60_000): number {
    const cutoff = Date.now() - windowMs;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
    if (this.timestamps.length === 0) return 0;
    const windowMinutes = windowMs / 60_000;
    return Math.round((this.timestamps.length / windowMinutes) * 10) / 10;
  }
}

// ─── Singleton metrics instance ────────────────────────────────

const SAMPLE_SIZE = 100; // keep last 100 settlements

/** Gas cost in ETH (float) for each settlement TX. */
const gasCostEth = new RingBuffer(SAMPLE_SIZE);

/** Settlement duration in ms (from order match → TX mined). */
const settleDurationMs = new RingBuffer(SAMPLE_SIZE);

/** Order submission throughput. */
const orderThroughput = new ThroughputCounter();

/** Settlement throughput. */
const settleThroughput = new ThroughputCounter();

/** Total settlements since startup. */
let totalSettlements = 0;

/** Total gas spent in ETH since startup. */
let totalGasEth = 0;

// ─── Public API ────────────────────────────────────────────────

export function recordSettlement(gasCostEthValue: number, durationMs: number): void {
  gasCostEth.push(gasCostEthValue);
  settleDurationMs.push(durationMs);
  settleThroughput.record();
  totalSettlements++;
  totalGasEth += gasCostEthValue;
}

export function recordOrderSubmitted(): void {
  orderThroughput.record();
}

export interface RuntimeMetrics {
  gas: {
    avgCostEth: number | null;
    minCostEth: number | null;
    maxCostEth: number | null;
    lastCostEth: number | null;
    totalSpentEth: number;
  };
  settlement: {
    avgDurationMs: number | null;
    minDurationMs: number | null;
    maxDurationMs: number | null;
    lastDurationMs: number | null;
    totalCount: number;
    perMinute: number;
  };
  orders: {
    submittedPerMinute: number;
  };
  sampleSize: number;
}

export function getMetrics(): RuntimeMetrics {
  return {
    gas: {
      avgCostEth: gasCostEth.avg(),
      minCostEth: gasCostEth.min(),
      maxCostEth: gasCostEth.max(),
      lastCostEth: gasCostEth.latest(),
      totalSpentEth: Math.round(totalGasEth * 1e6) / 1e6,
    },
    settlement: {
      avgDurationMs: settleDurationMs.avg() !== null ? Math.round(settleDurationMs.avg()!) : null,
      minDurationMs: settleDurationMs.min() !== null ? Math.round(settleDurationMs.min()!) : null,
      maxDurationMs: settleDurationMs.max() !== null ? Math.round(settleDurationMs.max()!) : null,
      lastDurationMs: settleDurationMs.latest() !== null ? Math.round(settleDurationMs.latest()!) : null,
      totalCount: totalSettlements,
      perMinute: settleThroughput.perMinute(),
    },
    orders: {
      submittedPerMinute: orderThroughput.perMinute(),
    },
    sampleSize: gasCostEth.size(),
  };
}
