import type { RecipientRow } from "./tradeForm";
import { parseUnits } from "./parseUnits";

export interface RecipientsAllocation {
  /** Sum of parsed recipient amounts equals the target receive total
   *  and every populated row parsed cleanly. */
  balanced: boolean;
  /** 1-based row index of the first amount that failed to parse, or
   *  null if every populated row is numeric. */
  invalidRow: number | null;
}

/** Pure recipient-allocation check shared by `RecipientsSection`
 *  (which shows the live "Allocated / total" hint) and the workbench
 *  Sign & submit gate. Single source of truth so the button can't
 *  enable while the hint reads "short by X". */
export function evaluateRecipientsAllocation(
  recipients: RecipientRow[],
  receiveTotal: string,
  receiveDecimals: number,
): RecipientsAllocation {
  if (!receiveTotal || receiveTotal.replace(/,/g, "") === "") {
    return { balanced: false, invalidRow: null };
  }
  let target: bigint;
  try {
    target = parseUnits(receiveTotal.replace(/,/g, ""), receiveDecimals);
  } catch {
    return { balanced: false, invalidRow: null };
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
  return {
    balanced: sum === target && firstInvalid === null,
    invalidRow: firstInvalid,
  };
}
