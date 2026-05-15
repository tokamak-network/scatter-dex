"use client";

import { useEffect, useMemo, useRef } from "react";
import Spreadsheet, { type Matrix } from "react-spreadsheet";
import type { ParsedRecipient, RecipientField } from "../types";
import { splitCsvLine } from "../csv";
import { formatRecipientCsvHeader, formatRecipientCsvRow } from "../format";

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

function parseCsvLines(csv: string): string[] {
  return csv
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Drop the header row when present so it doesn't render as a data
 *  row in the grid. The header is identified by exact match against
 *  the canonical header line for the current column set — any other
 *  shape (e.g. user-edited header) flows through as data, same as
 *  before. */
function stripHeaderLine(lines: string[], columns: readonly RecipientField[]): string[] {
  if (lines.length === 0) return lines;
  return lines[0] === formatRecipientCsvHeader(columns) ? lines.slice(1) : lines;
}

function parseCsvToMatrix(csv: string, columns: readonly RecipientField[]): Matrix<Cell> {
  const lines = stripHeaderLine(parseCsvLines(csv), columns);
  return lines.slice(0, MAX_VISIBLE_ROWS).map((line) => {
    // Real RFC 4180 quote-aware split — `"Doe, John",0x…,100` no
    // longer shifts columns. The grid pads/truncates to `columns`.
    const fields = splitCsvLine(line);
    return columns.map((_, i) => ({ value: fields[i] ?? "" }));
  });
}

function matrixToCsv(matrix: Matrix<Cell>, columns: readonly RecipientField[]): string {
  // Funnel every serialization through `formatRecipientCsvRow` so
  // CSV-escaping (quoted fields, formula-injection guard) stays in
  // one place. The grid hands us strings per column already — just
  // shape a per-row partial.
  return matrix
    .map((row) => row?.map((cell) => cell?.value ?? "") ?? [])
    .filter((cells) => cells.some((c) => c && c.trim().length > 0))
    .map((cells) => {
      const partial: Partial<ParsedRecipient> = {};
      columns.forEach((col, i) => {
        partial[col] = (cells[i] ?? "").trim();
      });
      return formatRecipientCsvRow(partial, columns);
    })
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
