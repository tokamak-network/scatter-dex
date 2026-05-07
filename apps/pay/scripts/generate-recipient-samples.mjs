#!/usr/bin/env node
/**
 *  Generates the recipient-list sample files served from
 *  `apps/pay/public/samples/` so HR teams have a known-good template
 *  to download, fill in, and re-upload. Run on demand:
 *    node scripts/generate-recipient-samples.mjs
 *
 *  The CSV ships with `#` comment rows at the top explaining the
 *  amount unit and the optional `meta_address` column. The parser
 *  skips lines starting with `#` so the comments don't pollute the
 *  parsed recipient list.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import writeXlsxFile from "write-excel-file/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "public", "samples");
mkdirSync(outDir, { recursive: true });

const commentLines = [
  "# Amount is in the token you pick in the wizard (USDC / USDT / ETH / TON).",
  "# Optional 5th column `meta_address` — if filled, the system creates a one-time",
  "# stealth address per recipient automatically. Leave blank for a regular EOA payout.",
];
const headers = ["name", "address", "amount", "email"];
const rows = [
  ["Alice Kim", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", 3500, "alice@example.com"],
  ["Bob Lee", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", 3500, "bob@example.com"],
  ["Carol Park", "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", 4200, "carol@example.com"],
];

const csvPath = join(outDir, "recipients-sample.csv");
writeFileSync(
  csvPath,
  [
    ...commentLines,
    headers.join(","),
    ...rows.map((r) => r.join(",")),
  ].join("\n") + "\n",
  "utf8",
);

const xlsxPath = join(outDir, "recipients-sample.xlsx");
const sheetData = [
  // Comment rows that the parser ignores; surfacing the unit + optional
  // column hint inside the file means a user who downloads, fills in,
  // and re-uploads can't miss them.
  ...commentLines.map((text) => [
    {
      value: text,
      type: String,
      fontStyle: "italic",
      color: "#888888",
      span: 4,
    },
  ]),
  headers.map((value) => ({ value, type: String, fontWeight: "bold" })),
  ...rows.map(([name, address, amount, email]) => [
    { value: name, type: String },
    { value: address, type: String },
    { value: amount, type: Number, format: "0.00" },
    { value: email, type: String },
  ]),
];
await writeXlsxFile(sheetData, {
  sheet: "Recipients",
  columns: [{ width: 18 }, { width: 46 }, { width: 12 }, { width: 28 }],
}).toFile(xlsxPath);

console.log("Wrote:");
console.log("  ", csvPath);
console.log("  ", xlsxPath);
