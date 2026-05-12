import { encodeClaimPackage, type ClaimPackage } from "@zkscatter/sdk/notes";
import {
  type RecipientRow,
  type RunCategory,
  type RunRecord,
} from "@zkscatter/sdk/storage";
import type { RecipientRow as WizardRow } from "../../_lib/format";
import type { CategoryId } from "./_categories";

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
  categoryId: CategoryId;
  label: string;
  token: string;
  tokenAddress: string | undefined;
  operatorAddress: string | null;
  chainId: number | null;
  rows: WizardRow[];
  total: number;
  claimFrom: string | undefined;
  /** Real settle tx hash when scatterDirectAuth was submitted; falls
   *  back to a deterministic zero hash for env-not-configured demos. */
  txHash?: string;
  /** Per-recipient claim payloads from `realSettle`. Aligned with
   *  `rows` by index. Absent for env-not-configured demo runs. */
  claimPackages?: ClaimPackage[];
  /** Lower-cased recipient address → email captured at picker /
   *  upload time. Becomes the **only** source of email for the run
   *  record; buildRunRecord no longer reads the live address book.
   *  Keeping this immutable at submit time means later book edits
   *  never mutate a historical run record's contact fields. */
  emailByAddress?: Record<string, string>;
  /** Same picker-time snapshot pattern for telegram / kakao. The
   *  address book is shared mutable state across runs; reading it at
   *  display time would let later edits "rewrite history" on the
   *  detail page. */
  telegramByAddress?: Record<string, string>;
  kakaoByAddress?: Record<string, string>;
  /** Picker-time snapshot of the chosen entry's label. Falls back to
   *  the typed name first; only used when the wizard row has no name. */
  labelByAddress?: Record<string, string>;
  /** Token-units (decimal-string) of relayer fee actually paid. Sum
   *  across batches for a multi-batch run. Optional — stays undefined
   *  for the env-not-configured demo path. */
  relayerFee?: string;
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

  // No live address-book lookup at build time — every contact field
  // must arrive via the picker-time snapshot maps below. The book is
  // mutable shared state; reading it here would let a later edit
  // rewrite a historical run's email/telegram/kakao on the detail
  // page. Self-contained: file in → record out.
  const recipients: RecipientRow[] = input.rows.map((r, i) => {
    const lower = r.address.toLowerCase();
    const pkg = input.claimPackages?.[i];
    const email = input.emailByAddress?.[lower];
    const telegramHandle = input.telegramByAddress?.[lower];
    const kakaoId = input.kakaoByAddress?.[lower];
    const labelSnapshot = input.labelByAddress?.[lower];
    return {
      rowIndex: i,
      name: r.name || labelSnapshot || lower,
      address: lower,
      amount: r.amount,
      // Brand-new runs have no claim activity yet; "available" is
      // the right initial state for free-claim, "locked" while the
      // wizard's claim-from is in the future.
      status: isFutureClaim ? "locked" : "available",
      ...(isFutureClaim ? { claimFrom: claimFromUnix! } : {}),
      ...(email ? { email } : {}),
      ...(telegramHandle ? { telegramHandle } : {}),
      ...(kakaoId ? { kakaoId } : {}),
      ...(pkg ? { claimPackage: encodeClaimPackage(pkg) } : {}),
    };
  });

  // RunCategory has an "other" bucket the wizard's CategoryId set
  // doesn't include; the assignment is safe because the four wizard
  // ids are a subset of the category union.
  const category: RunCategory = input.categoryId;

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
    ...(input.relayerFee ? { relayerFee: input.relayerFee } : {}),
    recipients,
    notifications: [],
  };
}
