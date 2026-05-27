"use client";

/**
 * `/admin/issuance` — owner-only console for IssuanceApprovalRegistry.
 *
 * Operators submit their KYC docs + EVM address OFF-CHAIN (email,
 * memo, in-person). The admin reviews offline, then comes here to:
 *  1. Approve the operator wallet (records CN/O/C/validityDays on
 *     chain so the operator's /register Step 1 surfaces the metadata).
 *  2. Look up any wallet's current status.
 *  3. Revoke an approval (with reason — written to chain so audit
 *     log shows why).
 *  4. Review the full event history of approvals + revocations.
 *
 * Non-owner visitors can read everything (audit transparency) but
 * every mutating button is disabled.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ethers } from "ethers";
import { useWallet, shortAddr } from "@zkscatter/sdk/react";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { DEMO_NETWORK } from "../../lib/network";
import { useIsIssuanceRegistryAdmin } from "../../lib/identity";
import { SectionHeader } from "../../components/SectionHeader";
import { Stat } from "../../components/Stat";
import { formatIsoDate } from "../../lib/format";

const ABI = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "commonName", type: "string" },
      { name: "organization", type: "string" },
      { name: "country", type: "string" },
      { name: "validityDays", type: "uint32" },
      { name: "expiresAt", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revoke",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "reason", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "approvals",
    stateMutability: "view",
    inputs: [{ name: "operator", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "commonName", type: "string" },
          { name: "organization", type: "string" },
          { name: "country", type: "string" },
          { name: "validityDays", type: "uint32" },
          { name: "approvedBy", type: "address" },
          { name: "approvedAt", type: "uint64" },
          { name: "expiresAt", type: "uint64" },
          { name: "revoked", type: "bool" },
          { name: "revokeReason", type: "string" },
          { name: "revokedAt", type: "uint64" },
        ],
      },
    ],
  },
  // Events — surfaced in the history list.
  "event ApprovalRecorded(address indexed operator, string commonName, string organization, string country, uint32 validityDays, address indexed approvedBy, uint64 approvedAt, uint64 expiresAt)",
  "event ApprovalRevoked(address indexed operator, address indexed revokedBy, uint64 revokedAt, string reason)",
] as const;

type HistoryEntry =
  | {
      kind: "approved";
      operator: string;
      commonName: string;
      organization: string;
      country: string;
      validityDays: number;
      approvedBy: string;
      approvedAt: number;
      expiresAt: number;
      txHash: string;
      blockNumber: number;
    }
  | {
      kind: "revoked";
      operator: string;
      revokedBy: string;
      revokedAt: number;
      reason: string;
      txHash: string;
      blockNumber: number;
    };

export default function AdminIssuancePage() {
  const { account, signer, connect, readProvider } = useWallet();
  const isAdmin = useIsIssuanceRegistryAdmin();
  const registry = DEMO_NETWORK.contracts.issuanceApprovalRegistry;
  const deployed = !!registry && isConfiguredAddress(registry);

  const readContract = useMemo(
    () => (deployed && registry ? new ethers.Contract(registry, ABI, readProvider) : null),
    [registry, deployed, readProvider],
  );
  const writeContract = useMemo(
    () => (deployed && registry && signer ? new ethers.Contract(registry, ABI, signer) : null),
    [registry, deployed, signer],
  );

  // ── Event history ────────────────────────────────────────
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const refreshHistory = useCallback(async () => {
    if (!readContract) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const [approvedLogs, revokedLogs] = await Promise.all([
        readContract.queryFilter(readContract.filters.ApprovalRecorded()),
        readContract.queryFilter(readContract.filters.ApprovalRevoked()),
      ]);
      const merged: HistoryEntry[] = [];
      for (const e of approvedLogs) {
        const ev = e as ethers.EventLog;
        if (!ev.args) continue;
        merged.push({
          kind: "approved",
          operator: String(ev.args[0]).toLowerCase(),
          commonName: ev.args[1],
          organization: ev.args[2],
          country: ev.args[3],
          validityDays: Number(ev.args[4]),
          approvedBy: String(ev.args[5]).toLowerCase(),
          approvedAt: Number(ev.args[6]),
          expiresAt: Number(ev.args[7]),
          txHash: ev.transactionHash,
          blockNumber: ev.blockNumber,
        });
      }
      for (const e of revokedLogs) {
        const ev = e as ethers.EventLog;
        if (!ev.args) continue;
        merged.push({
          kind: "revoked",
          operator: String(ev.args[0]).toLowerCase(),
          revokedBy: String(ev.args[1]).toLowerCase(),
          revokedAt: Number(ev.args[2]),
          reason: ev.args[3],
          txHash: ev.transactionHash,
          blockNumber: ev.blockNumber,
        });
      }
      // Newest first by block + within block by event order.
      merged.sort((a, b) => b.blockNumber - a.blockNumber);
      setHistory(merged);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err));
    } finally {
      setHistoryLoading(false);
    }
  }, [readContract]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <Link href="/" className="text-xs text-[var(--color-text-muted)] hover:underline">
          ← Back
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Issuance approvals (admin)</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Owner-controlled approval gate. Records that an operator wallet has
          passed off-chain KYC and is cleared to receive a Relayer-CA
          certificate. Non-owners see read-only history.
        </p>
      </header>

      {!deployed && (
        <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs">
          <code className="font-mono">IssuanceApprovalRegistry</code> not
          configured on {DEMO_NETWORK.name ?? "this network"}. Set{" "}
          <code className="font-mono">NEXT_PUBLIC_ISSUANCE_APPROVAL_REGISTRY_ADDRESS</code>{" "}
          in your operators app env to enable this page.
        </div>
      )}

      {deployed && !account && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-sm">
          <button
            onClick={connect}
            className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            Connect wallet
          </button>
          <span className="ml-3 text-[var(--color-text-muted)]">
            to see your role + the approval history.
          </span>
        </div>
      )}

      {deployed && (
        <>
          <section>
            <SectionHeader title="Role" badge="live" />
            <div className="grid grid-cols-3 gap-4">
              <Stat
                label="Network"
                value={DEMO_NETWORK.name ?? "—"}
                sub={`Chain ID ${DEMO_NETWORK.chainId}`}
              />
              <Stat
                label="Registry"
                value={shortAddr(registry!)}
                sub="IssuanceApprovalRegistry"
              />
              <Stat
                label="Your role"
                value={
                  isAdmin === null
                    ? "…"
                    : isAdmin
                      ? "Admin (owner)"
                      : "Read-only"
                }
                sub={isAdmin ? "Can approve / revoke" : "Mutations disabled"}
              />
            </div>
          </section>

          <ApproveForm
            writeContract={writeContract}
            isAdmin={!!isAdmin}
            onSuccess={refreshHistory}
          />

          <LookupCard
            readContract={readContract}
            writeContract={writeContract}
            isAdmin={!!isAdmin}
            onSuccess={refreshHistory}
          />

          <section>
            <div className="mb-3 flex items-baseline justify-between">
              <SectionHeader title="Event history" badge="live" />
              <button
                type="button"
                onClick={() => void refreshHistory()}
                disabled={historyLoading}
                className="text-xs text-[var(--color-primary)] hover:underline disabled:opacity-50"
              >
                {historyLoading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            {historyError && (
              <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-3 text-xs text-[var(--color-danger)]">
                {historyError}
              </div>
            )}
            <HistoryList entries={history} />
          </section>
        </>
      )}
    </div>
  );
}

// ─── Approve form ──────────────────────────────────────────────────

function ApproveForm({
  writeContract,
  isAdmin,
  onSuccess,
}: {
  writeContract: ethers.Contract | null;
  isAdmin: boolean;
  onSuccess: () => void;
}) {
  const [operator, setOperator] = useState("");
  const [cn, setCn] = useState("");
  const [org, setOrg] = useState("");
  const [country, setCountry] = useState("");
  const [validity, setValidity] = useState("365");
  const [expiresAt, setExpiresAt] = useState("0");
  const [phase, setPhase] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const valid =
    ethers.isAddress(operator) &&
    cn.trim().length > 0 &&
    org.trim().length > 0 &&
    country.trim().length === 2 &&
    Number(validity) > 0 &&
    Number(validity) <= 3650 &&
    !Number.isNaN(Number(expiresAt));

  const submit = async () => {
    if (!writeContract || !valid) return;
    setError(null);
    setTxHash(null);
    setPhase("submitting");
    try {
      const tx = await writeContract.approve(
        operator.trim(),
        cn.trim(),
        org.trim(),
        country.trim().toUpperCase(),
        Number(validity),
        BigInt(expiresAt),
      );
      const receipt = await tx.wait();
      setTxHash(receipt?.hash ?? tx.hash);
      setPhase("done");
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  };

  const disabled = !isAdmin || !writeContract || !valid || phase === "submitting";

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <h2 className="mb-1 font-semibold">Approve a new operator</h2>
      <p className="mb-4 text-xs text-[var(--color-text-muted)]">
        Records on-chain that this wallet passed off-chain KYC. The operators
        app reads it to surface a tailored &quot;Get your cert&quot; CTA.
      </p>

      <div className="grid grid-cols-2 gap-4 text-sm">
        <Field label="Operator wallet (EVM)">
          <input
            type="text"
            value={operator}
            onChange={(e) => setOperator(e.target.value)}
            placeholder="0x…"
            className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono text-xs"
          />
        </Field>
        <Field label="Common name (CN)">
          <input
            type="text"
            value={cn}
            onChange={(e) => setCn(e.target.value)}
            placeholder="ops@example.com"
            maxLength={128}
            className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Organisation (O)">
          <input
            type="text"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            placeholder="Tokamak Network"
            maxLength={128}
            className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Country (C, ISO-3166 alpha-2)">
          <input
            type="text"
            value={country}
            onChange={(e) => setCountry(e.target.value.toUpperCase())}
            placeholder="KR"
            maxLength={2}
            className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm uppercase"
          />
        </Field>
        <Field label="Validity (days, 1..3650)">
          <input
            type="number"
            value={validity}
            onChange={(e) => setValidity(e.target.value)}
            min={1}
            max={3650}
            className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Expires at (unix sec, 0 = no expiry)">
          <input
            type="number"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            min={0}
            className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
          />
        </Field>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-3 text-xs text-[var(--color-danger)]">
          {error}
        </div>
      )}
      {phase === "done" && txHash && (
        <div className="mt-4 rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] p-3 text-xs">
          <div className="font-medium text-[var(--color-success)]">Approved.</div>
          <div className="mt-1 break-all font-mono text-[var(--color-text-muted)]">
            {txHash}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={disabled}
        className="mt-5 rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        title={
          !isAdmin
            ? "Only the registry owner can approve"
            : !valid
              ? "Fill every field correctly"
              : undefined
        }
      >
        {phase === "submitting" ? "Submitting…" : "Approve on-chain"}
      </button>
    </section>
  );
}

// ─── Lookup + per-wallet revoke ────────────────────────────────────

function LookupCard({
  readContract,
  writeContract,
  isAdmin,
  onSuccess,
}: {
  readContract: ethers.Contract | null;
  writeContract: ethers.Contract | null;
  isAdmin: boolean;
  onSuccess: () => void;
}) {
  const [wallet, setWallet] = useState("");
  const [result, setResult] = useState<null | {
    approvedAt: number;
    commonName: string;
    organization: string;
    country: string;
    validityDays: number;
    approvedBy: string;
    expiresAt: number;
    revoked: boolean;
    revokeReason: string;
    revokedAt: number;
  }>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [busy, setBusy] = useState<"" | "lookup" | "revoke">("");

  const lookup = async () => {
    if (!readContract || !ethers.isAddress(wallet)) {
      setError("Enter a valid EVM address.");
      return;
    }
    setError(null);
    setBusy("lookup");
    try {
      const raw = await readContract.approvals(wallet);
      setResult({
        commonName: raw.commonName,
        organization: raw.organization,
        country: raw.country,
        validityDays: Number(raw.validityDays),
        approvedBy: String(raw.approvedBy).toLowerCase(),
        approvedAt: Number(raw.approvedAt),
        expiresAt: Number(raw.expiresAt),
        revoked: raw.revoked,
        revokeReason: raw.revokeReason,
        revokedAt: Number(raw.revokedAt),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };

  const revoke = async () => {
    if (!writeContract || !ethers.isAddress(wallet)) return;
    setError(null);
    setBusy("revoke");
    try {
      const tx = await writeContract.revoke(wallet.trim(), revokeReason.trim());
      await tx.wait();
      setRevokeReason("");
      await lookup();
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };

  const canRevoke =
    isAdmin && !!writeContract && !!result && result.approvedAt > 0 && !result.revoked;

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <h2 className="mb-1 font-semibold">Look up / revoke</h2>
      <p className="mb-4 text-xs text-[var(--color-text-muted)]">
        Check any wallet&apos;s current state and revoke an approval if needed.
      </p>

      <div className="flex items-stretch gap-2 text-sm">
        <input
          type="text"
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
          placeholder="0x…"
          className="flex-1 rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono text-xs"
        />
        <button
          type="button"
          onClick={() => void lookup()}
          disabled={!readContract || !!busy || !ethers.isAddress(wallet)}
          className="rounded-md border border-[var(--color-primary)] bg-white px-3 py-2 text-xs font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary-soft)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === "lookup" ? "Looking up…" : "Look up"}
        </button>
      </div>

      {error && (
        <div className="mt-3 rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-3 text-xs text-[var(--color-danger)]">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-4 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs">
          {result.approvedAt === 0 ? (
            <div className="text-[var(--color-text-muted)]">
              No approval on file for this wallet.
            </div>
          ) : (
            <>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                <dt className="text-[var(--color-text-muted)]">CN</dt>
                <dd className="font-mono">{result.commonName}</dd>
                <dt className="text-[var(--color-text-muted)]">O / C</dt>
                <dd>{result.organization} · {result.country}</dd>
                <dt className="text-[var(--color-text-muted)]">Validity</dt>
                <dd>{result.validityDays} days</dd>
                <dt className="text-[var(--color-text-muted)]">Approved by</dt>
                <dd className="font-mono">{shortAddr(result.approvedBy)}</dd>
                <dt className="text-[var(--color-text-muted)]">Approved at</dt>
                <dd>{formatIsoDate(result.approvedAt)}</dd>
                <dt className="text-[var(--color-text-muted)]">Expires at</dt>
                <dd>{result.expiresAt === 0 ? "no expiry" : formatIsoDate(result.expiresAt)}</dd>
                {result.revoked && (
                  <>
                    <dt className="text-[var(--color-danger)]">Revoked</dt>
                    <dd>
                      {formatIsoDate(result.revokedAt)} — {result.revokeReason || "(no reason)"}
                    </dd>
                  </>
                )}
              </dl>

              {canRevoke && (
                <div className="mt-4 border-t border-[var(--color-border)] pt-3">
                  <div className="mb-2 text-[var(--color-text-muted)]">Revoke this approval</div>
                  <div className="flex items-stretch gap-2">
                    <input
                      type="text"
                      value={revokeReason}
                      onChange={(e) => setRevokeReason(e.target.value)}
                      placeholder="Reason (recorded on-chain)"
                      maxLength={256}
                      className="flex-1 rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => void revoke()}
                      disabled={!!busy}
                      className="rounded-md bg-[var(--color-danger)] px-3 py-2 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {busy === "revoke" ? "Revoking…" : "Revoke"}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ─── History list ──────────────────────────────────────────────────

function HistoryList({ entries }: { entries: HistoryEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[var(--color-border)] p-6 text-center text-xs text-[var(--color-text-muted)]">
        No approval events yet.
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {entries.map((e) => (
        <li
          key={`${e.txHash}:${e.kind}`}
          className={`rounded-md border p-3 text-xs ${
            e.kind === "approved"
              ? "border-[var(--color-success)] bg-[var(--color-success-soft)]"
              : "border-[var(--color-danger)] bg-[var(--color-danger-soft)]"
          }`}
        >
          {e.kind === "approved" ? (
            <>
              <div className="font-medium text-[var(--color-success)]">
                Approved <span className="font-mono">{shortAddr(e.operator)}</span>
              </div>
              <div className="mt-1 text-[var(--color-text-muted)]">
                CN <span className="font-mono">{e.commonName}</span> · O {e.organization} · C {e.country} · {e.validityDays}d
              </div>
              <div className="mt-0.5 text-[var(--color-text-muted)]">
                by <span className="font-mono">{shortAddr(e.approvedBy)}</span> at {formatIsoDate(e.approvedAt)}
                {e.expiresAt !== 0 && ` · expires ${formatIsoDate(e.expiresAt)}`}
              </div>
            </>
          ) : (
            <>
              <div className="font-medium text-[var(--color-danger)]">
                Revoked <span className="font-mono">{shortAddr(e.operator)}</span>
              </div>
              <div className="mt-1 text-[var(--color-text-muted)]">
                Reason: {e.reason || "(none)"}
              </div>
              <div className="mt-0.5 text-[var(--color-text-muted)]">
                by <span className="font-mono">{shortAddr(e.revokedBy)}</span> at {formatIsoDate(e.revokedAt)}
              </div>
            </>
          )}
          <div className="mt-1 break-all font-mono text-[10px] text-[var(--color-text-subtle)]">
            tx {e.txHash}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--color-text-subtle)]">
        {label}
      </label>
      {children}
    </div>
  );
}
