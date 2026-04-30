import type { RecipientRow, RunRecord } from "@zkscatter/sdk/storage";

/** Real claim URL is `/claim?id=<linkId>#<base64url(ClaimPackage)>`.
 *  Query-string form (instead of `/claim/[link]`) keeps the page
 *  statically exportable on Firebase. The id is `<runId>_<rowIndex>`
 *  so the dashboard can re-associate a claim back to its run + row
 *  even after the user revokes the link from the URL bar. Returns
 *  empty string when the row predates the claim flow (no encoded
 *  package). */
export function buildClaimUrl(
  origin: string,
  runId: RunRecord["id"],
  row: RecipientRow,
): string {
  if (!row.claimPackage) return "";
  return `${origin}/claim?id=${runId}_${row.rowIndex}#${row.claimPackage}`;
}
