"use client";

import { useEffect, useMemo, useRef } from "react";
import Spreadsheet, { type Matrix } from "react-spreadsheet";
import { formatRecipientCsvRow } from "../../../_lib/format";

type Cell = { value: string };

const COLUMN_LABELS = ["Name", "Address", "Amount"];
// One blank row at the bottom is always kept so the user can grow the
// list without a separate "+ Add row" button. When they fill it, the
// onChange path appends another blank.
const TRAILING_BLANK_ROWS = 1;
// react-spreadsheet has no built-in row-count control; we hand it the
// matrix and the rendered grid matches its dimensions. Cap so a
// pathological textarea (10k lines) doesn't try to render 10k rows
// before the wizard's per-run cap rejects it elsewhere.
const MAX_VISIBLE_ROWS = 200;

function parseCsvToMatrix(csv: string): Matrix<Cell> {
  // Mirror the wizard's existing 3-column derivation (page.tsx ~line
  // 800): trim, drop empties, split on first two commas only so a
  // name with a comma doesn't shift the columns. The spreadsheet is a
  // visual editor for the textarea, not a re-parser, so it should see
  // exactly what the textarea shows.
  const lines = csv
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(0, MAX_VISIBLE_ROWS).map((line) => {
    const parts = line.split(",").map((s) => s.trim());
    return [
      { value: parts[0] ?? "" },
      { value: parts[1] ?? "" },
      { value: parts[2] ?? "" },
    ];
  });
}

function matrixToCsv(matrix: Matrix<Cell>): string {
  // Drop fully-empty rows when serializing so trailing blanks don't
  // leak into the textarea (and downstream `rows` parser).
  const lines = matrix
    .map((row) => row?.map((cell) => cell?.value ?? "") ?? [])
    .filter((cells) => cells.some((c) => c && c.trim().length > 0))
    .map(([name, address, amount]) =>
      formatRecipientCsvRow(name ?? "", (address ?? "").trim(), (amount ?? "").trim()),
    );
  return lines.join("\n");
}

function ensureTrailingBlanks(matrix: Matrix<Cell>): Matrix<Cell> {
  const isEmpty = (row: Matrix<Cell>[number]) =>
    !row || row.every((c) => !c?.value || c.value.trim() === "");
  let trailing = 0;
  for (let i = matrix.length - 1; i >= 0 && isEmpty(matrix[i]); i--) trailing++;
  if (trailing >= TRAILING_BLANK_ROWS) return matrix;
  const blanks: Matrix<Cell> = Array.from(
    { length: TRAILING_BLANK_ROWS - trailing },
    () => COLUMN_LABELS.map(() => ({ value: "" })),
  );
  return [...matrix, ...blanks];
}

interface Props {
  csv: string;
  onCsvChange: (next: string) => void;
  readOnly?: boolean;
}

/** Cell-grid editor for the Recipients step that shares its data with
 *  the textarea via the `csv` state. The grid is a view onto that
 *  string — every change re-serializes the matrix back into CSV so
 *  the textarea, rows-derivation, splitPayout, and the upload status
 *  banner all see the same recipient list regardless of which mode
 *  the user happens to be in. */
export function SpreadsheetEditor({ csv, onCsvChange, readOnly }: Props) {
  // Re-derive the matrix on every csv change so an external write
  // (upload, address-book picker) refreshes the grid immediately.
  // The trailing blank padding gives the user a visible empty row
  // they can click into to grow the list.
  const data = useMemo(
    () => ensureTrailingBlanks(parseCsvToMatrix(csv)),
    [csv],
  );

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
        Spreadsheet editing is disabled while resuming an existing run.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-[var(--color-border-strong)] bg-white p-2">
      <Spreadsheet
        data={data}
        columnLabels={COLUMN_LABELS}
        onChange={(next) => {
          const serialized = matrixToCsv(next as Matrix<Cell>);
          if (serialized === lastEmittedRef.current) return;
          lastEmittedRef.current = serialized;
          onCsvChange(serialized);
        }}
      />
    </div>
  );
}
