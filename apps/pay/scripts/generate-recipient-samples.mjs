#!/usr/bin/env node
/**
 *  Generates the recipient-list sample files served from
 *  `apps/pay/public/samples/` so HR teams have a known-good template
 *  to download, fill in, and re-upload. Run on demand:
 *    node scripts/generate-recipient-samples.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import writeXlsxFile from "write-excel-file/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "public", "samples");
mkdirSync(outDir, { recursive: true });

const headers = ["name", "address", "amount"];
const rows = [
  ["Alice Kim", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", 3500],
  ["Bob Lee", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", 3500],
  ["Carol Park", "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", 4200],
];

const csvPath = join(outDir, "recipients-sample.csv");
writeFileSync(
  csvPath,
  [headers.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n",
  "utf8",
);

const xlsxPath = join(outDir, "recipients-sample.xlsx");
const sheetData = [
  headers.map((value) => ({ value, type: String, fontWeight: "bold" })),
  ...rows.map(([name, address, amount]) => [
    { value: name, type: String },
    { value: address, type: String },
    { value: amount, type: Number, format: "0.00" },
  ]),
];
await writeXlsxFile(sheetData, {
  sheet: "Recipients",
  columns: [{ width: 20 }, { width: 48 }, { width: 12 }],
}).toFile(xlsxPath);

console.log("Wrote:");
console.log("  ", csvPath);
console.log("  ", xlsxPath);
