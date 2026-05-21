"use client";

import { useCallback, useEffect, useState } from "react";
import { Contract, type Signer } from "ethers";
import { ZERO_ADDRESS, eqAddr } from "@zkscatter/sdk";
import { shortAddr, useMounted, useWallet } from "@zkscatter/sdk/react";
import { AdminWriteCard } from "../../components/AdminWriteCard";
import { isValidEvmAddress } from "../../lib/x509";

const ABI = [
  "function authorizedSettlement() external view returns (address)",
  "function pendingSettlement() external view returns (address)",
  "function pendingSettlementActivateAt() external view returns (uint256)",
  "function queueSetAuthorizedSettlement(address _settlement) external",
  "function activateAuthorizedSettlement() external",
  "function setAuthorizedSettlement(address _settlement) external",
];

interface Snapshot {
  authorized: string | null;
  pending: string | null;
  activateAt: bigint | null;
  loaded: boolean;
}

const EMPTY: Snapshot = { authorized: null, pending: null, activateAt: null, loaded: false };

export function SettlementQueue({ address }: { address: string }) {
  const { signer, readProvider } = useWallet();
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [input, setInput] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const mounted = useMounted();
  // Tick once per second so the countdown stays live without
  // re-fetching state every tick. Stops once the timelock elapses.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!mounted) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [mounted]);

  useEffect(() => {
    let cancelled = false;
    const c = new Contract(address, ABI, readProvider);
    void Promise.allSettled([
      c.authorizedSettlement() as Promise<string>,
      c.pendingSettlement() as Promise<string>,
      c.pendingSettlementActivateAt() as Promise<bigint>,
    ]).then(([a, p, t]) => {
      if (cancelled) return;
      setSnap({
        authorized: a.status === "fulfilled" ? a.value : null,
        pending: p.status === "fulfilled" ? p.value : null,
        activateAt: t.status === "fulfilled" ? t.value : null,
        loaded: true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [address, readProvider, reloadKey]);

  const trimmed = input.trim();
  const validAddr = isValidEvmAddress(trimmed) && !eqAddr(trimmed, ZERO_ADDRESS);

  const queue = useCallback(async () => {
    if (!signer || !validAddr) throw new Error("Invalid input");
    return invoke1(signer, address, "queueSetAuthorizedSettlement", trimmed);
  }, [signer, validAddr, address, trimmed]);

  const activate = useCallback(async () => {
    if (!signer) throw new Error("Wallet not connected");
    return invoke0(signer, address, "activateAuthorizedSettlement");
  }, [signer, address]);

  const setDirect = useCallback(async () => {
    if (!signer || !validAddr) throw new Error("Invalid input");
    return invoke1(signer, address, "setAuthorizedSettlement", trimmed);
  }, [signer, validAddr, address, trimmed]);

  const reload = () => {
    setInput("");
    setReloadKey((k) => k + 1);
  };

  // Four flows depending on current state:
  // 1. authorized == 0x0 → setAuthorizedSettlement (direct, one-time init)
  // 2. pending != 0x0 + timelock elapsed → activateAuthorizedSettlement
  // 3. pending != 0x0 + timelock pending → wait (show countdown)
  // 4. authorized != 0x0 + no pending → queueSetAuthorizedSettlement (timelocked)
  //
  // We treat failed reads as "unknown" and gate every action on a
  // successful read so a transient RPC error can't push us into the
  // init path when an authorized settlement already exists on-chain.
  const noAuthorized =
    snap.loaded && snap.authorized != null && eqAddr(snap.authorized, ZERO_ADDRESS);
  const hasPending =
    snap.loaded && snap.pending != null && !eqAddr(snap.pending, ZERO_ADDRESS);
  const readsOk = snap.loaded && snap.authorized != null && snap.pending != null;
  const activateAtSec = snap.activateAt != null ? Number(snap.activateAt) : 0;
  const now = Math.floor(Date.now() / 1000);
  const timelockReady = mounted && hasPending && activateAtSec > 0 && now >= activateAtSec;
  const timelockRemaining = Math.max(0, activateAtSec - now);

  return (
    <div className="space-y-4">
      <StateBanner snap={snap} mounted={mounted} timelockRemaining={timelockRemaining} />

      {snap.loaded && !readsOk && (
        <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-3 text-xs text-[var(--color-danger)]">
          Failed to read current settlement state from the chain. Actions are disabled until
          the reads succeed — refresh to retry.
        </div>
      )}

      {readsOk && noAuthorized && (
        <AdminWriteCard
          title="Initialise authorized settlement (one-time)"
          description="CommitmentPool.setAuthorizedSettlement(address). Bypasses the timelock — only callable while authorizedSettlement is the zero address (initial deploy)."
          submitLabel="Initialise"
          disabled={!validAddr}
          onSubmit={setDirect}
          onSuccess={reload}
        >
          <SettlementInput input={input} onChange={setInput} />
        </AdminWriteCard>
      )}

      {readsOk && !noAuthorized && !hasPending && (
        <AdminWriteCard
          title="Queue new authorized settlement"
          description="CommitmentPool.queueSetAuthorizedSettlement(address). Starts the timelock — call activateAuthorizedSettlement() after the window."
          submitLabel="Queue rotation"
          disabled={!validAddr}
          onSubmit={queue}
          onSuccess={reload}
        >
          <SettlementInput input={input} onChange={setInput} />
        </AdminWriteCard>
      )}

      {readsOk && hasPending && timelockReady && (
        <AdminWriteCard
          title="Activate pending settlement — timelock elapsed"
          description="CommitmentPool.activateAuthorizedSettlement(). Finalises the queued rotation; the pending address replaces the authorized settlement."
          submitLabel="Activate"
          onSubmit={activate}
          onSuccess={reload}
        >
          <p className="text-xs text-[var(--color-text-muted)]">
            Pending will replace the authorized settlement on confirmation.
          </p>
        </AdminWriteCard>
      )}

      {readsOk && hasPending && !timelockReady && (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-sm text-[var(--color-text-muted)]">
          A pending rotation is waiting for the timelock to elapse. Queue another only after
          this one is activated.
        </div>
      )}
    </div>
  );
}

function StateBanner({
  snap,
  mounted,
  timelockRemaining,
}: {
  snap: Snapshot;
  mounted: boolean;
  timelockRemaining: number;
}) {
  if (!snap.loaded) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs">
        Reading current settlement state…
      </div>
    );
  }
  const noAuthorized = eqAddr(snap.authorized ?? ZERO_ADDRESS, ZERO_ADDRESS);
  const hasPending = !eqAddr(snap.pending ?? ZERO_ADDRESS, ZERO_ADDRESS);
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs">
      <div>
        Authorized:{" "}
        <strong className="font-mono">
          {noAuthorized ? "0x0 (unset)" : shortAddr(snap.authorized ?? "")}
        </strong>
      </div>
      {hasPending && (
        <div className="mt-1">
          Pending:{" "}
          <strong className="font-mono">{shortAddr(snap.pending ?? "")}</strong>
          {snap.activateAt != null && snap.activateAt > 0n && (
            <span className="ml-2 text-[var(--color-text-muted)]">
              · activates at{" "}
              {new Date(Number(snap.activateAt) * 1000).toISOString().slice(0, 16).replace("T", " ")}{" "}
              UTC
              {mounted &&
                timelockRemaining > 0 &&
                ` (in ${formatDuration(timelockRemaining)})`}
              {mounted && timelockRemaining === 0 && (
                <span className="ml-1 text-[var(--color-warning)]">— ready to activate</span>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function SettlementInput({
  input,
  onChange,
}: {
  input: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block uppercase tracking-wide text-[var(--color-text-subtle)]">
        New PrivateSettlement address
      </span>
      <input
        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm"
        placeholder="0x…"
        value={input}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

async function invoke1(signer: Signer, address: string, fn: string, arg: string) {
  const c = new Contract(address, ABI, signer);
  const setter = (
    c as unknown as Record<
      string,
      (a: string) => Promise<{ hash: string; wait(): Promise<{ hash?: string } | null> }>
    >
  )[fn];
  return (await setter(arg)) as {
    hash: string;
    wait(): Promise<{ hash?: string } | null>;
  };
}

async function invoke0(signer: Signer, address: string, fn: string) {
  const c = new Contract(address, ABI, signer);
  const setter = (
    c as unknown as Record<
      string,
      () => Promise<{ hash: string; wait(): Promise<{ hash?: string } | null> }>
    >
  )[fn];
  return (await setter()) as {
    hash: string;
    wait(): Promise<{ hash?: string } | null>;
  };
}
