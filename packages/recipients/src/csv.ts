"use client";

/** RFC 4180 cell escape. Excel / Numbers / Sheets all parse the
 *  doubled-quote escape. Also neutralizes leading spreadsheet formula
 *  markers (`=`, `+`, `-`, `@`) by prefixing a single quote — without
 *  this, an attacker-controlled recipient name like `=HYPERLINK(...)`
 *  would execute as a formula when the operator opens the CSV in
 *  Excel / Sheets. */
export function csvEscape(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return "";
  let s = String(value);
  if (s === "") return "";
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Trigger a browser download for the given CSV body. Prepends a
 *  UTF-8 BOM so Excel on Windows reads non-ASCII labels (e.g. Korean
 *  recipient names) as Unicode instead of cp1252. The revoke is
 *  deferred a tick so Safari has time to start the download. */
export function downloadCsv(body: string, filename: string): void {
  const blob = new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Strip commas/newlines from a free-text label so it round-trips
 *  through the textarea/CSV path without quoting. The full quoted
 *  serializer (`csvEscape`) handles user-supplied edge cases, but
 *  the live grid → textarea bridge stays predictable when names
 *  are already sanitized. */
export function csvSafeLabel(label: string): string {
  return (label || "").replace(/[,\n\r]/g, " ").trim();
}

/** Quote-aware single-line CSV splitter. Handles `"Doe, John"`,
 *  embedded escaped quotes (`""`), and bare commas. The full
 *  `parseCsv` in `parseRecipientFile.ts` does the same with row
 *  semantics; this is the per-line variant the grid editor uses
 *  to map a row of CSV into its cell columns without dragging in
 *  the validator/dedup machinery. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQ = false; }
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '"' && cur === "") {
      inQ = true;
    } else if (c === ",") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur.trim());
  return out;
}
