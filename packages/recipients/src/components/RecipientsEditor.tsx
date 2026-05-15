"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { WalletEntry } from "@zkscatter/sdk/storage";
import { Button } from "@zkscatter/ui";
import {
  DEFAULT_COLUMNS,
  DEFAULT_MODES,
  type EditorMode,
  type ParsedRecipient,
  type RecipientField,
} from "../types";
import { formatRecipientCsvHeader, formatRecipientCsvRow } from "../format";
import { parseCsv, parseRecipientFile } from "../parseRecipientFile";
import { AddressBookPicker } from "./AddressBookPicker";
import { RowEditor } from "./RowEditor";
import { SpreadsheetEditor } from "./SpreadsheetEditor";

const UPLOAD_STATUS_STYLES: Record<"ok" | "warn" | "error", string> = {
  ok: "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-success)]",
  warn: "border-[var(--color-warning)] bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
  error: "border-[var(--color-danger)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
};

const MODE_LABEL: Record<EditorMode, string> = {
  rows: "Rows",
  csv: "CSV",
  spreadsheet: "Spreadsheet",
};

interface UploadStatus {
  kind: "ok" | "warn" | "error";
  message: string;
}

export interface RecipientsEditorProps {
  /** Controlled recipient list. The component never mutates this
   *  array; every change is reported via `onChange`. */
  value: readonly ParsedRecipient[];
  onChange(rows: ParsedRecipient[]): void;
  /** Which fields this app surfaces. Drives header row in CSV /
   *  Spreadsheet modes and which inputs appear in Rows mode.
   *  Order matters — it's the on-screen column order. */
  columns?: readonly RecipientField[];
  /** Which input modes to expose. Pay uses ["csv","spreadsheet"];
   *  Pro will start with ["rows","csv","spreadsheet"]. */
  modes?: readonly EditorMode[];
  /** Per-run cap. Surfaced in copy and used to disable "+ Add". */
  maxRows: number;
  /** Token symbol shown next to amount inputs (e.g. `USDC`). */
  amountSymbol?: string;
  /** Optional address-book entries. If omitted, the picker button
   *  is hidden — Pro and Pay both pass this when available. */
  addressBook?: readonly WalletEntry[];
  /** URL to a downloadable sample file. Hidden if absent. */
  sampleHref?: string;
  /** Per-row warnings rendered under each row (Rows mode only). */
  rowWarnings?: Record<number, string>;
  /** localStorage key for the active-mode preference. Must be
   *  unique per host app so Pay's choice doesn't leak into Pro. */
  storageKey: string;
  /** Disables every editor surface but keeps the data visible. */
  readOnly?: boolean;
  /** Slot above the editor for app-specific helper buttons
   *  (e.g. Pro's "Split equally", Pay's "Sample template"). */
  helperActions?: ReactNode;
}

export function RecipientsEditor({
  value,
  onChange,
  columns = DEFAULT_COLUMNS,
  modes = DEFAULT_MODES,
  maxRows,
  amountSymbol,
  addressBook,
  sampleHref,
  rowWarnings,
  storageKey,
  readOnly,
  helperActions,
}: RecipientsEditorProps) {
  // SSR + first-paint: always start from the first allowed mode;
  // the mount-only effect below promotes the stored preference once
  // hydration finishes. Splitting these keeps the rendered HTML
  // deterministic.
  const [mode, setMode] = useState<EditorMode>(() => modes[0]!);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus | null>(null);

  // Restore the user's last-picked mode once on mount. Guarded
  // against `modes` shrinking between sessions — fall back to the
  // default when the stored value is no longer valid. The effect
  // runs once because `modes` and `storageKey` are stable for a
  // given app context (callers pass literal-shaped configs).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      const isValidMode = (s: string): s is EditorMode =>
        (modes as readonly string[]).includes(s);
      if (stored && isValidMode(stored)) setMode(stored);
    } catch {
      // localStorage disabled / quota — silent fallback to default.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, mode);
    } catch {
      // ignored
    }
  }, [storageKey, mode]);

  // Stable React keys per row position. Managed inside the
  // handlers (splice in `removeRow`, push in `addRow`) so removing
  // row #3 doesn't shift the focus state on row #4 — that was the
  // bug the earlier "trim on length mismatch" approach didn't fix.
  // Render-time fallback below regenerates the key list when the
  // length changes through a path the editor didn't intermediate
  // (file upload, address-book pick, parent reset).
  const keyCounterRef = useRef(0);
  const rowKeysRef = useRef<number[]>([]);
  if (rowKeysRef.current.length !== value.length) {
    rowKeysRef.current = Array.from(
      { length: value.length },
      () => ++keyCounterRef.current,
    );
  }

  // ---- CSV view derived from `value` -----------------------------
  // Skip the serialize when the user is in Rows mode — keystrokes
  // create a fresh `value` identity per row edit, and at 128 rows
  // the format work isn't free. Re-derive on mode flip.
  //
  // The serialised form always carries the header row so the
  // round-trip through `parseCsv` maps every enabled column —
  // without a header the positional fallback only handles
  // name/address/amount, silently dropping email/releaseAt for
  // apps that opted in.
  const derivedCsv = useMemo(
    () =>
      mode === "rows"
        ? ""
        : [
            formatRecipientCsvHeader(columns),
            ...value.map((r) => formatRecipientCsvRow(r, columns)),
          ].join("\n"),
    [mode, value, columns],
  );

  const [csvDraft, setCsvDraft] = useState(derivedCsv);
  const lastDerivedRef = useRef(derivedCsv);
  const csvDraftRef = useRef(csvDraft);
  csvDraftRef.current = csvDraft;
  // When `value` changes externally (file upload, picker, helper
  // action), refresh the textarea draft — but only if the user
  // isn't mid-edit (draft already matches the previous derived).
  // Reading draft through a ref keeps it out of the dep array so
  // typing in the textarea doesn't trigger this effect.
  useEffect(() => {
    if (csvDraftRef.current === lastDerivedRef.current) {
      setCsvDraft(derivedCsv);
    }
    lastDerivedRef.current = derivedCsv;
  }, [derivedCsv]);

  const commitCsv = useCallback(
    (text: string) => {
      const result = parseCsv(text, columns);
      if (result.rows.length > maxRows) {
        setUploadStatus({
          kind: "error",
          message: `Too many rows (${result.rows.length}). Cap is ${maxRows}.`,
        });
        return;
      }
      onChange(result.rows);
      if (result.warnings.length > 0) {
        setUploadStatus({ kind: "warn", message: result.warnings.join(" ") });
      } else {
        setUploadStatus(null);
      }
    },
    [columns, maxRows, onChange],
  );

  // ---- Mutators (Rows mode) --------------------------------------
  const updateRow = useCallback(
    (index: number, patch: Partial<ParsedRecipient>) => {
      const next = value.map((r, i) => (i === index ? { ...r, ...patch } : r));
      onChange(next as ParsedRecipient[]);
    },
    [value, onChange],
  );
  const removeRow = useCallback(
    (index: number) => {
      const next = value.filter((_, i) => i !== index);
      // Splice the parallel key array at the same index so rows
      // after the removed one keep their original React key (and
      // their input focus state).
      if (next.length > 0) {
        rowKeysRef.current.splice(index, 1);
      }
      // Keep at least one editable blank row in Rows mode — that's
      // the contract the row UI assumes (no zero-row state). The
      // render-time regenerate handles the key for the synthetic
      // blank row since rowKeysRef ends up length 0 here.
      onChange(next.length === 0 ? [emptyRecipient()] : (next as ParsedRecipient[]));
    },
    [value, onChange],
  );
  const addRow = useCallback(() => {
    if (value.length >= maxRows) return;
    rowKeysRef.current.push(++keyCounterRef.current);
    onChange([...value, emptyRecipient()] as ParsedRecipient[]);
  }, [value, maxRows, onChange]);

  // ---- File upload -----------------------------------------------
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const onUpload = useCallback(
    async (file: File) => {
      setUploadStatus({ kind: "ok", message: `Parsing ${file.name}…` });
      try {
        const result = await parseRecipientFile(file, columns);
        if (result.rows.length === 0) {
          setUploadStatus({
            kind: "error",
            message: result.warnings.join(" ") || "No rows parsed.",
          });
          return;
        }
        if (result.rows.length > maxRows) {
          setUploadStatus({
            kind: "error",
            message: `File has ${result.rows.length} rows; cap is ${maxRows}.`,
          });
          return;
        }
        onChange(result.rows);
        setUploadStatus({
          kind: result.warnings.length > 0 ? "warn" : "ok",
          message:
            `Loaded ${result.rows.length} recipient${result.rows.length === 1 ? "" : "s"}.` +
            (result.warnings.length > 0 ? ` ${result.warnings.join(" ")}` : ""),
        });
      } catch (err) {
        setUploadStatus({
          kind: "error",
          message: `Upload failed: ${(err as Error).message}`,
        });
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [columns, maxRows, onChange],
  );

  // ---- Address book picker ---------------------------------------
  const onPickFromBook = useCallback(
    (picked: WalletEntry[]) => {
      if (picked.length === 0) {
        setPickerOpen(false);
        return;
      }
      // Replace the current list with one row per picked entry,
      // matching the "I picked 3, I now see 3 rows" wizard pattern.
      const next: ParsedRecipient[] = picked
        .slice(0, maxRows)
        .map((e) => ({
          name: e.label ?? "",
          address: e.address ?? "",
          amount: "",
          ...(e.email ? { email: e.email } : {}),
        }));
      onChange(next);
      setPickerOpen(false);
    },
    [maxRows, onChange],
  );

  // ---- Render -----------------------------------------------------
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Recipients ({value.length}/{maxRows})
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {helperActions}
          {!readOnly && modes.length > 1 && (
            <div
              role="tablist"
              aria-label="Recipient editor mode"
              className="inline-flex overflow-hidden rounded-md border border-[var(--color-border-strong)] text-[11px]"
            >
              {modes.map((m) => (
                <button
                  key={m}
                  role="tab"
                  aria-selected={mode === m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`px-2 py-1 ${
                    mode === m
                      ? "bg-[var(--color-primary)] text-white"
                      : "bg-white text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]"
                  }`}
                >
                  {MODE_LABEL[m]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Upload + sample + address book — always available regardless of mode. */}
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(f);
            }}
            aria-label="Upload recipients file"
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
          >
            ⬆ Upload CSV / Excel
          </Button>
          {sampleHref && (
            <a
              href={sampleHref}
              download
              className="text-[11px] text-[var(--color-primary)] hover:underline"
            >
              ↓ Sample file
            </a>
          )}
          {addressBook && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPickerOpen(true)}
              disabled={addressBook.length === 0}
              title={
                addressBook.length === 0
                  ? "Address book is empty"
                  : `Pick from ${addressBook.length} contact${addressBook.length === 1 ? "" : "s"}`
              }
            >
              📇 Pick from address book
            </Button>
          )}
        </div>
      )}

      {uploadStatus && (
        <div
          className={`rounded border px-2 py-1.5 text-[11px] ${UPLOAD_STATUS_STYLES[uploadStatus.kind]}`}
        >
          {uploadStatus.message}
        </div>
      )}

      {mode === "rows" && (
        <RowEditor
          rows={value}
          rowKeys={rowKeysRef.current}
          columns={columns}
          maxRows={maxRows}
          amountSymbol={amountSymbol}
          rowWarnings={rowWarnings}
          readOnly={readOnly}
          onUpdate={updateRow}
          onRemove={removeRow}
          onAdd={addRow}
        />
      )}

      {mode === "csv" && (
        <div className="space-y-1">
          <textarea
            value={csvDraft}
            disabled={readOnly}
            onChange={(e) => setCsvDraft(e.target.value)}
            onBlur={() => commitCsv(csvDraft)}
            placeholder="One row per line — comma-separated."
            rows={Math.min(12, Math.max(4, value.length + 2))}
            className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono text-xs disabled:opacity-60"
          />
          <p className="text-[10px] text-[var(--color-text-subtle)]">
            First line is the column header. Edits apply when you click
            outside the box.
          </p>
        </div>
      )}

      {mode === "spreadsheet" && (
        <SpreadsheetEditor
          csv={derivedCsv}
          columns={columns}
          readOnly={readOnly}
          onCsvChange={commitCsv}
        />
      )}

      {pickerOpen && addressBook && (
        <AddressBookPicker
          entries={addressBook as WalletEntry[]}
          onCancel={() => setPickerOpen(false)}
          onPick={onPickFromBook}
        />
      )}
    </div>
  );
}

function emptyRecipient(): ParsedRecipient {
  return { name: "", address: "", amount: "" };
}
