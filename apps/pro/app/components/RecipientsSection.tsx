"use client";

import { useCallback, useMemo } from "react";
import { RecipientsEditor } from "@zkscatter/recipients";
import type { ParsedRecipient } from "@zkscatter/recipients";
import { MAX_RECIPIENTS, useTradeForm, type RecipientRow } from "../lib/tradeForm";
import { useConfirm } from "../lib/useConfirm";
import { useWalletBook } from "../lib/walletBook";
import { parseUnits } from "../lib/parseUnits";
import { formatTokenAmount } from "../lib/format";

interface RecipientsSectionProps {
  /** Quote-token symbol displayed alongside amount inputs so the
   *  user knows what currency the amounts are in (e.g. `USDC`). */
  quoteSymbol: string;
  /** Display string for the order's projected receive total (the
   *  `buyAmount`). Used by the `Split equally` helper to spread
   *  across rows and by the live sum/balance feedback. */
  receiveTotal: string;
  /** Decimals of the buy-side token. The live sum compares against
   *  `parseUnits(receiveTotal, decimals)` so rounding doesn't lie
   *  about an order that would actually pass validation. */
  receiveDecimals: number;
}

/** Recipients + per-row absolute release datetime. Surfaced as a
 *  top-level form section (not behind Advanced) because multi-
 *  recipient distribution + schedule is core to Pro's pitch. */
export function RecipientsSection({
  quoteSymbol,
  receiveTotal,
  receiveDecimals,
}: RecipientsSectionProps) {
  const {
    recipients,
    resetRecipients,
    setRecipients,
    splitEqually,
    activeTier,
  } = useTradeForm();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const walletBook = useWalletBook();

  // The editor talks in `ParsedRecipient`; `RecipientRow` extends
  // that, narrowing `name`/`releaseAt` to required strings. The
  // editor's shape is permissive on those (optional), so we coerce
  // the rare missing values to `""` on the way back into the form.
  const onChange = useCallback(
    (rows: ParsedRecipient[]) => {
      setRecipients(
        rows.map((r) => ({
          ...r,
          name: r.name ?? "",
          releaseAt: r.releaseAt ?? "",
        })),
      );
    },
    [setRecipients],
  );

  // Live sum across rows + delta vs the order's projected receive
  // total. Users get immediate feedback that their split adds up
  // (or doesn't) without having to wait for the submit-time
  // `resolveClaims` error. Track the first row whose amount didn't
  // parse — silently summing past it would hide validation errors
  // until submit and surface as a misleading "short by X" delta.
  const { sumStr, deltaStr, balanced, invalidRow } = useMemo(() => {
    if (!receiveTotal || receiveTotal.replace(/,/g, "") === "") {
      return { sumStr: "—", deltaStr: "", balanced: false, invalidRow: null };
    }
    let target: bigint;
    try {
      target = parseUnits(receiveTotal.replace(/,/g, ""), receiveDecimals);
    } catch {
      return { sumStr: "—", deltaStr: "", balanced: false, invalidRow: null };
    }
    let sum = 0n;
    let firstInvalid: number | null = null;
    recipients.forEach((r, i) => {
      if (!r.amount.trim()) return;
      try {
        sum += parseUnits(r.amount.replace(/,/g, ""), receiveDecimals);
      } catch {
        if (firstInvalid === null) firstInvalid = i + 1;
      }
    });
    const balanced = sum === target && firstInvalid === null;
    const diff = sum > target ? sum - target : target - sum;
    return {
      sumStr: `${formatTokenAmount(sum, receiveDecimals)} ${quoteSymbol}`,
      deltaStr: balanced
        ? ""
        : `${sum > target ? "over" : "short"} by ${formatTokenAmount(diff, receiveDecimals)} ${quoteSymbol}`,
      balanced,
      invalidRow: firstInvalid,
    };
  }, [recipients, receiveTotal, receiveDecimals, quoteSymbol]);

  const onReset = useCallback(async () => {
    // Confirm whenever the user has typed anything across any row —
    // including a `releaseAt` they set without touching
    // address/amount. Without scanning every field the reset can
    // silently nuke a non-trivial schedule with no prompt.
    const hasInput = recipients.some(
      (r) =>
        r.address.trim() !== "" ||
        r.amount.trim() !== "" ||
        r.releaseAt.trim() !== "" ||
        (r.name ?? "").trim() !== "" ||
        (r.email ?? "").trim() !== "",
    );
    if (hasInput) {
      const ok = await confirm({
        title: "Reset recipients?",
        message: "Any addresses and amounts you've entered will be cleared.",
        confirmLabel: "Reset",
        danger: true,
      });
      if (!ok) return;
    }
    resetRecipients();
  }, [confirm, recipients, resetRecipients]);

  return (
    <section className="mt-4 space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <RecipientsEditor
        value={recipients}
        onChange={onChange}
        columns={["name", "address", "amount", "email", "releaseAt"]}
        modes={["rows", "csv", "spreadsheet"]}
        maxRows={MAX_RECIPIENTS}
        amountSymbol={quoteSymbol}
        addressBook={walletBook.entries}
        sampleHref="/samples/recipients-sample.csv"
        storageKey="pro:recipients-editor-mode"
        helperActions={
          <div className="flex items-center gap-2 text-[11px]">
            <button
              type="button"
              onClick={() => splitEqually(receiveTotal, receiveDecimals)}
              disabled={!receiveTotal || receiveTotal.replace(/,/g, "") === ""}
              className="font-medium text-[var(--color-primary)] hover:underline disabled:opacity-40"
              title="Spread the projected receive total evenly across all rows"
            >
              Split equally
            </button>
            <span className="text-[var(--color-text-subtle)]">·</span>
            <button
              type="button"
              onClick={onReset}
              className="text-[var(--color-text-subtle)] hover:text-[var(--color-primary)]"
            >
              Reset
            </button>
          </div>
        }
      />

      <p className="text-[11px] text-[var(--color-text-subtle)]">
        Up to {MAX_RECIPIENTS} recipients per order — routed through the{" "}
        <span className="font-mono">tier-{activeTier.cap}</span> circuit.
        Empty address = your own wallet. Empty release time = claim immediately
        on settle.
      </p>

      <div
        className={`flex items-center justify-between text-[11px] ${
          invalidRow !== null
            ? "text-[var(--color-danger)]"
            : balanced
              ? "text-[var(--color-success)]"
              : "text-[var(--color-text-muted)]"
        }`}
      >
        <span>Allocated</span>
        <span className="font-mono">
          {invalidRow !== null
            ? `Recipient #${invalidRow} amount is invalid`
            : `${sumStr}${deltaStr ? ` · ${deltaStr}` : ""}`}
        </span>
      </div>

      {confirmDialog}
    </section>
  );
}
