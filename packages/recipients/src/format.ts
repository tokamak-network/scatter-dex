import type { ParsedRecipient, RecipientField } from "./types";
import { csvEscape, csvSafeLabel } from "./csv";

/** Serialize one row to a CSV line, honoring the host app's
 *  `columns` order. Uses `csvSafeLabel` for free-text fields so the
 *  textarea/CSV round-trip stays predictable, then `csvEscape` for
 *  belt-and-braces RFC 4180 safety on the wire. */
export function formatRecipientCsvRow(
  r: Partial<ParsedRecipient>,
  columns: readonly RecipientField[],
): string {
  return columns
    .map((col) => {
      const raw = r[col] ?? "";
      // Free-text label fields get their commas/newlines stripped so
      // the textarea path keeps reading as plain "a,b,c". Address
      // and amount are already constrained shape, but escape them too
      // so a stray edit never breaks the CSV.
      if (col === "name") return csvSafeLabel(raw);
      return csvEscape(raw);
    })
    .join(",");
}

/** Header line for a CSV download. Capitalised + spaced to look
 *  natural when the operator opens the file in Excel. */
export function formatRecipientCsvHeader(columns: readonly RecipientField[]): string {
  const map: Record<RecipientField, string> = {
    name: "Name",
    address: "Address",
    amount: "Amount",
    email: "Email",
    releaseAt: "Release At",
  };
  return columns.map((c) => map[c]).join(",");
}
