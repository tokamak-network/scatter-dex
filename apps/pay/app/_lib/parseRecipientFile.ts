/**
 *  Header detection is best-effort: if the first row looks like a
 *  header (matches our known column names and contains no 0x address),
 *  it's used to map columns; otherwise the parser falls back to
 *  positional A/B/C = name/address/amount so the textarea's existing
 *  format keeps working without a header.
 */
import { isAddress } from "ethers";

export type ParsedRecipient = {
  name: string;
  address: string;
  amount: string;
  /** Optional email for the row-level "Send via Gmail" action. Carrying
   *  it on the recipient (not via address-book lookup) keeps RunRecord
   *  self-contained and immune to later address-book edits. */
  email?: string;
};

export type ParseResult = {
  rows: ParsedRecipient[];
  warnings: string[];
};

type ColumnKind = "name" | "address" | "amount" | "email";

const HEADER_PATTERNS: Record<ColumnKind, RegExp> = {
  name: /^(name|이름|직원|employee|label|alias|recipient|payee)$/i,
  address: /^(address|wallet|지갑|주소|to|payee[\s_-]?address|wallet[\s_-]?address)$/i,
  amount: /^(amount|금액|급여|salary|usdc|usdt|value|qty|quantity|payout|bonus)$/i,
  email: /^(email|메일|이메일|e[\s_-]?mail)$/i,
};

function classifyHeader(cell: unknown): ColumnKind | null {
  if (typeof cell !== "string") return null;
  const v = cell.trim();
  if (!v) return null;
  for (const k of Object.keys(HEADER_PATTERNS) as ColumnKind[]) {
    if (HEADER_PATTERNS[k].test(v)) return k;
  }
  return null;
}

function looksLikeAddress(cell: unknown): boolean {
  // ethers.isAddress validates length AND checksum (mixed-case input
  // must match EIP-55) — a shape-only regex would silently accept
  // "0xAaA...Aaa" with a wrong checksum and let the bad row through.
  return typeof cell === "string" && isAddress(cell.trim());
}

function cellToString(c: unknown): string {
  if (c == null) return "";
  if (c instanceof Date) return c.toISOString();
  return String(c).trim();
}

function isCommentRow(row: unknown[]): boolean {
  // Treat a row as a comment when its first non-empty cell starts with
  // `#` AND none of the remaining cells holds something that looks like
  // a recipient address. Pure-text splatter from a comment whose prose
  // contains commas (e.g. `# foo, bar, baz`) gets correctly classified
  // — none of the fragments are addresses. A real data row whose name
  // starts with `#` (e.g. `#1234,0x...,100`) still survives because the
  // second cell IS an address.
  let firstNonEmptyStartsWithHash = false;
  let seenFirstNonEmpty = false;
  let hasIdentifier = false;
  for (const cell of row) {
    const s = cellToString(cell);
    if (!s) continue;
    if (!seenFirstNonEmpty) {
      seenFirstNonEmpty = true;
      firstNonEmptyStartsWithHash = s.startsWith("#");
      continue;
    }
    if (looksLikeAddress(s)) {
      hasIdentifier = true;
      break;
    }
  }
  return firstNonEmptyStartsWithHash && !hasIdentifier;
}

function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function rowsFromMatrix(matrix: unknown[][]): ParseResult {
  const warnings: string[] = [];
  while (matrix.length > 0 && matrix[matrix.length - 1].every((c) => cellToString(c) === "")) {
    matrix.pop();
  }
  matrix = matrix.filter((row) => !isCommentRow(row));
  if (matrix.length === 0) return { rows: [], warnings: ["File is empty."] };

  const first = matrix[0];
  const cls = first.map(classifyHeader);
  const namedCount = cls.filter(Boolean).length;
  const hasAddrInRow0 = first.some(looksLikeAddress);

  const cols: Record<ColumnKind, number> = {
    name: -1,
    address: -1,
    amount: -1,
    email: -1,
  };
  let dataStart = 0;

  if (!hasAddrInRow0 && namedCount >= 2) {
    cls.forEach((c, i) => {
      if (c && cols[c] < 0) cols[c] = i;
    });
    dataStart = 1;
  } else {
    // Positional fallback for header-less files: legacy 3-column shape
    // (name / address / amount). Optional email column is header-only
    // — without a header we have no way to tell column 4 from a stray
    // data column.
    cols.name = 0;
    cols.address = 1;
    cols.amount = 2;
  }

  if (cols.address < 0) {
    return {
      rows: [],
      warnings: ['Could not find an "address" column. Add a header row.'],
    };
  }
  if (cols.amount < 0) {
    return {
      rows: [],
      warnings: ['Could not find an "amount" column. Add a header row.'],
    };
  }

  const out: ParsedRecipient[] = [];
  const seenAddrs = new Set<string>();
  let skippedNoAddr = 0;
  let skippedBadAddr = 0;
  let skippedBadAmount = 0;
  let skippedBadEmail = 0;
  let skippedDup = 0;
  for (let i = dataStart; i < matrix.length; i++) {
    const row = matrix[i] ?? [];
    if (row.every((c) => cellToString(c) === "")) continue;
    const get = (col: number) => (col >= 0 ? cellToString(row[col]) : "");
    const address = get(cols.address);
    if (!address) {
      skippedNoAddr++;
      continue;
    }
    if (!looksLikeAddress(address)) {
      skippedBadAddr++;
      continue;
    }
    const amountRaw = get(cols.amount);
    const amount = amountRaw.replace(/[,_\s]/g, "");
    if (!/^\d+(\.\d+)?$/.test(amount)) {
      skippedBadAmount++;
      continue;
    }
    const email = get(cols.email);
    if (email && !looksLikeEmail(email)) {
      skippedBadEmail++;
      continue;
    }
    const dupKey = address.toLowerCase();
    if (seenAddrs.has(dupKey)) {
      skippedDup++;
      continue;
    }
    seenAddrs.add(dupKey);

    out.push({
      name: get(cols.name),
      address,
      amount,
      ...(email ? { email } : {}),
    });
  }
  if (skippedNoAddr > 0) warnings.push(`Skipped ${skippedNoAddr} row(s) with no address.`);
  if (skippedBadAddr > 0) warnings.push(`Skipped ${skippedBadAddr} row(s) with malformed address (expected 0x + 40 hex; mixed-case must match EIP-55 checksum).`);
  if (skippedBadAmount > 0) warnings.push(`Skipped ${skippedBadAmount} row(s) with non-numeric amount.`);
  if (skippedBadEmail > 0) warnings.push(`Skipped ${skippedBadEmail} row(s) with malformed email.`);
  if (skippedDup > 0) warnings.push(`Skipped ${skippedDup} duplicate row(s).`);
  return { rows: out, warnings };
}

/**
 *  Quote-aware RFC-4180-ish CSV reader. Handles quoted fields that
 *  contain commas (e.g. `"Doe, John"`) and newlines, plus doubled-up
 *  `""` escapes inside quotes. Keeps the parser dependency-free since
 *  the textarea path already produces CSV without quoted fields.
 */
function parseCsvText(text: string): ParseResult {
  const rows: string[][] = [];
  let cur = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '"' && cur === "") {
      inQuotes = true;
    } else if (c === ",") {
      row.push(cur.trim());
      cur = "";
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur.trim());
      rows.push(row);
      row = [];
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur !== "" || row.length > 0) {
    row.push(cur.trim());
    rows.push(row);
  }
  return rowsFromMatrix(rows);
}

export async function parseRecipientFile(file: File): Promise<ParseResult> {
  // Extension-first dispatch — `application/vnd.ms-excel` is ambiguous
  // (browsers tag both legacy binary .xls files and mis-labeled CSVs
  // with it), so MIME is only a fallback when the filename is missing
  // an extension.
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (ext === "xlsx") {
    // Dynamic import keeps read-excel-file out of the initial page bundle.
    const { default: readXlsxFile } = await import("read-excel-file/browser");
    const sheets = await readXlsxFile(file);
    const target = sheets.find((s) => s.data.length > 0) ?? sheets[0];
    if (!target) return { rows: [], warnings: ["File is empty."] };
    const result = rowsFromMatrix(target.data as unknown[][]);
    if (sheets.length > 1) {
      result.warnings.unshift(
        `Workbook has ${sheets.length} sheet(s); used "${target.sheet}". Save the right sheet first if this picked the wrong one.`,
      );
    }
    return result;
  }
  if (ext === "csv" || (!ext && file.type === "text/csv")) {
    const text = await file.text();
    return parseCsvText(text);
  }
  if (ext === "xls") {
    return {
      rows: [],
      warnings: [
        "Legacy .xls is not supported. Save the workbook as .xlsx (or export to CSV) and re-upload.",
      ],
    };
  }
  return {
    rows: [],
    warnings: [`Unsupported file type: ${ext || file.type || "unknown"}. Use .csv or .xlsx.`],
  };
}
