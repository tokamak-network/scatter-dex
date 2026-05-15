/** Shape every consumer sees. Optional fields are present only when
 *  the host app's `columns` prop opted into them — Pay leaves
 *  `releaseAt` undefined, Pro leaves nothing undefined. */
export type ParsedRecipient = {
  name: string;
  address: string;
  amount: string;
  /** Optional email for the row-level "Send via Gmail" / claim-ready
   *  notification. Carrying it on the recipient (not via address-book
   *  lookup) keeps RunRecord self-contained and immune to later
   *  address-book edits. */
  email?: string;
  /** Optional absolute release datetime (ISO-ish `<input type="datetime-local">`
   *  string, empty = claimable immediately). Pro uses this; Pay leaves
   *  it undefined. */
  releaseAt?: string;
};

/** Which fields a host app exposes. Drives header rendering,
 *  parser column filtering, and row-editor input visibility.
 *  Order matters — it's the on-screen / spreadsheet column order. */
export type RecipientField = "name" | "address" | "amount" | "email" | "releaseAt";

export const DEFAULT_COLUMNS: readonly RecipientField[] = [
  "name",
  "address",
  "amount",
  "email",
] as const;

export type ParseResult = {
  rows: ParsedRecipient[];
  warnings: string[];
};

export type EditorMode = "rows" | "csv" | "spreadsheet";

export const DEFAULT_MODES: readonly EditorMode[] = ["rows", "csv", "spreadsheet"] as const;
