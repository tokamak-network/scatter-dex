"use client";

import { useEffect, useMemo, useRef } from "react";
import Spreadsheet, { type Matrix } from "react-spreadsheet";
import type { RecipientField } from "../types";
import { csvSafeLabel } from "../csv";

type Cell = { value: string };

const COLUMN_LABEL: Record<RecipientField, string> = {
  name: "Name",
  address: "Address",
  amount: "Amount",
  email: "Email",
  releaseAt: "Release At",
};

// One blank row at the bottom is always kept so the user can grow the
// list without a separate "+ Add row" button. When they fill it, the
// onChange path appends another blank.
const TRAILING_BLANK_ROWS = 1;

// react-spreadsheet has no built-in row-count control; we hand it the
// matrix and the rendered grid matches its dimensions. Cap so a
// pathological textarea (10k lines) doesn't try to render 10k rows
// before the host app's per-run cap rejects it elsewhere.
const MAX_VISIBLE_ROWS = 200;

function splitCsvLineRespectingQuotes(line: string, columnCount: number): string[] {
  // Take the last (columnCount-1) comma-separated fields as the tail
  // columns and everything before them as the leading free-text
  // field. Defensive: csvSafeLabel upstream strips commas from names,
  // but a user who hand-edits the textarea could still slip one in
  // (e.g. "Doe, John") — keeping the splitter robust avoids silently
  // shifting their columns into the wrong cells.
  const parts = line.split(",");
  if (parts.length <= columnCount) {
    const padded = parts.concat(Array(columnCount - parts.length).fill(""));
    return padded.map((p) => p.trim());
  }
  const tail: string[] = [];
  for (let i = 0; i < columnCount - 1; i++) {
    tail.unshift((parts.pop() ?? "").trim());
  }
  const head = parts.join(",").trim();
  return [head, ...tail];
}

function parseCsvLines(csv: string): string[] {
  return csv
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function parseCsvToMatrix(csv: string, columns: readonly RecipientField[]): Matrix<Cell> {
  const lines = parseCsvLines(csv);
  return lines.slice(0, MAX_VISIBLE_ROWS).map((line) => {
    const fields = splitCsvLineRespectingQuotes(line, columns.length);
    return columns.map((_, i) => ({ value: fields[i] ?? "" }));
  });
}

function matrixToCsv(matrix: Matrix<Cell>, columns: readonly RecipientField[]): string {
  // Drop fully-empty rows when serializing so trailing blanks don't
  // leak into the textarea (and downstream parser).
  return matrix
    .map((row) => row?.map((cell) => cell?.value ?? "") ?? [])
    .filter((cells) => cells.some((c) => c && c.trim().length > 0))
    .map((cells) =>
      columns
        .map((col, i) => {
          const raw = (cells[i] ?? "").trim();
          // Same sanitization as the row-mode → CSV path so a label
          // typed in the grid round-trips through the textarea
          // without splitting into the wrong column.
          return col === "name" ? csvSafeLabel(raw) : raw;
        })
        .join(","),
    )
    .join("\n");
}

function ensureTrailingBlanks(
  matrix: Matrix<Cell>,
  columns: readonly RecipientField[],
): Matrix<Cell> {
  const isEmpty = (row: Matrix<Cell>[number]) =>
    !row || row.every((c) => !c?.value || c.value.trim() === "");
  let trailing = 0;
  for (let i = matrix.length - 1; i >= 0 && isEmpty(matrix[i]); i--) trailing++;
  if (trailing >= TRAILING_BLANK_ROWS) return matrix;
  const blanks: Matrix<Cell> = Array.from(
    { length: TRAILING_BLANK_ROWS - trailing },
    () => columns.map(() => ({ value: "" })),
  );
  return [...matrix, ...blanks];
}

interface Props {
  csv: string;
  onCsvChange: (next: string) => void;
  columns: readonly RecipientField[];
  readOnly?: boolean;
}

/** Cell-grid editor that shares its data with the textarea via the
 *  `csv` state. The grid is a view onto that string — every change
 *  re-serializes the matrix back into CSV so the textarea, the
 *  derived `rows`, and any downstream parser all see the same
 *  recipient list regardless of which mode the user happens to be
 *  in.
 *
 *  Columns are driven by the host app's `columns` prop, so Pay
 *  (4 cols) and Pro (5 cols) can share this code unchanged. */
export function SpreadsheetEditor({ csv, onCsvChange, columns, readOnly }: Props) {
  const columnLabels = useMemo(() => columns.map((c) => COLUMN_LABEL[c]), [columns]);

  // Re-derive the matrix on every csv change so an external write
  // (upload, address-book picker) refreshes the grid immediately.
  // The trailing blank padding gives the user a visible empty row
  // they can click into to grow the list.
  //
  // Both `allLines` and `data` need the line split — share it. And
  // cache the (csv, matrix) pair so when our own emitted csv comes
  // back as a fresh prop, we skip the reparse and reuse the matrix
  // react-spreadsheet just handed us.
  const lastMatrixRef = useRef<{ csv: string; matrix: Matrix<Cell> } | null>(null);
  const allLines = useMemo(() => parseCsvLines(csv), [csv]);
  const overflowLines = allLines.slice(MAX_VISIBLE_ROWS);
  const data = useMemo(() => {
    if (lastMatrixRef.current?.csv === csv) {
      return ensureTrailingBlanks(lastMatrixRef.current.matrix, columns);
    }
    return ensureTrailingBlanks(parseCsvToMatrix(csv, columns), columns);
  }, [csv, columns]);

  // Suppress the onChange feedback loop: when our own setData edit
  // triggers a re-derived matrix, react-spreadsheet would normally
  // call onChange right back. Track the last-emitted serialization
  // to skip echo updates that match the existing csv.
  const lastEmittedRef = useRef<string | null>(null);

  useEffect(() => {
    lastEmittedRef.current = csv;
  }, [csv]);

  if (readOnly) {
    return (
      <div className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
        Spreadsheet editing is disabled while this run is read-only.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-[var(--color-border-strong)] bg-white p-2">
      {overflowLines.length > 0 && (
        <div className="mb-2 rounded border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-2 py-1 text-[11px] text-[var(--color-warning)]">
          Showing first {MAX_VISIBLE_ROWS} of {allLines.length} rows. The rest stay
          attached to your list — switch to CSV mode to edit them.
        </div>
      )}
      <Spreadsheet
        data={data}
        columnLabels={columnLabels}
        onChange={(next) => {
          const nextMatrix = next as Matrix<Cell>;
          const serialized = matrixToCsv(nextMatrix, columns);
          // Stitch the hidden tail back onto every emitted CSV so an
          // edit to row 5 doesn't drop rows MAX_VISIBLE_ROWS+1+.
          const combined = overflowLines.length > 0
            ? [serialized, ...overflowLines].filter(Boolean).join("\n")
            : serialized;
          if (combined === lastEmittedRef.current) return;
          lastEmittedRef.current = combined;
          // Stash the matrix so when `combined` flows back in as a
          // prop on the next render we don't reparse it.
          lastMatrixRef.current = { csv: combined, matrix: nextMatrix };
          onCsvChange(combined);
        }}
      />
    </div>
  );
}
