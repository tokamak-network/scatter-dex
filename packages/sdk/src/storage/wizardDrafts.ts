/**
 * Wizard draft persistence — same File System Access API folder that
 * holds run records, wallet book, stealth inbox. Storing drafts in the
 * folder (instead of localStorage) means they follow the operator's
 * workspace across machines and survive private-mode browsing.
 *
 * Identified by **label** — one draft per (operator, label) pair.
 * Re-typing the same label updates the same record; editing the
 * label moves the draft to the new slot and removes the old one
 * (callers pass the previous label so the rename stays atomic).
 */

import { loadFile, saveFile, removeFile } from "./folder";

export const WIZARD_DRAFTS_FILENAME = "zkscatter-drafts.json";

const SCHEMA_VERSION = 1;

export interface WizardDraft {
  /** Schema version. Mismatches read as null so a downgrade can't
   *  surface stale fields the new code doesn't understand. */
  version: number;
  /** Unix seconds the draft was last touched. */
  savedAt: number;
  /** Lowercased operator address (or `anonymous` when no wallet is
   *  connected). Two operators on one workspace can each have a
   *  draft titled "May payroll" without colliding. */
  operatorAddress: string;
  /** Display label — also the slot key together with `operatorAddress`.
   *  Empty labels are stored under the literal `"(untitled)"` slot
   *  so a half-typed label still produces a saveable draft. */
  label: string;
  step: number;
  templateId: string;
  token: string;
  csv: string;
  reason: string;
  claimFrom?: string;
  maxFeeBps: number;
}

interface DraftsFile {
  version: 1;
  drafts: WizardDraft[];
}

function normaliseLabel(label: string): string {
  return label.trim() || "(untitled)";
}

function normaliseOperator(addr: string | null | undefined): string {
  return (addr ?? "anonymous").toLowerCase();
}

async function readFile(): Promise<DraftsFile> {
  const raw = await loadFile(WIZARD_DRAFTS_FILENAME);
  if (!raw) return { version: 1, drafts: [] };
  try {
    const parsed = JSON.parse(raw) as DraftsFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.drafts)) {
      return { version: 1, drafts: [] };
    }
    return parsed;
  } catch {
    return { version: 1, drafts: [] };
  }
}

async function writeDrafts(drafts: WizardDraft[]): Promise<void> {
  if (drafts.length === 0) {
    await removeFile(WIZARD_DRAFTS_FILENAME);
    return;
  }
  const file: DraftsFile = { version: 1, drafts };
  await saveFile(WIZARD_DRAFTS_FILENAME, JSON.stringify(file));
}

function matchSlot(d: WizardDraft, operator: string, label: string): boolean {
  return (
    d.operatorAddress === operator && normaliseLabel(d.label) === normaliseLabel(label)
  );
}

/** Look up a draft by (operator, label). Returns null when the slot
 *  is empty or the version doesn't match. */
export async function loadWizardDraft(
  operatorAddress: string | null | undefined,
  label: string,
): Promise<WizardDraft | null> {
  const file = await readFile();
  const op = normaliseOperator(operatorAddress);
  const found = file.drafts.find((d) => matchSlot(d, op, label));
  if (!found || found.version !== SCHEMA_VERSION) return null;
  return found;
}

/** All drafts on disk, optionally filtered to a single operator.
 *  Sorted by `savedAt` descending so the most recently edited surfaces
 *  first on the dashboard. */
export async function loadAllWizardDrafts(
  operatorAddress?: string | null,
): Promise<WizardDraft[]> {
  const file = await readFile();
  const wanted = operatorAddress ? operatorAddress.toLowerCase() : null;
  return file.drafts
    .filter((d) => d.version === SCHEMA_VERSION)
    .filter((d) => (wanted ? d.operatorAddress === wanted : true))
    .sort((a, b) => b.savedAt - a.savedAt);
}

/** Upsert a draft. When `previousLabel` differs from the new label,
 *  the old slot is removed in the same write so a rename doesn't
 *  produce a duplicate. */
export async function saveWizardDraft(
  operatorAddress: string | null | undefined,
  previousLabel: string | null,
  draft: Omit<WizardDraft, "version" | "savedAt" | "operatorAddress">,
): Promise<WizardDraft> {
  const file = await readFile();
  const op = normaliseOperator(operatorAddress);
  // Drop the old slot first when renaming so we don't end up with
  // two records sharing the same workspace.
  let next = file.drafts;
  if (previousLabel !== null && normaliseLabel(previousLabel) !== normaliseLabel(draft.label)) {
    next = next.filter((d) => !matchSlot(d, op, previousLabel));
  }
  // Drop any stale entry on the destination slot, then append the
  // fresh record so callers always get a single source of truth.
  next = next.filter((d) => !matchSlot(d, op, draft.label));
  const saved: WizardDraft = {
    ...draft,
    version: SCHEMA_VERSION,
    savedAt: Math.floor(Date.now() / 1000),
    operatorAddress: op,
  };
  next.push(saved);
  await writeDrafts(next);
  return saved;
}

/** Remove a draft by (operator, label). No-op when the slot is empty. */
export async function clearWizardDraft(
  operatorAddress: string | null | undefined,
  label: string,
): Promise<void> {
  const file = await readFile();
  const op = normaliseOperator(operatorAddress);
  const next = file.drafts.filter((d) => !matchSlot(d, op, label));
  if (next.length === file.drafts.length) return;
  await writeDrafts(next);
}
