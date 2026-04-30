/** Wizard-step-1 template catalog. Each entry pre-fills the
 *  follow-on steps (label, token, sample CSV) and the export-step
 *  hint. The `id` set is a strict subset of `RunCategory` so the
 *  built RunRecord can carry the chosen template forward into the
 *  dashboard tabs without an extra mapping table. `reasonLabel` is
 *  optional — payroll runs don't ask for a reason. */
export type TemplateId = "payroll" | "grants" | "bonus" | "contractor";

export interface Template {
  id: TemplateId;
  name: string;
  tagline: string;
  body: string;
  defaultLabel: string;
  defaultToken: string;
  identifierLabel: string;
  reasonLabel?: string;
  sampleCsv: string;
  exportNote: string;
}

export const TEMPLATES: readonly Template[] = [
  {
    id: "payroll",
    name: "Payroll",
    tagline: "Monthly salaries",
    body: "Monthly salary run for employees. Withholding-friendly export.",
    defaultLabel: "April payroll",
    defaultToken: "USDC",
    identifierLabel: "Employee",
    sampleCsv: "",
    exportNote: "Payroll export includes per-employee breakdown for withholding reconciliation.",
  },
  {
    id: "grants",
    name: "Grants",
    tagline: "DAO grants",
    body: "Pay grant recipients from a Snapshot result or working group.",
    defaultLabel: "Q2 grants — public goods WG",
    defaultToken: "USDC",
    identifierLabel: "Recipient",
    reasonLabel: "Proposal / Snapshot link",
    sampleCsv: "",
    exportNote: "Grants export pairs each transfer with its proposal link for transparency reports.",
  },
  {
    id: "bonus",
    name: "Bonus",
    tagline: "Bonuses & incentives",
    body: "One-off bonus rounds where size differences should stay private.",
    defaultLabel: "EOY bonus 2026",
    defaultToken: "USDC",
    identifierLabel: "Employee",
    reasonLabel: "Reason / approver",
    sampleCsv: "",
    exportNote: "Bonus export records the approver and reason against each line.",
  },
  {
    id: "contractor",
    name: "Contractor batch",
    tagline: "Freelancer settlement",
    body: "Settle a wave of contractors at once without leaking per-contractor rates.",
    defaultLabel: "April contractor settlement",
    defaultToken: "USDC",
    identifierLabel: "Contractor",
    reasonLabel: "Invoice reference",
    sampleCsv: "",
    exportNote: "Contractor export attaches invoice references for sole-proprietor accounting.",
  },
];

export const REASON_PLACEHOLDER: Record<TemplateId, string> = {
  payroll: "",
  grants: "https://snapshot.org/#/acme.eth/proposal/0x…",
  bonus: "Approved by CEO · EOY review cycle",
  contractor: "INV-2026-04-*",
};

export const STEPPER_LABELS = [
  "Template",
  "Token",
  "Recipients",
  "Funds",
  "Review & sign",
] as const;
