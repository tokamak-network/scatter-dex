#!/usr/bin/env node
/**
 *  Generates the recipient-list sample files served from
 *  `apps/pay/public/samples/` so HR teams have a known-good template
 *  to download, fill in, and re-upload. Run on demand:
 *    node scripts/generate-recipient-samples.mjs
 *
 *  The CSV ships with `#` comment rows at the top explaining the
 *  amount unit and the optional `meta_address` column. The parser
 *  treats a row as a comment only when the first non-empty cell
 *  starts with `#` AND no other cell carries content, so legitimate
 *  data rows whose name happens to start with `#` survive.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import writeXlsxFile from "write-excel-file/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "public", "samples");
mkdirSync(outDir, { recursive: true });

/** RFC-4180 minimal CSV cell escaper: wraps in quotes and doubles any
 *  embedded quote when the cell contains `,`, `"`, `\r`, or `\n`. */
function csvCell(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const commentLines = [
  "# THIS IS A TEMPLATE — replace every value below before uploading.",
  "# Addresses are 0x000…000 placeholders. Submitting them as-is would BURN funds.",
  "#",
  "# Row 1: regular EOA payout — replace `address`, `amount`, `email`, and `name`.",
  "# Row 2: stealth payout — leave `address` blank, replace `meta_address` with the",
  "# recipient's EIP-5564 key (format: `st:eth:0x` + 132 hex chars). The system",
  "# derives a one-time stealth address per recipient automatically.",
  "#",
  "# Amount is in the token you pick in the wizard (USDC / USDT / ETH / TON).",
];
const headers = ["name", "address", "amount", "email", "meta_address"];
// One concrete example per mode (plain + stealth) so the column shape
// is obvious. Addresses are intentionally the zero address — clearly
// not a real recipient, the wizard's review screen will flag it, and
// a hurried operator who forgot to replace gets a "burn address"
// signal rather than ship to real-looking Hardhat test addresses by
// mistake. The stealth row's meta_address uses a fixed
// deterministic key pair so the sample diff stays stable; the
// matching private keys are unknown so any payout to it is
// unrecoverable — that's fine for a template.
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const SAMPLE_META_ADDRESS =
  "st:eth:0x03ebf948270e460d6dde0385f6fbc7d303d7fa6cbb9ce8a76ad23edbcd3e28c37d02afe23955ae8a9f4ef7d09a27c88f3ee7a45661d44ab526ed3d1832f35a2c95cb";
const rows = [
  ["Alice (sample — replace)", ZERO_ADDRESS, 100, "alice@example.com", ""],
  ["Bob Stealth (sample — replace)", "", 100, "bob@example.com", SAMPLE_META_ADDRESS],
];

const csvPath = join(outDir, "recipients-sample.csv");
writeFileSync(
  csvPath,
  [
    // Quote each comment line: most contain commas inside the prose,
    // so without escaping the parser would split them into multiple
    // data cells and then mis-classify them as malformed data rows.
    ...commentLines.map(csvCell),
    headers.map(csvCell).join(","),
    ...rows.map((r) => r.map(csvCell).join(",")),
  ].join("\n") + "\n",
  "utf8",
);

const xlsxPath = join(outDir, "recipients-sample.xlsx");
const sheetData = [
  // Comment rows the parser ignores; surfacing the unit + stealth hint
  // inside the file means a user who downloads, fills in, and re-uploads
  // can't miss them.
  ...commentLines.map((text) => [
    {
      value: text,
      type: String,
      fontStyle: "italic",
      color: "#888888",
      span: 5,
    },
  ]),
  headers.map((value) => ({ value, type: String, fontWeight: "bold" })),
  ...rows.map(([name, address, amount, email, metaAddress]) => [
    { value: name, type: String },
    { value: address, type: String },
    typeof amount === "number"
      ? { value: amount, type: Number, format: "0.00" }
      : { value: String(amount), type: String },
    { value: email, type: String },
    { value: metaAddress, type: String },
  ]),
];
await writeXlsxFile(sheetData, {
  sheet: "Recipients",
  columns: [{ width: 30 }, { width: 46 }, { width: 12 }, { width: 28 }, { width: 70 }],
}).toFile(xlsxPath);

console.log("Wrote:");
console.log("  ", csvPath);
console.log("  ", xlsxPath);
