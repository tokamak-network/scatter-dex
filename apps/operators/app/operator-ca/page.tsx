"use client";

/**
 * `/operator-ca` — read-only surface for the Relayer-CA.
 *
 * No `addCa` / `removeCa` writes and no list: the registry slot in
 * `RelayerRegistry.identityRegistry()` is single-valued and governed
 * off this app (multisig / deployer key). The page just shows the
 * current address, the connected operator's verification status, and
 * an outbound link to the CA's registration portal.
 */

import Link from "next/link";
import { useWallet, shortAddr } from "@zkscatter/sdk/react";
import { OperatorIdentityBar } from "../components/OperatorIdentityBar";
import { SectionHeader } from "../components/SectionHeader";
import { Stat } from "../components/Stat";
import {
  useOperatorIdentityStatus,
  useOperatorIdentityRefresh,
  useRelayerCaAddress,
  type OperatorIdentityStatus,
} from "../lib/identity";
import {
  useIssuanceApproval,
  type UseIssuanceApprovalResult,
} from "../lib/useIssuanceApproval";
import { formatIsoDate } from "../lib/format";
import { CA_REGISTRATION_URL, DEMO_NETWORK } from "../lib/network";
import { safeOperatorUrl } from "../lib/operatorDisplay";

// Validate at module load so a misconfigured deployment surfaces the
// failure once (in build/SSR) rather than on every render.
const REGISTRATION_URL = safeOperatorUrl(CA_REGISTRATION_URL);

export default function OperatorCaPage() {
  const { account } = useWallet();
  const caAddress = useRelayerCaAddress();
  const status = useOperatorIdentityStatus();
  const refreshIdentity = useOperatorIdentityRefresh();
  const approval = useIssuanceApproval();

  const explorerUrl = buildExplorerUrl(caAddress);

  return (
    <div className="space-y-10">
      <OperatorIdentityBar />

      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Relayer CA</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
            On-chain certificate authority that verifies operator wallets
            before they can register a relayer. {DEMO_NETWORK.name} uses a
            single Relayer-CA, configured in <code className="font-mono">RelayerRegistry.identityRegistry()</code>.
          </p>
        </div>
        <Link href="/register" className="text-sm text-[var(--color-primary)] hover:underline">
          Register →
        </Link>
      </header>

      <section>
        <SectionHeader title="Active CA" badge="live" />
        {/* Per-wallet verification status lives in the "Your onboarding gates"
            section below (both gates), so this row stays deployment-level. */}
        <div className="grid grid-cols-2 gap-4">
          <Stat
            label="Network"
            value={DEMO_NETWORK.name ?? "—"}
            sub={`Chain ID ${DEMO_NETWORK.chainId}`}
          />
          <Stat
            label="Registry address"
            value={caAddress ? shortAddr(caAddress) : "—"}
            sub={caAddress ? "From RelayerRegistry.identityRegistry()" : "Resolving…"}
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          {explorerUrl ? (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 hover:bg-[var(--color-bg)]"
            >
              View on explorer →
            </a>
          ) : null}
          {REGISTRATION_URL ? (
            <a
              href={REGISTRATION_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 font-medium text-white hover:opacity-90"
            >
              Get verified on the Relayer CA ↗
            </a>
          ) : (
            <span
              className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-1.5 text-[var(--color-text-subtle)]"
              title="Set NEXT_PUBLIC_CA_REGISTRATION_URL to enable this link"
            >
              Registration link not configured
            </span>
          )}
        </div>
      </section>

      <section>
        <SectionHeader
          title="Your onboarding gates"
          badge="live"
          hint="register() requires BOTH"
        />
        {!account ? (
          <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-sm text-[var(--color-text-muted)]">
            Connect your wallet to see your two on-chain onboarding gates.
          </div>
        ) : (
          <div className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
            <GateRow {...gate1(status)} onRetry={refreshIdentity} />
            <GateRow {...gate2(approval)} onRetry={approval.refetch} />
            <p className="border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-text-muted)]">
              <code className="font-mono">RelayerRegistry.register()</code> reverts unless both
              gates are green — the protocol requires zk-X509 verification{" "}
              <strong>and</strong> admin KYC approval.
            </p>
          </div>
        )}
      </section>

      <section>
        <SectionHeader title="How verification works" badge="live" />
        <ol className="list-decimal space-y-2 pl-5 text-sm text-[var(--color-text-muted)]">
          <li>
            Open the Relayer-CA portal and complete the operator KYC / proof
            flow they require (corporate identity, sanctions screen, etc.).
          </li>
          <li>
            The CA submits a verification record on-chain to the
            IdentityRegistry above, stamped with an expiry timestamp.
          </li>
          <li>
            Return to <Link href="/register" className="text-[var(--color-primary)] hover:underline">/register</Link> —
            the pre-flight check will flip green once the chain sees your
            wallet as verified.
          </li>
        </ol>
      </section>
    </div>
  );
}

// uint64.max sentinel from MockIdentityRegistry — production CAs
// return a real timestamp so this branch is dev-only, but treating
// it explicitly here keeps the verified row from rendering "—"
// (which reads like missing data).
const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER;
function formatExpiry(unixSec: number): string {
  if (unixSec <= 0) return "—";
  if (unixSec >= NEVER_EXPIRES) return "no expiry";
  return formatIsoDate(unixSec);
}

/** Build an explorer link for a contract address, mirroring the
 *  `OperatorWalletDropdown` pattern: parse via `URL` so a malformed
 *  env value yields `null` instead of a broken href, and reject any
 *  scheme that isn't http(s). */
function buildExplorerUrl(address: string | null): string | null {
  const base = DEMO_NETWORK.explorerBase;
  if (!base || !address) return null;
  try {
    const u = new URL(`/address/${encodeURIComponent(address)}`, base);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

type GateState = "ok" | "bad" | "pending" | "error";

/** One onboarding-gate row: ✓ (satisfied) / ✗ (blocked) / ⚠ (lookup failed) /
 *  • (resolving). On `error` (an RPC/config failure, distinct from a valid
 *  negative status) a Retry re-runs the on-chain lookup. */
function GateRow({
  state,
  label,
  detail,
  onRetry,
}: {
  state: GateState;
  label: string;
  detail: string;
  onRetry?: () => void;
}) {
  const icon = state === "ok" ? "✓" : state === "bad" ? "✗" : state === "error" ? "⚠" : "•";
  const color =
    state === "ok"
      ? "text-[var(--color-success)]"
      : state === "bad"
        ? "text-[var(--color-danger)]"
        : state === "error"
          ? "text-[var(--color-warning)]"
          : "text-[var(--color-text-subtle)]";
  return (
    <div className="flex items-start gap-3">
      <span className={`mt-0.5 text-base font-semibold ${color}`}>{icon}</span>
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{detail}</div>
        {state === "error" && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 py-0.5 text-xs font-medium hover:bg-[var(--color-bg)]"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

/** Gate 1 — zk-X509 verification (RelayerRegistry.identityRegistry().isVerified). */
function gate1(status: OperatorIdentityStatus): { state: GateState; label: string; detail: string } {
  const label = "zk-X509 verification";
  switch (status.kind) {
    case "verified":
      return { state: "ok", label, detail: `Verified · valid until ${formatExpiry(status.verifiedUntil)}` };
    case "expired":
      return { state: "bad", label, detail: `Expired ${formatExpiry(status.verifiedUntil)} — re-prove your certificate` };
    case "unverified":
      return { state: "bad", label, detail: "Prove your accredited certificate to the Relayer CA" };
    case "no-registry":
      return { state: "pending", label, detail: "Relayer identity registry not configured" };
    case "error":
      return { state: "error", label, detail: status.message };
    case "loading":
    default:
      return { state: "pending", label, detail: "Reading on-chain…" };
  }
}

/** Gate 2 — admin KYC approval (IssuanceApprovalRegistry.isApproved). */
function gate2(approval: UseIssuanceApprovalResult): { state: GateState; label: string; detail: string } {
  const label = "Admin KYC approval";
  switch (approval.status) {
    case "approved":
      return { state: "ok", label, detail: "Your wallet is approved on-chain" };
    case "not-approved":
      return { state: "bad", label, detail: "Submit KYC — an admin approves your wallet on-chain" };
    case "revoked":
      return { state: "bad", label, detail: `Revoked${approval.revokeReason ? ` — ${approval.revokeReason}` : ""}` };
    case "expired":
      return { state: "bad", label, detail: "Approval expired — ask the admin to re-approve" };
    case "error":
      return { state: "error", label, detail: approval.message ?? "Lookup failed" };
    case "idle":
      return { state: "pending", label, detail: "Approval registry not configured" };
    case "checking":
    default:
      return { state: "pending", label, detail: "Reading on-chain…" };
  }
}

