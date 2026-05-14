"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ethers } from "ethers";
import { useWallet, shortAddr } from "@zkscatter/sdk/react";
import { IDENTITY_GATE_ABI, type NetworkConfig } from "@zkscatter/sdk";
import { getNetworkConfig } from "../../_lib/network";
import { useIdentityGateAdmin } from "../../_lib/identity";
import { ZK_X509_URL } from "../../_lib/features";

/** Build a per-registry deep-link to the external zk-X509 console.
 *  Returns null when the deploy didn't configure
 *  `NEXT_PUBLIC_PAY_ZK_X509_URL`, in which case we omit the link
 *  rather than dangling a broken target. */
function zkX509RegistryUrl(address: string): string | null {
  if (!ZK_X509_URL) return null;
  try {
    const url = new URL(
      `${ZK_X509_URL.replace(/\/$/, "")}/registry/${encodeURIComponent(address)}`,
    );
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function explorerTxLink(
  cfg: NetworkConfig,
  txHash: string,
): string | null {
  const base = cfg.explorerBase;
  if (!base) return null;
  try {
    const u = new URL(base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${base.replace(/\/$/, "")}/tx/${txHash}`;
  } catch {
    return null;
  }
}

/** Admin console for the IdentityGate contract — list trusted
 *  IdentityRegistry contracts, add / remove them. Read-only for
 *  non-owners (the page still renders so anyone can audit which
 *  registries the deployment trusts). */
export default function AdminIdentityPage() {
  const { account, signer, connect } = useWallet();
  const { snapshot, loading, error, refresh } = useIdentityGateAdmin();
  const cfg = getNetworkConfig();
  const gate = cfg.contracts.identityGate;
  const isOwner =
    !!account &&
    !!snapshot &&
    account.toLowerCase() === snapshot.owner.toLowerCase();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Identity authorities (admin)</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          IdentityGate owner can add or remove trusted{" "}
          <code className="font-mono">IdentityRegistry</code> contracts. Non-
          owners can still view this page for auditing — actions are disabled.
        </p>
      </div>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <h2 className="text-base font-medium">Permission</h2>
        <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-[var(--color-text-muted)]">IdentityGate</dt>
          <dd className="font-mono text-xs">{gate || "—"}</dd>
          <dt className="text-[var(--color-text-muted)]">Owner</dt>
          <dd className="font-mono text-xs">
            {snapshot ? snapshot.owner : loading ? "…" : "—"}
          </dd>
          <dt className="text-[var(--color-text-muted)]">Connected</dt>
          <dd className="font-mono text-xs">{account ?? "—"}</dd>
        </dl>
        <div className="mt-3 text-sm">
          {!account ? (
            <button
              onClick={() => void connect()}
              className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--color-primary-hover)]"
            >
              Connect wallet
            </button>
          ) : loading && !snapshot ? (
            <span className="text-[var(--color-text-muted)]">
              ⏳ Checking ownership…
            </span>
          ) : isOwner ? (
            <span className="text-[var(--color-success)]">
              ✓ You are the gate owner — admin actions enabled.
            </span>
          ) : (
            <span className="text-[var(--color-warning)]">
              ⚠ Connected wallet is not the gate owner — read-only mode.
            </span>
          )}
        </div>
        {error && (
          <div className="mt-3 rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-2 text-xs text-[var(--color-warning)]">
            {error}
          </div>
        )}
      </section>

      <RegistriesSection
        registries={snapshot?.registries ?? []}
        isOwner={isOwner}
        signer={signer}
        gate={gate}
        refresh={refresh}
        loading={loading}
      />

      <AddRegistrySection
        isOwner={isOwner}
        signer={signer}
        gate={gate}
        existing={snapshot?.registries ?? []}
        onAdded={refresh}
      />

      <div className="text-xs">
        <Link
          href="/identity"
          className="text-[var(--color-primary)] hover:underline"
        >
          ← Back to user identity status
        </Link>
      </div>
    </div>
  );
}

function RegistriesSection({
  registries,
  isOwner,
  signer,
  gate,
  refresh,
  loading,
}: {
  registries: string[];
  isOwner: boolean;
  signer: ethers.Signer | null;
  gate: string;
  refresh: () => void;
  loading: boolean;
}) {
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium">
          Trusted registries ({registries.length})
        </h2>
        <button
          onClick={refresh}
          className="rounded-md border border-[var(--color-border-strong)] px-3 py-1 text-xs hover:bg-[var(--color-primary-soft)]"
        >
          Refresh
        </button>
      </div>
      {loading && registries.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-text-muted)]">Loading…</p>
      ) : registries.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-text-muted)]">
          No registries in this gate yet.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {registries.map((addr) => (
            <RegistryRow
              key={addr}
              address={addr}
              isOwner={isOwner}
              signer={signer}
              gate={gate}
              onRemoved={refresh}
              canRemove={registries.length > 1}
            />
          ))}
        </ul>
      )}
      {registries.length === 1 && (
        <p className="mt-3 text-[10px] text-[var(--color-text-subtle)]">
          IdentityGate refuses to drop its last registry; add a new one before
          removing this row.
        </p>
      )}
    </section>
  );
}

function RegistryRow({
  address,
  isOwner,
  signer,
  gate,
  onRemoved,
  canRemove,
}: {
  address: string;
  isOwner: boolean;
  signer: ethers.Signer | null;
  gate: string;
  onRemoved: () => void;
  canRemove: boolean;
}) {
  const cfg = useMemo(() => getNetworkConfig(), []);
  const gateWriter = useMemo(
    () =>
      signer && gate
        ? new ethers.Contract(gate, IDENTITY_GATE_ABI, signer)
        : null,
    [signer, gate],
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [doneTx, setDoneTx] = useState<string | null>(null);
  async function remove() {
    // `isOwner` is also enforced via the button's `disabled`, but
    // double-check here so a programmatic click path can't slip
    // past — the on-chain `OnlyOwner` would still revert, but we
    // skip the wallet popup + tx submission.
    if (!gateWriter || !isOwner) return;
    setBusy(true);
    setErr(null);
    setDoneTx(null);
    try {
      const tx = await gateWriter.removeRegistry(address);
      await tx.wait();
      setDoneTx(tx.hash);
      onRemoved();
    } catch (e) {
      setErr(clampError(e));
    } finally {
      setBusy(false);
    }
  }
  const zkUrl = zkX509RegistryUrl(address);
  return (
    <li className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs">{address}</span>
          {zkUrl && (
            <a
              href={zkUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open this registry's detail page on zk-X509 (new tab)"
              className="text-[10px] text-[var(--color-primary)] underline-offset-2 hover:underline"
            >
              View on zk-X509 ↗
            </a>
          )}
        </div>
        <button
          onClick={() => void remove()}
          disabled={!isOwner || busy || !canRemove}
          title={
            !isOwner
              ? "Owner-only"
              : !canRemove
                ? "Cannot remove the last registry"
                : undefined
          }
          className="rounded border border-[var(--color-border-strong)] px-2 py-1 text-xs hover:bg-[var(--color-warning-soft)] disabled:opacity-40"
        >
          {busy ? "Removing…" : "Remove"}
        </button>
      </div>
      {doneTx && <TxLine cfg={cfg} txHash={doneTx} verb="Removed" />}
      {err && (
        <div className="mt-2 text-xs text-[var(--color-warning)]">{err}</div>
      )}
    </li>
  );
}

function AddRegistrySection({
  isOwner,
  signer,
  gate,
  existing,
  onAdded,
}: {
  isOwner: boolean;
  signer: ethers.Signer | null;
  gate: string;
  existing: string[];
  onAdded: () => void;
}) {
  const cfg = useMemo(() => getNetworkConfig(), []);
  const gateWriter = useMemo(
    () =>
      signer && gate
        ? new ethers.Contract(gate, IDENTITY_GATE_ABI, signer)
        : null,
    [signer, gate],
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [doneTx, setDoneTx] = useState<string | null>(null);
  const trimmed = input.trim();
  const valid = ethers.isAddress(trimmed);
  const duplicate =
    valid && existing.some((a) => a.toLowerCase() === trimmed.toLowerCase());

  async function add() {
    // `isOwner` enforced visually via the button's `disabled`,
    // but mirror the check here for the same reason as remove()
    // — keeps programmatic dispatches from hitting the wallet
    // popup just to be rejected on-chain.
    if (!gateWriter || !valid || duplicate || !isOwner) return;
    setBusy(true);
    setErr(null);
    setDoneTx(null);
    try {
      const tx = await gateWriter.addRegistry(trimmed);
      await tx.wait();
      setDoneTx(tx.hash);
      setInput("");
      onAdded();
    } catch (e) {
      setErr(clampError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium">Add a registry</h2>
        {ZK_X509_URL && (
          <a
            href={ZK_X509_URL}
            target="_blank"
            rel="noopener noreferrer"
            title="Open the zk-X509 console (new tab)"
            className="text-xs text-[var(--color-primary)] hover:underline"
          >
            zk-X509 console ↗
          </a>
        )}
      </div>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
        Paste a deployed{" "}
        <code className="font-mono">IdentityRegistry</code> contract address to
        include it in this gate. The gate ORs each registry's{" "}
        <code className="font-mono">isVerified</code> result.
      </p>
      <div className="mt-3 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="0x…"
          className="flex-1 rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono text-xs"
        />
        <button
          onClick={() => void add()}
          disabled={!isOwner || busy || !valid || duplicate}
          title={
            !isOwner
              ? "Owner-only"
              : !valid && input.length > 0
                ? "Not a valid address"
                : duplicate
                  ? "Already in this gate"
                  : undefined
          }
          className="rounded-md bg-[var(--color-primary)] px-3 py-2 text-xs font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-40"
        >
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
      {input.length > 0 && !valid && (
        <div className="mt-2 text-xs text-[var(--color-warning)]">
          Not a valid 0x address.
        </div>
      )}
      {valid && duplicate && (
        <div className="mt-2 text-xs text-[var(--color-warning)]">
          {shortAddr(trimmed)} is already in this gate.
        </div>
      )}
      {doneTx && <TxLine cfg={cfg} txHash={doneTx} verb="Added" />}
      {err && (
        <div className="mt-2 text-xs text-[var(--color-warning)]">{err}</div>
      )}
    </section>
  );
}

function TxLine({
  cfg,
  txHash,
  verb,
}: {
  cfg: NetworkConfig;
  txHash: string;
  verb: string;
}) {
  const url = explorerTxLink(cfg, txHash);
  return (
    <div className="mt-2 text-xs text-[var(--color-success)]">
      ✓ {verb} ·{" "}
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono underline-offset-2 hover:underline"
        >
          {shortAddr(txHash)} ↗
        </a>
      ) : (
        <span className="font-mono">{shortAddr(txHash)}</span>
      )}
    </div>
  );
}

/** Clamp ethers error message to a single line so a multi-page
 *  RPC trace doesn't blow out the admin panel layout. The first
 *  line carries the actionable revert reason; details still log
 *  to the browser console via ethers' own logger. */
function clampError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const firstLine = raw.split("\n", 1)[0] ?? raw;
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
}
