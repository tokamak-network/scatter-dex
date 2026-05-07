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

function splitNameAddressAmount(line: string): [string, string, string] {
  // Take the last two comma-separated fields as address + amount and
  // everything before them as the name. Defensive: csvSafeLabel
  // upstream strips commas from names, but a user who hand-edits the
  // textarea could still slip one in (e.g. "Doe, John") — keeping
  // the splitter robust avoids silently shifting their columns into
  // the wrong cells.
  const parts = line.split(",");
  if (parts.length < 3) {
    return [parts[0]?.trim() ?? "", parts[1]?.trim() ?? "", parts[2]?.trim() ?? ""];
  }
  const amount = parts.pop()!.trim();
  const address = parts.pop()!.trim();
  const name = parts.join(",").trim();
  return [name, address, amount];
}

function parseCsvLines(csv: string): string[] {
  return csv
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function parseCsvToMatrix(csv: string): Matrix<Cell> {
  const lines = parseCsvLines(csv);
  return lines.slice(0, MAX_VISIBLE_ROWS).map((line) => {
    const [name, address, amount] = splitNameAddressAmount(line);
    return [{ value: name }, { value: address }, { value: amount }];
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
  // Stash the lines past the row cap so we can stitch them back onto
  // the serialized output — without this, a user editing a single
  // cell when the list has 250 recipients would silently delete the
  // last 50. The grid still only renders the first 200, but the
  // hidden tail survives every roundtrip.
  const allLines = useMemo(() => parseCsvLines(csv), [csv]);
  const overflowLines = allLines.slice(MAX_VISIBLE_ROWS);

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
      {overflowLines.length > 0 && (
        <div className="mb-2 rounded border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-2 py-1 text-[11px] text-[var(--color-warning)]">
          Showing first {MAX_VISIBLE_ROWS} of {allLines.length} rows. The rest stay
          attached to your list — switch to CSV mode to edit them.
        </div>
      )}
      <Spreadsheet
        data={data}
        columnLabels={COLUMN_LABELS}
        onChange={(next) => {
          const serialized = matrixToCsv(next as Matrix<Cell>);
          // Stitch the hidden tail back onto every emitted CSV so an
          // edit to row 5 doesn't drop rows 201+.
          const combined = overflowLines.length > 0
            ? [serialized, ...overflowLines].filter(Boolean).join("\n")
            : serialized;
          if (combined === lastEmittedRef.current) return;
          lastEmittedRef.current = combined;
          onCsvChange(combined);
        }}
      />
    </div>
  );
}
