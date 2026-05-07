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
  /** Optional EIP-5564 meta-address. When present, the wizard derives a
   *  one-time stealth address + ephemeral pubkey at upload time and the
   *  recipient's `address` is replaced with the derived stealth address.
   *  Marks the row as "stealth" without needing a separate flag column. */
  metaAddress?: string;
};

export type ParseResult = {
  rows: ParsedRecipient[];
  warnings: string[];
};

type ColumnKind = "name" | "address" | "amount" | "email" | "metaAddress";

const HEADER_PATTERNS: Record<ColumnKind, RegExp> = {
  name: /^(name|이름|직원|employee|label|alias|recipient|payee)$/i,
  address: /^(address|wallet|지갑|주소|to|payee[\s_-]?address|wallet[\s_-]?address)$/i,
  amount: /^(amount|금액|급여|salary|usdc|usdt|value|qty|quantity|payout|bonus)$/i,
  email: /^(email|메일|이메일|e[\s_-]?mail)$/i,
  metaAddress: /^(meta[\s_-]?address|stealth[\s_-]?meta|stealth[\s_-]?address|메타[\s_-]?주소)$/i,
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
  // Treat a row as a comment only when the first non-empty cell starts
  // with `#` AND no other cell carries content. This protects rows
  // whose name happens to start with `#` (e.g. `#1234,0x...,100`) —
  // those still have data in later cells and shouldn't be dropped.
  let firstNonEmptyStartsWithHash = false;
  let nonEmptyCount = 0;
  for (const cell of row) {
    const s = cellToString(cell);
    if (!s) continue;
    if (nonEmptyCount === 0) firstNonEmptyStartsWithHash = s.startsWith("#");
    nonEmptyCount++;
  }
  return firstNonEmptyStartsWithHash && nonEmptyCount === 1;
}

/** Strip an EIP-5564 chain prefix (`st:eth:`, `st:base:`, etc.) so
 *  validation and downstream stealth derivation see the same canonical
 *  hex. The prefix is purely a transport convention. */
function canonicalizeMetaAddress(s: string): string {
  return s.replace(/^st:[a-z]+:/i, "");
}

// EIP-5564 stealth meta-address: we accept either
//   - 33-byte compressed pubkey hex (0x + 66 chars) — common shape, single point
//   - 65-byte uncompressed / 0x + 130 chars — fallback for tools that emit
//     two concatenated points (spending + viewing) or a full uncompressed
//     point. generateStealthAddress accepts both.
// Either form may carry an `st:chain:` prefix.
function looksLikeMetaAddress(s: string): boolean {
  const stripped = canonicalizeMetaAddress(s);
  return /^0x[a-fA-F0-9]{66}$/.test(stripped) || /^0x[a-fA-F0-9]{130}$/.test(stripped);
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
    metaAddress: -1,
  };
  let dataStart = 0;

  if (!hasAddrInRow0 && namedCount >= 2) {
    cls.forEach((c, i) => {
      if (c && cols[c] < 0) cols[c] = i;
    });
    dataStart = 1;
  } else {
    // Positional fallback for header-less files: legacy 3-column shape
    // (name / address / amount). Optional email + metaAddress columns
    // are header-only — without a header we have no way to tell column
    // 4 from a stray data column.
    cols.name = 0;
    cols.address = 1;
    cols.amount = 2;
  }

  // address+amount required; meta_address can substitute for address
  // (stealth-only row → wizard derives the actual address from it).
  if (cols.address < 0 && cols.metaAddress < 0) {
    return {
      rows: [],
      warnings: ['Could not find an "address" or "meta_address" column. Add a header row.'],
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
  let skippedBadMeta = 0;
  let skippedBadEmail = 0;
  let skippedDup = 0;
  for (let i = dataStart; i < matrix.length; i++) {
    const row = matrix[i] ?? [];
    if (row.every((c) => cellToString(c) === "")) continue;
    const get = (col: number) => (col >= 0 ? cellToString(row[col]) : "");
    const address = get(cols.address);
    const metaAddressRaw = get(cols.metaAddress);
    if (!address && !metaAddressRaw) {
      skippedNoAddr++;
      continue;
    }
    if (address && !looksLikeAddress(address)) {
      skippedBadAddr++;
      continue;
    }
    if (metaAddressRaw && !looksLikeMetaAddress(metaAddressRaw)) {
      skippedBadMeta++;
      continue;
    }
    // Canonicalize so downstream `generateStealthAddress` sees the
    // stripped hex regardless of whether the file used an `st:chain:`
    // prefix or not.
    const metaAddress = metaAddressRaw ? canonicalizeMetaAddress(metaAddressRaw) : "";
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
    // Dedup key: prefer metaAddress when present so two rows pointing
    // at the same stealth recipient (same meta-address, different or
    // empty `address`) are caught. Falls back to address for plain
    // rows. The two key spaces don't collide in practice (40-hex vs
    // 66/130-hex), and using the canonical metaAddress prevents an
    // `st:chain:`-prefixed and unprefixed copy of the same key from
    // both being accepted.
    const dupKey = (metaAddress || address).toLowerCase();
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
      ...(metaAddress ? { metaAddress } : {}),
    });
  }
  if (skippedNoAddr > 0) warnings.push(`Skipped ${skippedNoAddr} row(s) with no address or meta_address.`);
  if (skippedBadAddr > 0) warnings.push(`Skipped ${skippedBadAddr} row(s) with malformed address.`);
  if (skippedBadMeta > 0) warnings.push(`Skipped ${skippedBadMeta} row(s) with malformed meta_address.`);
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
