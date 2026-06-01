"use client";

/** Operator-CA › KYC review.
 *
 *  The admin reviews relayer-operator KYC submissions (collected by the
 *  /register wizard step 1 and stored on the shared-orderbook): watch the
 *  liveness video, check the ID document, then mark the submission
 *  Verified / Rejected, or Approve it for issuance.
 *
 *  Approving emails the operator a certificate-issuance link (via the
 *  admin's mail client, the same Gmail-compose pattern Pay uses for
 *  claim links) and flips the submission to `approved`. Wiring the
 *  on-chain `IssuanceApprovalRegistry.approveForIssuance` write into the
 *  same button is the follow-up once the registry address is configured
 *  (coordinated with the operator-CA issuance gate).
 *
 *  Auth: the shared-orderbook `/api/kyc/*` admin routes require a bearer.
 *  Interim, the token is read from env so the signed-in admin doesn't
 *  type anything; the target is SIWE with the connected admin wallet
 *  (in progress on the orderbook) — only `authHeaders` changes then. */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Contract } from "ethers";
import { useWallet } from "@zkscatter/sdk/react";
import { SectionHeader } from "../../components/SectionHeader";

const ORDERBOOK_URL =
  process.env.NEXT_PUBLIC_SHARED_ORDERBOOK_URL ?? "http://localhost:4000";

/** IssuanceApprovalRegistry — approving a KYC submission writes the cert
 *  subject here on-chain (owner-only), which the operator's issuance
 *  screen then reads as the FIXED, read-only subject. */
const ISSUANCE_REGISTRY = process.env.NEXT_PUBLIC_ISSUANCE_APPROVAL_REGISTRY_ADDRESS ?? "";
const APPROVE_ABI = [
  "function approve(address operator, string commonName, string organization, string country, uint32 validityDays, uint64 expiresAt)",
];

/** Dev/interim bearer, read from env so the page authenticates without a
 *  manual token entry. Replaced by a SIWE session header (signed by the
 *  connected admin wallet) once the orderbook's signature auth lands. */
const ADMIN_TOKEN = process.env.NEXT_PUBLIC_ORDERBOOK_ADMIN_TOKEN ?? "";

function authHeaders(): HeadersInit {
  return ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {};
}

type KycStatus = "pending" | "verified" | "approved" | "rejected";

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
function canTransition(from: KycStatus, to: KycStatus): boolean {
  if (from === "pending") return to === "verified" || to === "rejected";
  if (from === "verified") return to === "approved" || to === "rejected";
  return false; // approved / rejected are terminal
}

export default function KycReviewPage() {
  const [list, setList] = useState<SubmissionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const refreshList = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${ORDERBOOK_URL}/api/kyc/submissions`, {
        headers: authHeaders(),
      });
      if (res.status === 401 || res.status === 503) {
        throw new Error(
          res.status === 503
            ? "KYC admin endpoints are disabled (orderbook ADMIN_TOKEN unset)."
            : "Not authorized — admin auth not configured.",
        );
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
  }, []);

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
          approve them for certificate issuance. Approving emails the operator
          their issuance link.
        </p>
      </header>

      <section>
        <SectionHeader
          title="Submissions"
          badge="live"
          hint={loading ? "Loading…" : `${list.length} total`}
        />
        {!ADMIN_TOKEN && (
          <p className="mb-3 text-xs text-[var(--color-warning)]">
            Admin auth not configured — set <code className="font-mono">NEXT_PUBLIC_ORDERBOOK_ADMIN_TOKEN</code>{" "}
            (dev) until SIWE admin-signature auth lands.
          </p>
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
          <SubmissionPanel id={selectedId} onChanged={refreshList} />
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
      <aside className="relative flex h-full w-full max-w-xl flex-col overflow-y-auto bg-[var(--color-surface)] shadow-xl">
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
}: {
  id: string;
  onChanged: () => Promise<void>;
}) {
  const { signer, connect } = useWallet();
  const [detail, setDetail] = useState<SubmissionDetail | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [docUrl, setDocUrl] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Cert subject fixed on-chain at approval (read-only to the operator later).
  const [cn, setCn] = useState("");
  const [org, setOrg] = useState("");
  const [country, setCountry] = useState("KR");
  const [validityDays, setValidityDays] = useState("365");

  // Files need the auth header, so they can't be a plain <video src>; fetch
  // each as a blob and hand the component an object URL.
  const loadFile = useCallback(async (kind: "video" | "idDoc"): Promise<string | null> => {
    try {
      const res = await fetch(`${ORDERBOOK_URL}/api/kyc/submissions/${id}/file/${kind}`, {
        headers: authHeaders(),
      });
      if (!res.ok) return null;
      return URL.createObjectURL(await res.blob());
    } catch {
      return null;
    }
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    let v: string | null = null;
    let d: string | null = null;
    (async () => {
      setErr("");
      try {
        const res = await fetch(`${ORDERBOOK_URL}/api/kyc/submissions/${id}`, {
          headers: authHeaders(),
        });
        if (!res.ok) throw new Error(`Detail failed (${res.status})`);
        const json = (await res.json()) as SubmissionDetail;
        if (cancelled) return;
        setDetail(json);
        setNotes(json.notes ?? "");
        setCn((prev) => prev || json.email.split("@")[0] || "");
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
        const res = await fetch(`${ORDERBOOK_URL}/api/kyc/submissions/${id}/status`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
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
    [id, notes, onChanged],
  );

  /** Approve = fix the cert subject on-chain (IssuanceApprovalRegistry,
   *  owner-only) + record the decision + email the issuance link. The
   *  on-chain write is what unlocks the operator's issuance/verify. */
  const onApprove = useCallback(async () => {
    setErr("");
    if (!detail) return;
    if (!ISSUANCE_REGISTRY) {
      setErr("Issuance registry not configured (NEXT_PUBLIC_ISSUANCE_APPROVAL_REGISTRY_ADDRESS).");
      return;
    }
    if (!signer) { setErr("Connect the admin (owner) wallet to approve on-chain."); return; }
    if (!cn.trim() || !org.trim()) { setErr("Common name and organization are required."); return; }
    if (country.trim().length !== 2) { setErr("Country must be a 2-letter ISO-3166 code."); return; }
    const days = Number(validityDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) { setErr("Validity must be 1–3650 days."); return; }
    setBusy(true);
    try {
      const reg = new Contract(ISSUANCE_REGISTRY, APPROVE_ABI, signer);
      const tx = await reg.approve(
        detail.wallet,
        cn.trim(),
        org.trim(),
        country.trim().toUpperCase(),
        days,
        0, // expiresAt 0 = no expiry
      );
      await tx.wait();
      const res = await fetch(`${ORDERBOOK_URL}/api/kyc/submissions/${id}/status`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved", notes: notes || undefined }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Status update failed (${res.status})`);
      }
      setDetail((d) => (d ? { ...d, status: "approved" } : d));
      emailIssuanceLink(detail.email, detail.wallet);
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Approve failed");
    } finally {
      setBusy(false);
    }
  }, [detail, signer, cn, org, country, validityDays, id, notes, onChanged]);

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
            Certificate subject — fixed on-chain at approval (operator sees it read-only)
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <LabeledInput label="Common name (CN)" value={cn} onChange={setCn} placeholder="Operator name" />
            <LabeledInput label="Organization (O)" value={org} onChange={setOrg} placeholder="Company" />
            <LabeledInput label="Country (C, ISO-3166)" value={country} onChange={setCountry} placeholder="KR" />
            <LabeledInput label="Validity (days)" value={validityDays} onChange={setValidityDays} placeholder="365" />
          </div>
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
          disabled={busy || !canTransition(status, "approved")}
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
      </div>
      {status === "approved" && (
        <p className="text-xs text-[var(--color-success)]">
          Approved on-chain — the operator can now issue their certificate from
          the emailed link.
        </p>
      )}
    </div>
  );
}

/** Open the admin's mail client with the certificate-issuance link
 *  pre-filled — the same Gmail web-compose pattern Pay uses for claim
 *  emails (no server-side SMTP). */
function emailIssuanceLink(email: string, wallet: string) {
  const certUrl = `${window.location.origin}/operator-ca?wallet=${encodeURIComponent(wallet)}`;
  const subject = "Your relayer certificate-issuance link";
  const body = [
    "Hi,",
    "",
    "Your relayer KYC has been approved. Issue your operator certificate here:",
    certUrl,
    "",
    "This link is tied to your wallet and only works once your address is approved.",
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
