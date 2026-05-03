"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { useRunRecord } from "../../_lib/runRecord";
import { buildClaimUrl } from "../../_lib/claimUrl";
import { formatLocalStamp } from "../../_lib/format";

/** Print-friendly per-recipient payslip. Opened via the detail page's
 *  Actions → "Print payslip (PDF)" menu in a new tab; the user hits
 *  Cmd/Ctrl+P (auto-triggered on load) and saves the page as PDF
 *  through the browser's native print dialog. No PDF library needed —
 *  the browser does the heavy lifting and the layout renders the same
 *  as the operator sees on screen. Static export friendly: pure client
 *  component, no API routes, no SSR. */
export default function Payslip() {
  return (
    <Suspense fallback={<p className="p-8 text-sm">Loading payslip…</p>}>
      <PayslipInner />
    </Suspense>
  );
}

function PayslipInner() {
  const searchParams = useSearchParams();
  const id = searchParams?.get("id") ?? undefined;
  const rowParam = searchParams?.get("row");
  const rowIndex = rowParam !== null && rowParam !== undefined ? Number(rowParam) : NaN;
  const { record, loaded, error } = useRunRecord(id);

  // Auto-open the print dialog once the data has rendered. A small
  // delay ensures the layout has painted; without it, Chrome opens a
  // mid-render snapshot of the page on a cold tab. The user can also
  // re-trigger from File → Print if they dismiss the first dialog.
  useEffect(() => {
    if (!record) return;
    const timer = window.setTimeout(() => window.print(), 300);
    return () => window.clearTimeout(timer);
  }, [record]);

  if (!loaded) {
    return <p className="p-8 text-sm">Loading…</p>;
  }
  if (error) {
    return <p className="p-8 text-sm text-red-600">Error: {error}</p>;
  }
  if (!record) {
    return <p className="p-8 text-sm text-red-600">Run not found.</p>;
  }

  const row = Number.isFinite(rowIndex)
    ? record.recipients.find((r) => r.rowIndex === rowIndex)
    : undefined;
  if (!row) {
    return <p className="p-8 text-sm text-red-600">Recipient not found.</p>;
  }

  const claimUrl =
    typeof window !== "undefined"
      ? buildClaimUrl(window.location.origin, record.id, row)
      : "";

  if (record.category === "payroll") {
    return <PayrollPayslip record={record} row={row} claimUrl={claimUrl} />;
  }
  return <GenericPayslip record={record} row={row} claimUrl={claimUrl} />;
}

/** Korean-style 급여명세서 layout used for `category === "payroll"`.
 *  We don't have full HR fields (사원번호 / 부서 / 공제내역 등); show
 *  what RunRecord carries and label the gaps explicitly so a finance
 *  reviewer can fill them by hand if a more formal slip is needed. */
function PayrollPayslip({
  record,
  row,
  claimUrl,
}: {
  record: import("@zkscatter/sdk/storage").RunRecord;
  row: import("@zkscatter/sdk/storage").RecipientRow;
  claimUrl: string;
}) {
  const issued = formatLocalStamp(record.createdAt);
  return (
    <div className="mx-auto max-w-2xl bg-white p-10 text-black">
      <header className="text-center">
        <h1 className="text-2xl font-bold uppercase tracking-wide">Payroll Statement</h1>
        <p className="mt-3 text-sm text-gray-700">{record.label}</p>
        <p className="text-xs text-gray-500">Issue date · {issued}</p>
      </header>

      <section className="mt-6 border-t border-b border-black">
        <table className="w-full text-sm">
          <tbody>
            <tr className="border-b border-gray-300">
              <th className="w-1/3 bg-gray-50 p-2 text-left text-xs font-semibold">Employee</th>
              <td className="p-2">{row.name || "—"}</td>
            </tr>
            <tr className="border-b border-gray-300">
              <th className="bg-gray-50 p-2 text-left text-xs font-semibold">Payment address</th>
              <td className="break-all p-2 font-mono text-xs">{row.address}</td>
            </tr>
            <tr className="border-b border-gray-300">
              <th className="bg-gray-50 p-2 text-left text-xs font-semibold">Available to claim</th>
              <td className="p-2">
                {row.claimFrom ? formatLocalStamp(row.claimFrom) : "Available now"}
              </td>
            </tr>
            <tr>
              <th className="bg-gray-50 p-2 text-left text-xs font-semibold">Settle transaction</th>
              <td className="break-all p-2 font-mono text-xs">{record.txHash}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="mt-6">
        <h2 className="border-b border-black pb-1 text-sm font-semibold">Earnings</h2>
        <table className="mt-2 w-full text-sm">
          <tbody>
            <tr className="border-b border-gray-200">
              <td className="py-1.5">Base salary</td>
              <td className="py-1.5 text-right font-mono">
                {row.amount} {record.tokenSymbol}
              </td>
            </tr>
            <tr className="border-b border-black bg-gray-50">
              <td className="py-2 font-semibold">Gross pay</td>
              <td className="py-2 text-right font-mono font-semibold">
                {row.amount} {record.tokenSymbol}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="mt-2 text-[10px] text-gray-500">
          Note: This statement reflects the on-chain settlement amount. Tax withholding,
          social insurance, and other statutory deductions are calculated separately.
        </p>
      </section>

      <section className="mt-6">
        <h2 className="border-b border-black pb-1 text-sm font-semibold">Net payment</h2>
        <p className="mt-2 text-right font-mono text-xl font-bold">
          {row.amount} {record.tokenSymbol}
        </p>
      </section>

      <section className="mt-8 border border-gray-400 p-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-700">
          Claim link
        </h3>
        <p className="mt-1 break-all font-mono text-[10px]">{claimUrl || "—"}</p>
        <p className="mt-2 text-[10px] text-gray-600">
          Open the link above to claim your payment. It is private to you and never
          expires.
        </p>
      </section>

      <footer className="mt-8 border-t border-gray-300 pt-2 text-[10px] text-gray-500">
        Document ID <span className="font-mono">{record.id}</span> · Generated{" "}
        {formatLocalStamp(Math.floor(Date.now() / 1000))}
      </footer>
    </div>
  );
}

function GenericPayslip({
  record,
  row,
  claimUrl,
}: {
  record: import("@zkscatter/sdk/storage").RunRecord;
  row: import("@zkscatter/sdk/storage").RecipientRow;
  claimUrl: string;
}) {
  return (
    <div className="mx-auto max-w-2xl bg-white p-10 text-black">
      <header className="border-b border-black pb-4">
        <h1 className="text-2xl font-bold">Payment Receipt</h1>
        <p className="text-sm text-gray-700">{record.label}</p>
        <p className="mt-1 text-xs text-gray-500">
          Run id: <span className="font-mono">{record.id}</span>
        </p>
      </header>

      <section className="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <Cell k="Recipient" v={row.name || "—"} />
        <Cell k="Amount" v={`${row.amount} ${record.tokenSymbol}`} />
        <Cell k="Address" v={<span className="break-all font-mono">{row.address}</span>} />
        <Cell
          k="Claim opens"
          v={row.claimFrom ? formatLocalStamp(row.claimFrom) : "Available now"}
        />
        <Cell k="Issued" v={formatLocalStamp(record.createdAt)} />
        <Cell
          k="Settle tx"
          v={<span className="break-all font-mono text-xs">{record.txHash}</span>}
        />
      </section>

      <section className="mt-8 border-t border-gray-300 pt-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-600">
          Claim link
        </h2>
        <p className="mt-1 break-all font-mono text-xs">{claimUrl || "—"}</p>
        <p className="mt-3 text-xs text-gray-600">
          Open this link to claim your payment. The link is private to you and
          never expires.
        </p>
      </section>

      <footer className="mt-10 border-t border-gray-300 pt-3 text-xs text-gray-500">
        Generated {formatLocalStamp(Math.floor(Date.now() / 1000))}
      </footer>
    </div>
  );
}

function Cell({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{k}</div>
      <div className="mt-0.5 font-medium">{v}</div>
    </div>
  );
}
