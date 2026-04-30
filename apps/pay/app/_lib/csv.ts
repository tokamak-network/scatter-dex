"use client";

/** RFC 4180 cell escape. Excel / Numbers / Sheets all parse the
 *  doubled-quote escape. */
export function csvEscape(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return "";
  const s = String(value);
  if (s === "") return "";
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
