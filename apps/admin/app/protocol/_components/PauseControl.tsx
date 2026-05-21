"use client";

import { useCallback, useEffect, useState } from "react";
import { Contract, type Signer } from "ethers";
import { useWallet } from "@zkscatter/sdk/react";
import { AdminWriteCard } from "../../components/AdminWriteCard";

const ABI = [
  "function paused() external view returns (bool)",
  "function pause() external",
  "function unpause() external",
];

interface Props {
  address: string;
  label: string;
}

/** Pause / unpause control shared by CommitmentPool + PrivateSettlement.
 *  Reads current pause state and surfaces the inverse action. */
export function PauseControl({ address, label }: Props) {
  const { signer, readProvider } = useWallet();
  const [paused, setPaused] = useState<boolean | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const c = new Contract(address, ABI, readProvider);
    void c
      .paused()
      .then((v: boolean) => {
        if (!cancelled) setPaused(v);
      })
      .catch(() => {
        if (!cancelled) setPaused(null);
      });
    return () => {
      cancelled = true;
    };
  }, [address, readProvider, reloadKey]);

  const submit = useCallback(async () => {
    if (!signer) throw new Error("Wallet not connected");
    if (paused == null) throw new Error("State unknown");
    return invokePause(signer, address, paused ? "unpause" : "pause");
  }, [signer, paused, address]);

  return (
    <AdminWriteCard
      title={`Pause / unpause ${label}`}
      description="Emergency stop. Pauses block any state-changing entrypoint until unpaused."
      submitLabel={paused === null ? "…" : paused ? "Unpause" : "Pause"}
      disabled={paused === null}
      onSubmit={submit}
      onSuccess={() => setReloadKey((k) => k + 1)}
    >
      <div className="text-xs text-[var(--color-text-muted)]">
        Status:{" "}
        <strong
          className={
            paused
              ? "text-[var(--color-danger)]"
              : paused === false
                ? "text-[var(--color-success)]"
                : ""
          }
        >
          {paused === null ? "…" : paused ? "Paused" : "Active"}
        </strong>
      </div>
    </AdminWriteCard>
  );
}

async function invokePause(signer: Signer, address: string, fn: "pause" | "unpause") {
  const c = new Contract(address, ABI, signer);
  return (await (fn === "pause" ? c.pause() : c.unpause())) as {
    hash: string;
    wait(): Promise<{ hash?: string } | null>;
  };
}
