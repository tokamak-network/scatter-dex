/**
 *  Header detection is best-effort: if the first row looks like a
 *  header (matches our known column names and contains no 0x address),
 *  it's used to map columns; otherwise the parser falls back to
 *  positional A/B/C = name/address/amount so the textarea's existing
 *  format keeps working without a header.
 */

export type ParsedRecipient = {
  name: string;
  address: string;
  amount: string;
};

export type ParseResult = {
  rows: ParsedRecipient[];
  warnings: string[];
};

const HEADER_PATTERNS: Record<"name" | "address" | "amount", RegExp> = {
  name: /^(name|이름|직원|employee|label|alias|email|recipient|payee)$/i,
  address: /^(address|wallet|지갑|주소|to|payee[\s_-]?address|wallet[\s_-]?address)$/i,
  amount: /^(amount|금액|급여|salary|usdc|usdt|value|qty|quantity|payout|bonus)$/i,
};

function classifyHeader(cell: unknown): "name" | "address" | "amount" | null {
  if (typeof cell !== "string") return null;
  const v = cell.trim();
  if (!v) return null;
  for (const k of Object.keys(HEADER_PATTERNS) as Array<keyof typeof HEADER_PATTERNS>) {
    if (HEADER_PATTERNS[k].test(v)) return k;
  }
  return null;
}

function looksLikeAddress(cell: unknown): boolean {
  return typeof cell === "string" && /^0x[a-fA-F0-9]{40}$/.test(cell.trim());
}

function cellToString(c: unknown): string {
  if (c == null) return "";
  if (c instanceof Date) return c.toISOString();
  return String(c).trim();
}

function rowsFromMatrix(matrix: unknown[][]): ParseResult {
  const warnings: string[] = [];
  while (matrix.length > 0 && matrix[matrix.length - 1].every((c) => cellToString(c) === "")) {
    matrix.pop();
  }
  if (matrix.length === 0) return { rows: [], warnings: ["File is empty."] };

  const first = matrix[0];
  const cls = first.map(classifyHeader);
  const namedCount = cls.filter(Boolean).length;
  const hasAddrInRow0 = first.some(looksLikeAddress);

  let nameCol = -1;
  let addrCol = -1;
  let amtCol = -1;
  let dataStart = 0;

  if (!hasAddrInRow0 && namedCount >= 2) {
    cls.forEach((c, i) => {
      if (c === "name" && nameCol < 0) nameCol = i;
      else if (c === "address" && addrCol < 0) addrCol = i;
      else if (c === "amount" && amtCol < 0) amtCol = i;
    });
    dataStart = 1;
  } else {
    nameCol = 0;
    addrCol = 1;
    amtCol = 2;
  }

  if (addrCol < 0) {
    return {
      rows: [],
      warnings: ['Could not find an "address" column. Add a header row (name/address/amount) or place addresses in column B.'],
    };
  }
  if (amtCol < 0) {
    return {
      rows: [],
      warnings: ['Could not find an "amount" column. Add a header row (name/address/amount) or place amounts in column C.'],
    };
  }

  const out: ParsedRecipient[] = [];
  let skippedNoAddr = 0;
  for (let i = dataStart; i < matrix.length; i++) {
    const row = matrix[i] ?? [];
    if (row.every((c) => cellToString(c) === "")) continue;
    const get = (col: number) => (col >= 0 ? cellToString(row[col]) : "");
    const address = get(addrCol);
    if (!address) {
      skippedNoAddr++;
      continue;
    }
    out.push({
      name: get(nameCol),
      address,
      amount: get(amtCol),
    });
  }
  if (skippedNoAddr > 0) {
    warnings.push(`Skipped ${skippedNoAddr} row(s) with no address.`);
  }
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
