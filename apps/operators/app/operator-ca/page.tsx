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
  useRelayerCaAddress,
  type OperatorIdentityStatus,
} from "../lib/identity";
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
        <div className="grid grid-cols-3 gap-4">
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
          <Stat
            label="Your status"
            value={statusLabel(status)}
            sub={statusSub(status, account)}
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

function statusLabel(status: OperatorIdentityStatus): string {
  switch (status.kind) {
    case "verified":
      return "Verified";
    case "expired":
      return "Expired";
    case "unverified":
      return "Not verified";
    case "unconnected":
      return "Wallet not connected";
    case "no-registry":
      return "Registry not configured";
    case "error":
      return "Lookup failed";
    case "loading":
    default:
      return "…";
  }
}

function statusSub(status: OperatorIdentityStatus, account: string | null): string {
  switch (status.kind) {
    case "verified":
      return `Valid until ${formatExpiry(status.verifiedUntil)}`;
    case "expired":
      return `Re-verify — expired ${formatExpiry(status.verifiedUntil)}`;
    case "unverified":
      return account ? "Click the button below to start" : "Connect a wallet first";
    case "unconnected":
      return "Connect to see your verification";
    case "no-registry":
      return "RelayerRegistry env address is unset";
    case "error":
      return status.message;
    case "loading":
    default:
      return "Reading on-chain…";
  }
}

function formatExpiry(unixSec: number): string {
  return unixSec > 0 ? formatIsoDate(unixSec) : "—";
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

