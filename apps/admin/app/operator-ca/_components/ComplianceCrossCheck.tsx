"use client";

import { useCallback, useEffect, useState } from "react";
import { parseConfigUrl } from "../../lib/configUrl";
import { explainError } from "../../lib/format";
import { normalizeEvmAddress } from "../../lib/x509";

/** The zk-X509 prover-server compliance endpoint. The prover records the
 *  certificate subject each operator proved (name / org / country) and exposes
 *  it for the admin to cross-check against the KYC submission before approving.
 *  Defaults to the local dev prover; set NEXT_PUBLIC_PROVER_URL to point at a
 *  deployed prover. (zk-X509 also exposes it on-chain via
 *  IdentityRegistry.proverUrl(), but a static config URL keeps this read-only
 *  panel free of an extra on-chain round-trip.) */
// Resolve config at module load, but DON'T let a malformed env var throw during
// import — a module-level throw escapes React error boundaries and white-screens
// the whole admin console. Capture it and surface it in the panel instead.
let PROVER_URL = "";
let configError: string | null = null;
try {
  PROVER_URL = parseConfigUrl(process.env.NEXT_PUBLIC_PROVER_URL, "http://localhost:9090");
} catch (err) {
  configError = err instanceof Error ? err.message : String(err);
}

/** Optional PII guard. When the prover runs with PROVER_COMPLIANCE_TOKEN set,
 *  the admin console must echo it as `X-Compliance-Token`. Unset in local dev.
 *
 *  ⚠ Interim: NEXT_PUBLIC_ vars are inlined into the client bundle, so this
 *  token is visible to anyone with the admin app. Acceptable for a dev/test
 *  admin console; for production, gate the prover behind a server-side proxy
 *  that injects the token server-to-server (or a SIWE-authenticated session),
 *  so the browser never holds a shared secret. */
const COMPLIANCE_TOKEN = process.env.NEXT_PUBLIC_PROVER_COMPLIANCE_TOKEN?.trim() || undefined;

/** One proof the operator submitted to zk-X509. Re-proofs produce multiple,
 *  returned newest-first. Mirrors the prover compliance API contract. */
interface ComplianceRecord {
  timestamp: number; // unix seconds — when the proof was recorded
  registrant: string; // EVM address that registered (== queried wallet)
  commonName: string;
  org: string;
  orgUnit: string;
  country: string;
  serial: string; // certificate serial (0x hex)
  notAfter: number; // unix seconds — certificate expiry
  nullifier: string; // bytes32 hex — join key to the on-chain IdentityRegistry
  consentVerified: boolean;
  consentMessage: string;
  consentSignature: string; // non-repudiation evidence (cert-key signature)
}

/** Lifted to the KYC drawer: the two cross-checks (wallet match + admin name
 *  confirmation) gate Approve, and the proved subject is what gets written
 *  on-chain — the admin no longer types it. `hasProof` is false when the
 *  operator hasn't proved a cert yet (nothing to approve against). */
export interface CrossCheckState {
  hasProof: boolean;
  walletMatch: boolean | null;
  nameConfirmed: boolean;
  commonName: string;
  org: string;
  country: string;
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; wallet: string; records: ComplianceRecord[] }
  | { kind: "error"; msg: string };

/** `fixedWallet` pins the panel to one operator and auto-looks-up on mount,
 *  hiding the address input — used inside the KYC review drawer so the admin
 *  sees the proved cert subject right next to the KYC documents. Omit it (the
 *  standalone /operator-ca page) to get the manual address-entry form. */
export function ComplianceCrossCheck({
  fixedWallet,
  onCrossCheck,
}: {
  fixedWallet?: string;
  /** Latest proof's cross-check state (wallet match + admin name confirmation)
   *  plus the proved subject, so the drawer can gate Approve AND write the
   *  PROVED identity on-chain (not an admin-typed one). */
  onCrossCheck?: (state: CrossCheckState) => void;
} = {}) {
  const [wallet, setWallet] = useState(fixedWallet ?? "");
  const [state, setState] = useState<State>(
    configError ? { kind: "error", msg: configError } : { kind: "idle" },
  );

  // Checksum-aware: normalizeEvmAddress returns the canonical EIP-55 form (or
  // null on a malformed / failed-checksum input), so mixed-case typos reject
  // client-side instead of round-tripping to a 400, and we query the canonical
  // address for exact-match consistency.
  const normalizedWallet = normalizeEvmAddress(wallet.trim());
  const walletValid = normalizedWallet !== null;

  // Tell the drawer there's no proof to approve against (no records, or not yet
  // loaded / errored) so it can keep Approve disabled.
  useEffect(() => {
    const noProof =
      state.kind === "loaded" ? state.records.length === 0 : state.kind !== "loading";
    if (noProof) {
      onCrossCheck?.({ hasProof: false, walletMatch: null, nameConfirmed: false, commonName: "", org: "", country: "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind]);

  const lookup = useCallback(async () => {
    // Defense-in-depth: guard inside the callback too, not just on the button —
    // skip when invalid, misconfigured, or a lookup is already in flight.
    if (!normalizedWallet || configError || state.kind === "loading") return;
    setState({ kind: "loading" });
    try {
      const url = `${PROVER_URL}/api/compliance?wallet=${encodeURIComponent(normalizedWallet)}`;
      const res = await fetch(url, {
        headers: COMPLIANCE_TOKEN ? { "X-Compliance-Token": COMPLIANCE_TOKEN } : undefined,
      });
      if (!res.ok) {
        throw new Error(
          res.status === 400
            ? "Prover rejected the wallet address (400)."
            : res.status === 401 || res.status === 403
              ? "Compliance access denied — check NEXT_PUBLIC_PROVER_COMPLIANCE_TOKEN."
              : `Prover returned ${res.status}.`,
        );
      }
      const body = (await res.json()) as { wallet: string; records?: ComplianceRecord[] };
      setState({ kind: "loaded", wallet: body.wallet ?? normalizedWallet, records: body.records ?? [] });
    } catch (err) {
      setState({ kind: "error", msg: explainError(err) });
    }
  }, [normalizedWallet, state.kind]);

  // Drawer mode: auto-look-up the pinned wallet once on mount (and if it
  // changes between submissions). The standalone page passes no fixedWallet,
  // so this is inert there.
  useEffect(() => {
    if (fixedWallet && normalizeEvmAddress(fixedWallet.trim()) && !configError) {
      void lookup();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixedWallet]);

  return (
    <div className="space-y-4">
      {!fixedWallet && (
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="mb-3 text-xs text-[var(--color-text-muted)]">
          Reads the certificate subject the operator proved to zk-X509 from the prover&apos;s
          compliance API (<code className="font-mono">{PROVER_URL}/api/compliance</code>).
          Compare it against the operator&apos;s KYC video and documents before approving.
        </div>

        <label className="block text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
            Operator wallet
          </span>
          <div className="flex flex-wrap items-center gap-3">
            <input
              className="min-w-[22rem] flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm disabled:opacity-50"
              placeholder="0x…"
              value={wallet}
              disabled={state.kind === "loading" || !!configError}
              onChange={(e) => setWallet(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && state.kind !== "loading" && !configError) void lookup(); }}
            />
            <button
              type="button"
              disabled={!walletValid || state.kind === "loading" || !!configError}
              onClick={() => void lookup()}
              className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {state.kind === "loading" ? "Looking up…" : "Look up"}
            </button>
          </div>
        </label>
        {wallet && !walletValid && (
          <p className="mt-2 text-xs text-[var(--color-danger)]">
            Must be a 0x-prefixed 20-byte address
          </p>
        )}
      </div>
      )}

      {fixedWallet && state.kind === "loading" && (
        <div className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
          Reading the proved certificate subject from zk-X509…
        </div>
      )}

      {state.kind === "error" && (
        <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">
          {state.msg}
        </div>
      )}

      {state.kind === "loaded" && state.records.length === 0 && (
        <div className="rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-4 text-sm">
          <div className="font-medium">No proof on record for this wallet.</div>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            The operator has not completed a zk-X509 proof yet, so there is nothing to
            cross-check. Approve only after a proof appears here.
          </p>
        </div>
      )}

      {state.kind === "loaded" &&
        state.records.map((r, i) => (
          <RecordCard
            key={`${r.nullifier}-${r.timestamp}-${i}`}
            record={r}
            latest={i === 0}
            expectedWallet={fixedWallet}
            onCrossCheck={onCrossCheck}
          />
        ))}
    </div>
  );
}

function RecordCard({
  record: r,
  latest,
  expectedWallet,
  onCrossCheck,
}: {
  record: ComplianceRecord;
  latest: boolean;
  expectedWallet?: string;
  onCrossCheck?: (state: CrossCheckState) => void;
}) {
  const [nameConfirmed, setNameConfirmed] = useState(false);
  // Gate 1 cross-check: the wallet that PROVED the cert must be the same wallet
  // that submitted this KYC. A mismatch means the proof belongs to someone else
  // — do NOT approve.
  const walletMatch =
    expectedWallet && r.registrant
      ? r.registrant.toLowerCase() === expectedWallet.toLowerCase()
      : null;
  // Lift the latest record's cross-check state + proved subject so the drawer
  // can gate Approve and write the proved identity on-chain.
  useEffect(() => {
    if (latest) {
      onCrossCheck?.({
        hasProof: true,
        walletMatch,
        nameConfirmed,
        commonName: r.commonName,
        org: r.org,
        country: r.country,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest, walletMatch, nameConfirmed, r.commonName, r.org, r.country]);
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Proved certificate subject</h3>
        {latest && (
          <span className="rounded-full bg-[var(--color-success-soft)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-success)]">
            latest
          </span>
        )}
        {!r.consentVerified && (
          <span className="rounded-full bg-[var(--color-warning-soft)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-warning)]">
            consent unverified
          </span>
        )}
        <span className="text-xs text-[var(--color-text-subtle)]">· proved {formatDate(r.timestamp)}</span>
      </div>
      {/* The wallet that submitted this proof — must match the KYC submission's
          wallet. Surfaced up top so the admin confirms the proof belongs to the
          operator under review before trusting the subject below. */}
      <div className="mb-3 border-b border-[var(--color-border)] pb-3">
        <dt className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">Proved by wallet</dt>
        <dd className="mt-0.5 break-all font-mono text-xs">{r.registrant || "—"}</dd>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <Row label="Common name" value={r.commonName} />
        <Row label="Organization" value={r.org} />
        <Row label="Org unit" value={r.orgUnit} />
        <Row label="Country" value={r.country} />
        <Row label="Valid until" value={formatDate(r.notAfter)} />
        <Row label="Consent signature" value={r.consentSignature} mono />
      </dl>

      {/* Two cross-checks the admin must confirm before approving (only on the
          latest proof — that's the one approval acts on):
            1. wallet match — automatic (proof's wallet == this KYC submission's)
            2. name match   — manual (admin eyeballs the cert CN against the
               liveness video / ID document above) */}
      {latest && (
        <div className="mt-4 space-y-2 border-t border-[var(--color-border)] pt-3 text-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
            Cross-check before approving
          </div>
          <div className="flex items-start gap-2">
            <span className={walletMatch === true ? "text-[var(--color-success)]" : walletMatch === false ? "text-[var(--color-danger)]" : "text-[var(--color-text-subtle)]"}>
              {walletMatch === true ? "✓" : walletMatch === false ? "✗" : "•"}
            </span>
            <span>
              Proof wallet {walletMatch === true ? "matches" : walletMatch === false ? "does NOT match" : "vs"} the KYC submission&apos;s wallet
              {walletMatch === false && <span className="font-medium text-[var(--color-danger)]"> — do not approve</span>}
            </span>
          </div>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={nameConfirmed}
              onChange={(e) => setNameConfirmed(e.target.checked)}
            />
            <span>
              The certificate <strong>common name</strong> (<span className="font-mono">{r.commonName || "—"}</span>) matches the
              name in the liveness video / ID document above
            </span>
          </label>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">{label}</dt>
      <dd className={`mt-0.5 break-all ${mono ? "font-mono text-xs" : ""}`}>{value || "—"}</dd>
    </div>
  );
}

/** `timestamp`/`notAfter` come from the prover; guard against invalid /
 *  out-of-range values that would make `Date.toISOString()` throw. */
function formatDate(unixSec: number): string {
  const ms = unixSec * 1000;
  if (!Number.isFinite(ms) || ms <= 0 || ms > 8.64e15) return "—";
  return new Date(ms).toISOString().slice(0, 10);
}
