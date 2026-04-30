import { encodeClaimPackage, type ClaimPackage } from "@zkscatter/sdk/notes";
import {
  type RecipientRow,
  type RunCategory,
  type RunRecord,
  type WalletEntry,
} from "@zkscatter/sdk/storage";
import type { RecipientRow as WizardRow } from "../../_lib/format";
import type { TemplateId } from "./_templates";

export type { WizardRow };

/** Mint a URL-safe id derived from the timestamp + a random suffix.
 *  Filenames key off this id (`zkscatter-run-<id>.json`) so collisions
 *  between two settles in the same second would silently overwrite —
 *  the random tail keeps each id unique without needing a registry
 *  lookup. */
export function mintRunId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `p_${crypto.randomUUID()}`;
  }
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 10);
  return `p_${ts}_${rand}`;
}

/** Format a JS number total back into the comma-separated display
 *  string that `RunRecord.totalAmount` expects. Uses 2 fraction
 *  digits like the wizard's review screen. */
export function formatTotal(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export interface BuildRunRecordInput {
  templateId: TemplateId;
  label: string;
  token: string;
  tokenAddress: string | undefined;
  operatorAddress: string | null;
  chainId: number | null;
  rows: WizardRow[];
  total: number;
  claimFrom: string | undefined;
  walletBook: WalletEntry[];
  /** Real settle tx hash when scatterDirectAuth was submitted; falls
   *  back to a deterministic zero hash for env-not-configured demos. */
  txHash?: string;
  /** Per-recipient claim payloads from `realSettle`. Aligned with
   *  `rows` by index. Absent for env-not-configured demo runs. */
  claimPackages?: ClaimPackage[];
}

/** Construct a `RunRecord` from the wizard's parsed state. The record
 *  is the operator-side mirror of the settle tx — recipient names /
 *  amounts / claim-from windows live here and never on-chain.
 *
 *  `txHash` is a placeholder until the real settle path lands; the
 *  detail page reads but doesn't link to it yet, so a deterministic
 *  zero hash is fine. `settleGasPaid` stays undefined for the same
 *  reason. The dashboard tolerates both gaps. */
export function buildRunRecord(input: BuildRunRecordInput): RunRecord {
  const now = Math.floor(Date.now() / 1000);
  const claimFromUnix = input.claimFrom
    ? Math.floor(new Date(input.claimFrom).getTime() / 1000)
    : null;
  const isFutureClaim = claimFromUnix !== null && claimFromUnix > now;

  const bookByAddress = new Map<string, WalletEntry>();
  for (const e of input.walletBook) bookByAddress.set(e.address.toLowerCase(), e);

  const recipients: RecipientRow[] = input.rows.map((r, i) => {
    const lower = r.address.toLowerCase();
    const book = bookByAddress.get(lower);
    const pkg = input.claimPackages?.[i];
    return {
      rowIndex: i,
      name: r.name || book?.label || lower,
      address: lower,
      amount: r.amount,
      // Brand-new runs have no claim activity yet; "available" is
      // the right initial state for free-claim, "locked" while the
      // wizard's claim-from is in the future.
      status: isFutureClaim ? "locked" : "available",
      ...(isFutureClaim ? { claimFrom: claimFromUnix! } : {}),
      ...(book?.email ? { email: book.email } : {}),
      ...(book?.discordHandle ? { discordHandle: book.discordHandle } : {}),
      ...(pkg ? { claimPackage: encodeClaimPackage(pkg) } : {}),
    };
  });

  // RunCategory has an "other" bucket the wizard's TemplateId set
  // doesn't include; the assignment is safe because the four template
  // ids are a subset of the category union.
  const category: RunCategory = input.templateId;

  return {
    id: mintRunId(),
    label: input.label,
    operatorAddress: (input.operatorAddress ?? "").toLowerCase(),
    category,
    createdAt: now,
    settledAt: now,
    chainId: input.chainId ?? 0,
    txHash: input.txHash ?? "0x" + "0".repeat(64),
    tokenSymbol: input.token,
    tokenAddress: input.tokenAddress ?? "",
    totalAmount: formatTotal(input.total),
    recipients,
    notifications: [],
  };
}
