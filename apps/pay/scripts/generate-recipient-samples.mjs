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
  "# THIS IS A TEMPLATE — replace every <input ...> placeholder below before uploading.",
  "# All addresses are intentionally invalid so an as-is upload errors out instead of",
  "# accidentally paying fictional accounts.",
  "#",
  "# Amount is in the token you pick in the wizard (USDC / USDT / ETH / TON).",
  "# Optional 5th column `meta_address` — when filled, the system derives a one-time",
  "# stealth address per recipient automatically (privacy mode). Leave blank for a",
  "# regular EOA payout. Format: `st:eth:0x` + 132 hex chars.",
];
const headers = ["name", "address", "amount", "email", "meta_address"];
// All values below are placeholders — addresses don't pass EIP-55
// checksum, meta_address is a fixed sentinel string. The parser will
// skip every row with a "malformed" warning, which is the intended
// behaviour: the user MUST edit the file before it will accept any
// recipient. Better than shipping real-looking Hardhat test
// addresses, which a hurried operator might leave in by mistake.
const PLACEHOLDER_ADDRESS = "<input recipient address>";
const PLACEHOLDER_AMOUNT = "<input amount>";
const PLACEHOLDER_EMAIL = "<input email>";
const PLACEHOLDER_META = "<input st:eth:0x... meta_address (or leave blank)>";
const rows = [
  ["<input recipient name>", PLACEHOLDER_ADDRESS, PLACEHOLDER_AMOUNT, PLACEHOLDER_EMAIL, ""],
  ["<input recipient name>", PLACEHOLDER_ADDRESS, PLACEHOLDER_AMOUNT, PLACEHOLDER_EMAIL, ""],
  ["<input recipient name>", PLACEHOLDER_ADDRESS, PLACEHOLDER_AMOUNT, PLACEHOLDER_EMAIL, ""],
  [
    "<input stealth recipient name>",
    "",
    PLACEHOLDER_AMOUNT,
    PLACEHOLDER_EMAIL,
    PLACEHOLDER_META,
  ],
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
