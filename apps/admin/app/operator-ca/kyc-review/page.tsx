"use client";

/** Operator-CA › KYC review.
 *
 *  The admin reviews relayer-operator KYC submissions (collected by the
 *  /register wizard step 1 and stored on the shared-orderbook): watch the
 *  liveness video, check the ID document, then mark the submission
 *  Verified / Rejected, or Approve it (which fixes the operator's identity
 *  on-chain and continues their onboarding).
 *
 *  Approving writes the cert subject on-chain (IssuanceApprovalRegistry,
 *  owner-only), flips the submission to `approved`, and emails the operator
 *  an onboarding link (via the admin's mail client, the same Gmail-compose
 *  pattern Pay uses for claim links).
 *
 *  Auth: the shared-orderbook `/api/kyc/*` admin routes require a bearer
 *  token. The admin authenticates by SIGNING a challenge with the connected
 *  admin wallet (SIWE) — see `useAdminSiwe`; the minted session token is held
 *  in memory only, never persisted. There is no static env token. */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Contract } from "ethers";
import { useWallet } from "@zkscatter/sdk/react";
import { useAdminSiwe } from "../../lib/useAdminSiwe";
import { parseConfigUrl } from "../../lib/configUrl";
import { SectionHeader } from "../../components/SectionHeader";
import { ComplianceCrossCheck, type CrossCheckState } from "../_components/ComplianceCrossCheck";

const ORDERBOOK_URL = parseConfigUrl(
  process.env.NEXT_PUBLIC_SHARED_ORDERBOOK_URL,
  "http://localhost:4000",
);

/** The OPERATORS app, where an approved operator continues onboarding
 *  (verify their certificate via zk-X509, then register the relayer). The
 *  KYC-approval email links here. scatter-dex no longer issues certificates. */
const OPERATORS_URL = parseConfigUrl(
  process.env.NEXT_PUBLIC_OPERATORS_URL,
  "http://localhost:4004",
);

/** IssuanceApprovalRegistry — approving a KYC submission writes the cert
 *  subject here on-chain (owner-only), which the operator's issuance
 *  screen then reads as the FIXED, read-only subject. */
const ISSUANCE_REGISTRY = process.env.NEXT_PUBLIC_ISSUANCE_APPROVAL_REGISTRY_ADDRESS ?? "";
const APPROVE_ABI = [
  "function approve(address operator, string commonName, string organization, string country, uint32 validityDays, uint64 expiresAt)",
  "function revoke(address operator, string reason)",
  // Read the current on-chain approval so the flow can be made idempotent
  // (skip a redundant tx that would revert) and self-heal if a prior DB
  // write failed after the chain already changed.
  "function approvals(address operator) view returns (tuple(string commonName, string organization, string country, uint32 validityDays, address approvedBy, uint64 approvedAt, uint64 expiresAt, bool revoked, string revokeReason, uint64 revokedAt))",
];

type KycStatus = "pending" | "verified" | "approved" | "rejected" | "revoked";

interface SubmissionSummary {
  id: string;
  wallet: string;
  email: string;
  status: KycStatus;
  createdAt: number;
  reviewedAt: number | null;
}

interface FileMeta {
  present: boolean;
  contentType?: string;
  sizeBytes?: number;
}

interface SubmissionDetail extends SubmissionSummary {
  notes: string | null;
  files: { video: FileMeta; idDoc: FileMeta };
}

/** Allowed status transitions — mirrors the shared-orderbook's
 *  `canTransitionKyc` (kept inline since that helper lives in the
 *  orderbook package, not the shared types). */
/** Record a KYC status transition in the orderbook. Called AFTER the
 *  on-chain write (the source of truth for issuance gating), so a failure
 *  here is a secondary, retryable record error — not a lost decision. */
async function recordStatus(
  id: string,
  status: KycStatus,
  notes: string | undefined,
  authedFetch: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<void> {
  const res = await authedFetch(`${ORDERBOOK_URL}/api/kyc/submissions/${id}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, notes: notes || undefined }),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      `On-chain done, but recording failed (${j.error ?? res.status}). Click again to retry the record.`,
    );
  }
}

function canTransition(from: KycStatus, to: KycStatus): boolean {
  if (from === "pending") return to === "verified" || to === "rejected";
  if (from === "verified") return to === "approved" || to === "rejected";
  // `approved` can still be revoked (after-the-fact identity invalidation,
  // mirrored on-chain); rejected / revoked are terminal.
  if (from === "approved") return to === "revoked";
  return false;
}

export default function KycReviewPage() {
  const { account, connect, authedFetch } = useAdminSiwe(ORDERBOOK_URL);
  const [list, setList] = useState<SubmissionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const refreshList = useCallback(async () => {
    // Loading the queue requires an authenticated admin wallet — wait for a
    // connection (the prompt below) rather than firing an unauthed request.
    if (!account) { setList([]); setError(""); return; }
    setError("");
    setLoading(true);
    try {
      const res = await authedFetch(`${ORDERBOOK_URL}/api/kyc/submissions`);
      if (res.status === 401 || res.status === 403) {
        throw new Error("Not authorized — this wallet isn't an admin, or the session expired.");
      }
      if (res.status === 503) {
        throw new Error("KYC admin endpoints are disabled — orderbook SIWE auth (ADMIN_ADDRESSES) is not configured.");
      }
      if (!res.ok) throw new Error(`List failed (${res.status})`);
      const json = (await res.json()) as { submissions: SubmissionSummary[] };
      setList(json.submissions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load submissions");
      setList([]);
    } finally {
      setLoading(false);
    }
  }, [account, authedFetch]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  return (
    <div className="space-y-8">
      <header>
        <Link
          href="/operator-ca"
          className="text-xs text-[var(--color-text-muted)] hover:underline"
        >
          ← Operator CA
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Operator CA — KYC review</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
          Review relayer-operator identity submissions, then verify, reject, or
          approve them to continue onboarding. Approving fixes their identity
          on-chain and emails the operator their onboarding link.
        </p>
      </header>

      <section>
        <SectionHeader
          title="Submissions"
          badge="live"
          hint={loading ? "Loading…" : `${list.length} total`}
        />
        {!account && (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-3 py-2 text-xs">
            <span>
              Connect the admin wallet to load and review submissions — each session is
              authenticated by a wallet signature (no shared token).
            </span>
            <button
              type="button"
              onClick={() => void connect()}
              className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-1 font-medium hover:bg-[var(--color-primary-soft)]"
            >
              Connect admin wallet
            </button>
          </div>
        )}
        <div className="mb-3">
          <button
            type="button"
            onClick={() => void refreshList()}
            className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-primary-soft)]"
          >
            Refresh
          </button>
        </div>
        {error && <p className="mb-3 text-xs text-[var(--color-danger)]">{error}</p>}
        {list.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">No submissions.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            {list.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(s.id)}
                  className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm hover:bg-[var(--color-primary-soft)] ${
                    s.id === selectedId ? "bg-[var(--color-primary-soft)]" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="font-mono text-xs">{s.wallet}</span>
                    <span className="ml-2 text-[var(--color-text-muted)]">{s.email}</span>
                  </span>
                  <StatusBadge status={s.status} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selectedId && (
        <Drawer title="KYC submission" onClose={() => setSelectedId(null)}>
          <SubmissionPanel id={selectedId} onChanged={refreshList} authedFetch={authedFetch} />
        </Drawer>
      )}
    </div>
  );
}

/** Right-hand slide-out panel for the selected submission's detail and
 *  review actions. Backdrop click or Esc closes it. */
function Drawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
        aria-hidden
      />
      <aside className="relative flex h-full w-full max-w-3xl flex-col overflow-y-auto bg-[var(--color-surface)] shadow-xl">
        <div className="sticky top-0 flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--color-text-subtle)] hover:bg-[var(--color-bg)]"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="px-1 py-1">{children}</div>
      </aside>
    </div>
  );
}

function StatusBadge({ status }: { status: KycStatus }) {
  const tone: Record<KycStatus, string> = {
    pending: "bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
    verified: "bg-[var(--color-primary-soft)] text-[var(--color-primary)]",
    approved: "bg-[var(--color-success-soft)] text-[var(--color-success)]",
    rejected: "bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
    revoked: "bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${tone[status]}`}>
      {status}
    </span>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block text-xs">
      <span className="mb-0.5 block text-[var(--color-text-subtle)]">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-2 py-1.5 text-sm"
      />
    </label>
  );
}

function SubmissionPanel({
  id,
  onChanged,
  authedFetch,
}: {
  id: string;
  onChanged: () => Promise<void>;
  authedFetch: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const { signer, connect } = useWallet();
  const [detail, setDetail] = useState<SubmissionDetail | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [docUrl, setDocUrl] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Cross-check state lifted from the inline ComplianceCrossCheck: the PROVED
  // cert subject (written on-chain at approval — the admin no longer types it)
  // plus the two gates (wallet match + admin name confirmation).
  const [crossCheck, setCrossCheck] = useState<CrossCheckState | null>(null);
  // Cert subject written on-chain at approval. Editable, but PREFILLED from the
  // proved zk-X509 subject so the admin records the proved identity by default
  // (and can adjust if needed). The two cross-checks still gate Approve.
  const [cn, setCn] = useState("");
  const [org, setOrg] = useState("");
  const [country, setCountry] = useState("KR");
  const [validityDays, setValidityDays] = useState("365");

  // Prefill from the proved subject when it loads/changes (keyed on the values,
  // so toggling the name-confirm checkbox doesn't clobber admin edits).
  useEffect(() => {
    if (crossCheck?.hasProof) {
      if (crossCheck.commonName) setCn(crossCheck.commonName);
      if (crossCheck.org) setOrg(crossCheck.org);
      if (crossCheck.country) setCountry(crossCheck.country.toUpperCase().slice(0, 2));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crossCheck?.commonName, crossCheck?.org, crossCheck?.country, crossCheck?.hasProof]);

  // Files need the auth header, so they can't be a plain <video src>; fetch
  // each as a blob and hand the component an object URL.
  const loadFile = useCallback(async (kind: "video" | "idDoc"): Promise<string | null> => {
    try {
      const res = await authedFetch(`${ORDERBOOK_URL}/api/kyc/submissions/${id}/file/${kind}`);
      if (!res.ok) return null;
      return URL.createObjectURL(await res.blob());
    } catch {
      return null;
    }
  }, [id, authedFetch]);

  useEffect(() => {
    let cancelled = false;
    let v: string | null = null;
    let d: string | null = null;
    (async () => {
      setErr("");
      try {
        const res = await authedFetch(`${ORDERBOOK_URL}/api/kyc/submissions/${id}`);
        if (!res.ok) throw new Error(`Detail failed (${res.status})`);
        const json = (await res.json()) as SubmissionDetail;
        if (cancelled) return;
        setDetail(json);
        setNotes(json.notes ?? "");
        if (json.files.video.present) {
          v = await loadFile("video");
          // The fetch can resolve after the drawer closed; revoke instead
          // of leaking the object URL (the cleanup already ran by then).
          if (cancelled) { if (v) URL.revokeObjectURL(v); v = null; } else setVideoUrl(v);
        }
        if (json.files.idDoc.present) {
          d = await loadFile("idDoc");
          if (cancelled) { if (d) URL.revokeObjectURL(d); d = null; } else setDocUrl(d);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
      if (v) URL.revokeObjectURL(v);
      if (d) URL.revokeObjectURL(d);
    };
  }, [id, loadFile]);

  const setStatus = useCallback(
    async (status: KycStatus) => {
      setErr("");
      setBusy(true);
      try {
        const res = await authedFetch(`${ORDERBOOK_URL}/api/kyc/submissions/${id}/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status, notes: notes || undefined }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `Update failed (${res.status})`);
        }
        // Reflect the new status locally so the drawer's action buttons
        // re-gate immediately (the list refresh is separate).
        setDetail((d) => (d ? { ...d, status } : d));
        await onChanged();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Update failed");
      } finally {
        setBusy(false);
      }
    },
    [id, notes, onChanged, authedFetch],
  );

  /** Approve = fix the cert subject on-chain (IssuanceApprovalRegistry,
   *  owner-only) + record the decision + email the onboarding link. The
   *  on-chain write is what unlocks the operator's verify/register flow. */
  const onApprove = useCallback(async () => {
    setErr("");
    if (!detail) return;
    if (!ISSUANCE_REGISTRY) {
      setErr("Issuance registry not configured (NEXT_PUBLIC_ISSUANCE_APPROVAL_REGISTRY_ADDRESS).");
      return;
    }
    if (!signer) { setErr("Connect the admin (owner) wallet to approve on-chain."); return; }
    // Write the PROVED cert subject (from zk-X509), not an admin-typed one —
    // the two cross-checks below must hold first.
    if (!crossCheck?.hasProof) { setErr("No zk-X509 proof on record for this wallet — cannot approve."); return; }
    if (crossCheck.walletMatch !== true) { setErr("Proof wallet doesn't match this submission — do not approve."); return; }
    if (!crossCheck.nameConfirmed) { setErr("Confirm the certificate name matches the ID/video first."); return; }
    if (!cn.trim() || !org.trim()) { setErr("Common name and organization are required."); return; }
    if (country.trim().length !== 2) { setErr("Country must be a 2-letter ISO-3166 code."); return; }
    const days = Number(validityDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) { setErr("Validity must be 1–3650 days."); return; }
    setBusy(true);
    try {
      const reg = new Contract(ISSUANCE_REGISTRY, APPROVE_ABI, signer);
      // Idempotent: skip the tx if this wallet is already approved (and
      // not revoked) on-chain — e.g. a prior DB write failed after the
      // chain changed. Just re-sync the record below.
      const current = await reg.approvals(detail.wallet);
      const alreadyApproved = current.approvedAt > 0n && !current.revoked;
      if (!alreadyApproved) {
        const tx = await reg.approve(
          detail.wallet,
          cn.trim(),
          org.trim(),
          country.trim().toUpperCase(),
          days,
          0, // expiresAt 0 = no expiry
        );
        await tx.wait();
      }
      setDetail((d) => (d ? { ...d, status: "approved" } : d));
      await recordStatus(id, "approved", notes, authedFetch);
      emailOnboardingLink(detail.email, detail.wallet);
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Approve failed");
    } finally {
      setBusy(false);
    }
  }, [detail, signer, crossCheck, cn, org, country, validityDays, id, notes, onChanged, authedFetch]);

  /** Revoke = invalidate an already-approved identity on-chain
   *  (IssuanceApprovalRegistry.revoke, owner-only) + record it. The
   *  on-chain revoke is what the issuance gate reads; the DB status
   *  mirrors it for the review queue. */
  const onRevoke = useCallback(async () => {
    setErr("");
    if (!detail) return;
    if (!ISSUANCE_REGISTRY) {
      setErr("Issuance registry not configured (NEXT_PUBLIC_ISSUANCE_APPROVAL_REGISTRY_ADDRESS).");
      return;
    }
    if (!signer) { setErr("Connect the admin (owner) wallet to revoke on-chain."); return; }
    const reason = notes.trim();
    if (!reason) { setErr("Enter a revocation reason in the notes field."); return; }
    if (!window.confirm(`Revoke ${detail.wallet}? Their certificate identity will be invalidated.`)) return;
    setBusy(true);
    try {
      const reg = new Contract(ISSUANCE_REGISTRY, APPROVE_ABI, signer);
      // Idempotent: if a prior attempt already revoked on-chain (e.g. the
      // DB write then failed), skip the tx that would revert with
      // AlreadyRevoked and just re-sync the DB.
      const current = await reg.approvals(detail.wallet);
      if (!current.revoked) {
        const tx = await reg.revoke(detail.wallet, reason);
        await tx.wait();
      }
      // On-chain (the source of truth for gating) is now revoked — reflect
      // it immediately; a DB recording failure is a secondary, retryable
      // error rather than a lost revocation.
      setDetail((d) => (d ? { ...d, status: "revoked" } : d));
      await recordStatus(id, "revoked", reason, authedFetch);
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Revoke failed");
    } finally {
      setBusy(false);
    }
  }, [detail, signer, id, notes, onChanged, authedFetch]);

  if (err && !detail) {
    return <div className="px-4 py-3 text-xs text-[var(--color-danger)]">{err}</div>;
  }
  if (!detail) {
    return <div className="px-4 py-3 text-xs text-[var(--color-text-muted)]">Loading…</div>;
  }

  const status = detail.status;
  return (
    <div className="space-y-4 border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-semibold text-[var(--color-text-subtle)]">Liveness video</div>
          {videoUrl ? (
            <video src={videoUrl} controls className="w-full rounded-lg border border-[var(--color-border)]" />
          ) : (
            <p className="text-xs text-[var(--color-text-muted)]">No video.</p>
          )}
        </div>
        <div>
          <div className="mb-1 text-xs font-semibold text-[var(--color-text-subtle)]">ID document</div>
          {docUrl ? (
            detail.files.idDoc.contentType === "application/pdf" ? (
              <iframe src={docUrl} className="h-72 w-full rounded-lg border border-[var(--color-border)]" title="ID document" />
            ) : (
              <img src={docUrl} alt="ID document" className="w-full rounded-lg border border-[var(--color-border)]" />
            )
          ) : (
            <p className="text-xs text-[var(--color-text-muted)]">No document.</p>
          )}
        </div>
      </div>

      <div className="text-xs text-[var(--color-text-muted)]">
        <span className="font-mono">{detail.wallet}</span> · {detail.email} · submitted{" "}
        {new Date(detail.createdAt * 1000).toISOString().slice(0, 16).replace("T", " ")}
      </div>

      {/* zk-X509 proved certificate subject for THIS wallet, pulled inline so the
          admin can compare it against the KYC video / ID above without leaving
          the drawer (cross-check the name / org / country before approving). */}
      <div>
        <div className="mb-1 text-xs font-semibold text-[var(--color-text-subtle)]">
          Proved certificate (zk-X509) — compare against the documents above
        </div>
        <ComplianceCrossCheck fixedWallet={detail.wallet} onCrossCheck={setCrossCheck} />
      </div>

      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Review notes (e.g. rejection reason)"
        rows={2}
        className="w-full rounded-lg border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
      />

      {canTransition(status, "approved") && (
        <div className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div className="text-xs font-semibold text-[var(--color-text-subtle)]">
            Certificate subject — written ON-CHAIN at approval. Prefilled from the zk-X509
            proof; the admin can edit before approving. The operator then sees it read-only.
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <LabeledInput label="Common name (CN)" value={cn} onChange={setCn} placeholder="Operator name" />
            <LabeledInput label="Organization (O)" value={org} onChange={setOrg} placeholder="Company" />
            <LabeledInput label="Country (C, ISO-3166)" value={country} onChange={setCountry} placeholder="KR" />
            <LabeledInput label="Validity (days)" value={validityDays} onChange={setValidityDays} placeholder="365" />
          </div>
          <p className="text-[10px] text-[var(--color-text-muted)]">
            Writes <code className="font-mono">IssuanceApprovalRegistry.approve(wallet, CN, O, C, …)</code>{" "}
            on-chain (owner-only).
          </p>
          {!signer && (
            <button
              type="button"
              onClick={() => void connect()}
              className="text-xs font-medium text-[var(--color-primary)] underline"
            >
              Connect admin (owner) wallet to approve on-chain
            </button>
          )}
        </div>
      )}

      {err && <p className="text-xs text-[var(--color-danger)]">{err}</p>}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !canTransition(status, "verified")}
          onClick={() => void setStatus("verified")}
          className="rounded-md border border-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary-soft)] disabled:opacity-40"
        >
          Mark verified
        </button>
        <button
          type="button"
          disabled={
            busy ||
            !canTransition(status, "approved") ||
            !crossCheck?.hasProof ||
            crossCheck.walletMatch !== true ||
            !crossCheck.nameConfirmed
          }
          title={
            !crossCheck?.hasProof
              ? "No zk-X509 proof on record yet"
              : crossCheck.walletMatch !== true
                ? "Proof wallet must match this submission"
                : !crossCheck.nameConfirmed
                  ? "Confirm the certificate name matches the ID/video first"
                  : undefined
          }
          onClick={() => void onApprove()}
          className="rounded-md bg-[var(--color-success)] px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
        >
          Approve issuance + email link
        </button>
        <button
          type="button"
          disabled={busy || !canTransition(status, "rejected")}
          onClick={() => void setStatus("rejected")}
          className="rounded-md border border-[var(--color-danger)] px-3 py-2 text-sm font-medium text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)] disabled:opacity-40"
        >
          Reject
        </button>
        <button
          type="button"
          disabled={busy || !canTransition(status, "revoked")}
          onClick={() => void onRevoke()}
          className="rounded-md bg-[var(--color-danger)] px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
        >
          Revoke approval
        </button>
      </div>
      {status === "approved" && (
        <p className="text-xs text-[var(--color-success)]">
          Approved on-chain — the operator can now continue onboarding from the
          emailed link (verify their certificate via zk-X509, then register). To
          invalidate it later, enter a reason in notes and use Revoke approval.
        </p>
      )}
      {status === "revoked" && (
        <p className="text-xs text-[var(--color-danger)]">
          Revoked on-chain — this operator&apos;s certificate identity is no
          longer valid.
        </p>
      )}
    </div>
  );
}

/** Open the admin's mail client with the onboarding link pre-filled — the
 *  same Gmail web-compose pattern Pay uses for claim emails (no server-side
 *  SMTP). scatter-dex no longer issues certificates: after KYC approval the
 *  operator proves their real certificate via zk-X509 and continues the
 *  relayer onboarding wizard. */
function emailOnboardingLink(email: string, wallet: string) {
  const onboardUrl = `${OPERATORS_URL}/register?wallet=${encodeURIComponent(wallet)}`;
  const subject = "Your relayer onboarding is approved";
  const body = [
    "Hi,",
    "",
    "Your relayer KYC has been approved. Continue onboarding here — verify your",
    "certificate with zk-X509 and register your relayer:",
    onboardUrl,
    "",
    "This link is tied to your wallet and the next steps unlock once your address is approved.",
  ].join("\r\n");
  const gmailUrl =
    `https://mail.google.com/mail/?view=cm&fs=1` +
    `&to=${encodeURIComponent(email)}` +
    `&su=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`;
  const a = document.createElement("a");
  a.href = gmailUrl;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  // Firefox ignores .click() on an anchor that isn't in the document.
  document.body.appendChild(a);
  a.click();
  a.remove();
}
