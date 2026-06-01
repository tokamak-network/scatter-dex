import type { OrderbookDB } from "./db.js";
import type { AuditEntryInsert } from "../types/audit.js";

/**
 * Record an audit entry **best-effort**: the audit log must never fail the
 * primary admin action whose success has already been committed (e.g. a KYC
 * status change or a Root CA publication). Any insert error is logged and
 * swallowed so the route still returns its success response.
 */
export function recordAuditSafe(db: OrderbookDB, entry: AuditEntryInsert): void {
  try {
    db.recordAudit(entry);
  } catch (err) {
    console.error(
      `[audit] failed to record ${entry.action} (${entry.targetType}:${entry.targetId}):`,
      err,
    );
  }
}
