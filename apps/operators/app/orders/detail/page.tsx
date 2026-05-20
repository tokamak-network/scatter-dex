"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { OperatorIdentityBar } from "../../components/OperatorIdentityBar";
import { DEMO_NETWORK } from "../../lib/network";
import { adminGet, type AdminAuth, readAdminAuth } from "../../lib/adminApi";
import { formatRelative } from "../../lib/format";

import type { AuthorizeProofSignals, SettlementRow } from "../../lib/adminTypes";

type Auth = AdminAuth | null;

interface FeeRow {
  id: number;
  tx_hash: string;
  side: "maker" | "taker" | "scatterDirect";
  token: string;
  amount_wei: string;
  block_number: number | null;
  created_at: number;
}

type DecodedSettlement =
  | {
      function: "settleAuth";
      maker: AuthorizeProofSignals;
      taker: AuthorizeProofSignals;
      feeTokenMaker: string;
      feeTokenTaker: string;
    }
  | {
      function: "scatterDirectAuth";
      proof: AuthorizeProofSignals;
      fee: string;
    };

interface ProofResponse {
  txHash: string;
  from: string | null;
  to: string | null;
  blockNumber: number | null;
  calldata: string;
  decoded: DecodedSettlement | null;
}

interface ProcessingRow {
  nullifier: string;
  status: string;
  submittedAt: number;
  updatedAt: number;
  attempt: number;
  nextRetryAt: number | null;
  lastError: string | null;
  settleTx: string | null;
  pubKeyAx: string | null;
  pubKeyAy: string | null;
  orderJson: string;
}

export default function OrderDetailPage() {
  // Static export friendly: dynamic segments aren't allowed, so the
  // tx hash arrives as `?tx=…` (mirrors apps/pay's payouts/detail
  // pattern). useSearchParams must run inside Suspense or it warns
  // during prerender.
  return (
    <Suspense fallback={<div className="p-6 text-sm text-[var(--color-text-muted)]">Loading…</div>}>
      <DetailInner />
    </Suspense>
  );
}

function DetailInner() {
  const params = useSearchParams();
  const tx = params.get("tx");
  const [auth, setAuth] = useState<Auth>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setAuth(readAdminAuth());
    setHydrated(true);
  }, []);

  return (
    <div className="space-y-8">
      <OperatorIdentityBar />
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Settlement detail</h1>
          {tx ? (
            <p className="mt-1 font-mono text-xs text-[var(--color-text-muted)]">{tx}</p>
          ) : (
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">No tx hash provided.</p>
          )}
        </div>
        <Link href="/orders" className="text-sm text-[var(--color-primary)] hover:underline">
          ← All orders
        </Link>
      </header>

      {!tx && (
        <p className="rounded-md bg-[var(--color-warning-soft)] px-3 py-2 text-xs text-[var(--color-warning)]">
          Append <code className="font-mono">?tx=0x…</code> to load a settlement.
        </p>
      )}

      {hydrated && tx && !auth && (
        <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
          Connect your relayer on{" "}
          <Link href="/dashboard" className="text-[var(--color-primary)] underline">
            /dashboard
          </Link>{" "}
          to view this settlement.
        </div>
      )}

      {auth && tx && <DetailBody auth={auth} txHash={tx} />}
    </div>
  );
}

function DetailBody({ auth, txHash }: { auth: NonNullable<Auth>; txHash: string }) {
  const [data, setData] = useState<{ settlement: SettlementRow; fees: FeeRow[]; processing: ProcessingRow[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        // Lowercase the tx hash so a checksummed/uppercase URL still
        // hits the lowercase storage form (DB normalises on insert).
        const res = await adminGet<{ settlement: SettlementRow; fees: FeeRow[]; processing: ProcessingRow[] }>(
          auth,
          `/api/admin/history/by-tx/${encodeURIComponent(txHash.toLowerCase())}`,
          signal,
        );
        if (!signal?.aborted) setData(res);
      } catch (e) {
        if (signal?.aborted || (e as Error).name === "AbortError") return;
        setError((e as Error).message);
        setData(null);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [auth, txHash],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  if (loading && !data) {
    return <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>;
  }
  if (error) {
    return (
      <div className="rounded-md bg-[var(--color-warning-soft)] px-4 py-3 text-sm text-[var(--color-warning)]">
        {error}
      </div>
    );
  }
  if (!data) return null;

  const { settlement: s, fees, processing } = data;
  const explorerUrl = DEMO_NETWORK.explorerBase
    ? `${DEMO_NETWORK.explorerBase}/tx/${s.tx_hash}`
    : null;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Settlement</h2>
          <span
            className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
              s.status === "confirmed"
                ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
                : "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
            }`}
          >
            {s.status}
          </span>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <Field label="Type" mono>
            {s.type}
          </Field>
          <Field label="Block" mono>
            {s.block_number ?? "—"}
          </Field>
          <Field label="Gas (ETH)" mono>
            {s.gas_cost_eth ?? "—"}
          </Field>
          <Field label="Recorded">
            {new Date(s.created_at).toLocaleString()}
          </Field>
          <Field label="Sell token" mono>
            {s.sell_token ?? "—"}
          </Field>
          <Field label="Buy token" mono>
            {s.buy_token ?? "—"}
          </Field>
        </dl>
        {explorerUrl && (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-block text-sm font-medium text-[var(--color-primary)] hover:underline"
          >
            View on {DEMO_NETWORK.name} explorer →
          </a>
        )}
        {s.error_reason && (
          <div className="mt-4 rounded-md bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
            <div className="font-semibold">Error reason</div>
            <p className="mt-1 font-mono">{s.error_reason}</p>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <h2 className="mb-3 font-semibold">Fees ({fees.length})</h2>
        {fees.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            No fee rows recorded for this settlement.
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
                <tr>
                  <th className="px-3 py-2 text-left">Side</th>
                  <th className="px-3 py-2 text-left">Token</th>
                  <th className="px-3 py-2 text-right">Amount (wei)</th>
                </tr>
              </thead>
              <tbody>
                {fees.map((f) => (
                  <tr key={f.id} className="border-t border-[var(--color-border)]">
                    <td className="px-3 py-2 text-xs">{f.side}</td>
                    <td className="px-3 py-2 font-mono text-xs">{f.token}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{f.amount_wei}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ProofInspectionSection auth={auth} txHash={s.tx_hash} />

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <h2 className="mb-3 font-semibold">Order processing ({processing.length})</h2>
        {processing.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            No <code className="font-mono">authorize_orders</code> rows match
            this settlement tx. Common reasons: the row was purged after the
            terminal-retention window, or the settlement pre-dates the
            <code className="font-mono"> settle_tx</code> column being wired.
          </p>
        ) : (
          <div className="space-y-3">
            {processing.map((p) => (
              <ProcessingCard key={p.nullifier} row={p} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ProcessingCard({ row }: { row: ProcessingRow }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
      <div className="flex items-center justify-between">
        <code className="font-mono text-xs">{row.nullifier}</code>
        <StatusPill status={row.status} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs md:grid-cols-4">
        <Field label="Attempts" mono>
          {row.attempt}
        </Field>
        <Field label="Submitted" mono>
          {formatRelative(row.submittedAt)}
        </Field>
        <Field label="Updated" mono>
          {new Date(row.updatedAt).toLocaleString()}
        </Field>
        <Field label="Next retry" mono>
          {row.nextRetryAt
            ? new Date(row.nextRetryAt).toLocaleString()
            : "—"}
        </Field>
      </dl>
      {row.lastError && (
        <div className="mt-3 rounded-md bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
          <div className="font-semibold">Last error</div>
          <p className="mt-1 font-mono">{row.lastError}</p>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls =
    status === "settled"
      ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
      : status === "failed" || status === "dead_letter"
      ? "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
      : "bg-[var(--color-bg)] text-[var(--color-text-subtle)]";
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}>
      {status}
    </span>
  );
}

function ProofInspectionSection({ auth, txHash }: { auth: NonNullable<Auth>; txHash: string }) {
  const [data, setData] = useState<ProofResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch only when the operator opens the section — proofs are large
  // and most page loads land here for fees/processing, not for proof
  // inspection. `data !== null` caches the result for the session;
  // a prior error leaves data null so reopening retries. The `loading`
  // guard prevents an open → close → open-while-in-flight race from
  // firing duplicate fetches and double-applying setData/setError.
  const onToggle = useCallback(
    async (e: React.SyntheticEvent<HTMLDetailsElement>) => {
      if (!e.currentTarget.open || data || loading) return;
      setLoading(true);
      setError(null);
      try {
        const res = await adminGet<ProofResponse>(
          auth,
          `/api/admin/orders/by-tx/${encodeURIComponent(txHash.toLowerCase())}/proof`,
        );
        setData(res);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [auth, txHash, data, loading],
  );

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <details onToggle={onToggle}>
        <summary className="cursor-pointer font-semibold">
          Proof inspection
          <span className="ml-2 text-xs font-normal text-[var(--color-text-subtle)]">
            (decoded public signals + raw calldata, fetched on demand)
          </span>
        </summary>
        <div className="mt-4">
          {loading && <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>}
          {error && (
            <div className="rounded-md bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
              {error}
            </div>
          )}
          {data && <ProofBody res={data} />}
        </div>
      </details>
    </section>
  );
}

function ProofBody({ res }: { res: ProofResponse }) {
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <Field label="Function" mono>{res.decoded?.function ?? "unknown selector"}</Field>
        <Field label="Block" mono>{res.blockNumber ?? "—"}</Field>
        <Field label="From" mono>{res.from ?? "—"}</Field>
        <Field label="To" mono>{res.to ?? "—"}</Field>
      </dl>
      {res.decoded?.function === "settleAuth" && (
        <>
          <ProofSignals title={`Maker proof — fee ${res.decoded.feeTokenMaker} (token-wei)`} signals={res.decoded.maker} />
          <ProofSignals title={`Taker proof — fee ${res.decoded.feeTokenTaker} (token-wei)`} signals={res.decoded.taker} />
        </>
      )}
      {res.decoded?.function === "scatterDirectAuth" && (
        <ProofSignals title={`Proof — fee ${res.decoded.fee} (token-wei)`} signals={res.decoded.proof} />
      )}
      {!res.decoded && (
        <p className="text-xs text-[var(--color-text-muted)]">
          The transaction selector doesn't match settleAuth or
          scatterDirectAuth. Calldata is shown raw below.
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-xs text-[var(--color-text-subtle)]">
          Raw calldata ({res.calldata.length} chars)
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-[var(--color-bg)] p-3 font-mono text-[10px] leading-relaxed">
          {res.calldata}
        </pre>
      </details>
    </div>
  );
}

// Display order — debug-relevant identifiers first (nullifier-family),
// then ordering data, then bookkeeping. Keep in sync with the
// AuthorizeProofSignals interface above.
const PROOF_FIELD_ORDER: ReadonlyArray<keyof AuthorizeProofSignals> = [
  "nullifier", "nonceNullifier", "newCommitment", "commitmentRoot",
  "claimsRoot", "orderHash", "pubKeyBind",
  "sellToken", "buyToken", "sellAmount", "buyAmount",
  "totalLocked", "relayer", "maxFee", "expiry", "tier",
];

function ProofSignals({ title, signals }: { title: string; signals: AuthorizeProofSignals }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-subtle)]">
        {title}
      </h3>
      <table className="w-full text-xs">
        <tbody>
          {PROOF_FIELD_ORDER.map((key) => (
            <tr key={key} className="border-t border-[var(--color-border)] first:border-t-0">
              <td className="py-1 pr-3 font-mono text-[var(--color-text-subtle)]">{key}</td>
              <td className="py-1 break-all font-mono">{String(signals[key])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Field({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-[var(--color-text-subtle)]">
        {label}
      </dt>
      <dd className={`mt-0.5 ${mono ? "font-mono text-xs" : ""}`}>{children}</dd>
    </div>
  );
}

