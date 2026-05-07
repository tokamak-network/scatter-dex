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
  "# Amount is in the token you pick in the wizard (USDC / USDT / ETH / TON).",
  "# Optional 5th column `meta_address` — when filled, the system derives a",
  "# one-time stealth address per recipient automatically (privacy mode).",
  "# Leave it blank for a regular EOA payout. The example row below shows",
  "# the stealth case: address column empty, meta_address filled. REPLACE",
  "# the placeholder meta_address with the recipient's actual EIP-5564 key.",
];
const headers = ["name", "address", "amount", "email", "meta_address"];
// Rows: 3 plain EOA + 1 stealth example. The stealth row leaves
// `address` blank and fills `meta_address` with a clearly-placeholder
// 33-byte compressed pubkey hex so the user sees "ah, this is what
// stealth mode looks like" and replaces it with a real key.
const rows = [
  ["Alice Kim", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", 3500, "alice@example.com", ""],
  ["Bob Lee", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", 3500, "bob@example.com", ""],
  ["Carol Park", "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", 4200, "carol@example.com", ""],
  [
    "Dave Stealth (replace meta_address)",
    "",
    5000,
    "dave@example.com",
    "0x02deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  ],
];

const csvPath = join(outDir, "recipients-sample.csv");
writeFileSync(
  csvPath,
  [
    ...commentLines,
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
    { value: amount, type: Number, format: "0.00" },
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
