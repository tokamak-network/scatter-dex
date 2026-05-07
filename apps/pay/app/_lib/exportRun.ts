"use client";

import {
  indexLatestNotifications,
  type RunRecord,
} from "@zkscatter/sdk/storage";
import { buildClaimUrl } from "./claimUrl";
import { csvEscape, downloadCsv } from "./csv";
import { formatUtcStamp } from "./format";

const HEADERS = [
  "row_index",
  "name",
  "address",
  "is_stealth",
  "ephemeral_pub_key",
  "amount",
  "token",
  "status",
  "claimed_at_utc",
  "claim_from_utc",
  "email",
  "telegram",
  "kakao",
  "notified_at_utc",
  "claim_link",
] as const;

export function runRecordToCsv(record: RunRecord, origin: string): string {
  const logsByRow = indexLatestNotifications(record);
  const rows = record.recipients.map((r) => [
    r.rowIndex,
    r.name,
    r.address,
    // is_stealth flag: presence of an ephemeralPubKey on the row is
    // the on-record marker that this address was derived from a
    // meta-address rather than chosen as a plain EOA.
    r.ephemeralPubKey ? "yes" : "no",
    r.ephemeralPubKey ?? "",
    r.amount,
    record.tokenSymbol,
    r.status,
    formatUtcStamp(r.claimedAt),
    formatUtcStamp(r.claimFrom),
    r.email ?? "",
    r.telegramHandle ?? "",
    r.kakaoId ?? "",
    formatUtcStamp(logsByRow.get(r.rowIndex)?.sentAt),
    buildClaimUrl(origin, record.id, r),
  ]);
  const lines = [HEADERS.join(","), ...rows.map((r) => r.map(csvEscape).join(","))];
  return lines.join("\n") + "\n";
}

function slugifyLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
  return slug || "run";
}

export function buildCsvFilename(record: RunRecord): string {
  return `${slugifyLabel(record.label)}-${record.id}.csv`;
}

export function downloadRunCsv(record: RunRecord): void {
  const csv = runRecordToCsv(record, window.location.origin);
  downloadCsv(csv, buildCsvFilename(record));
}
