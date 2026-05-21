"use client";

import { useCallback, useEffect, useState } from "react";
import { Contract, type Signer } from "ethers";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { shortAddr, useWallet } from "@zkscatter/sdk/react";
import { SectionHeader } from "../components/SectionHeader";
import { Stat } from "../components/Stat";
import { explainError } from "../lib/format";
import { DEMO_NETWORK, SANCTIONS_LIST_ADDRESS } from "../lib/network";
import { isValidEvmAddress } from "../lib/x509";
import { SetAddressCard } from "../protocol/_components/SetAddressCard";
import { BatchEditor } from "./_components/BatchEditor";
import { HistoryView } from "./_components/HistoryView";

const SANCTIONS_ABI = [
  "function isSanctioned(address addr) external view returns (bool)",
  "function addSanction(address addr) external",
  "function removeSanction(address addr) external",
  "function externalOracle() external view returns (address)",
  "function owner() external view returns (address)",
  "function setExternalOracle(address oracle) external",
];

type Phase =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; txHash: string; action: string }
  | { kind: "error"; msg: string };

export default function SanctionsPage() {
  const configured = isConfiguredAddress(SANCTIONS_LIST_ADDRESS);

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-2xl font-semibold">SanctionsList</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
          Self-multisig sanction entries: KoFIU and emergency holds. The Chainalysis OFAC
          oracle plugs in via <code className="font-mono">externalOracle</code> — managed
          below alongside the self-list.
        </p>
      </header>

      {!configured ? (
        <ConfigBanner />
      ) : (
        <>
          <ContractInfo />
          <LookupPanel />
          <WritePanel />
          <section>
            <SectionHeader title="Batch operations" badge="live" />
            <BatchEditor address={SANCTIONS_LIST_ADDRESS} />
          </section>
          <section>
            <SectionHeader title="External oracle" badge="live" />
            <SetAddressCard
              title="Set external oracle"
              description="SanctionsList.setExternalOracle(address). Typically the Chainalysis SDN oracle. Pass 0x0 to disable the OR-combine fallback and rely only on the self-managed list."
              contractAddress={SANCTIONS_LIST_ADDRESS}
              contractAbi={SANCTIONS_ABI}
              readerFn="externalOracle"
              setterFn="setExternalOracle"
              submitLabel="Update oracle"
              allowZeroAddress
            />
          </section>
          <HistoryView address={SANCTIONS_LIST_ADDRESS} />
        </>
      )}
    </div>
  );
}

function ConfigBanner() {
  return (
    <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
      <p>
        Set <code className="font-mono">NEXT_PUBLIC_SANCTIONS_LIST_ADDRESS</code> in this
        app's environment to enable the sanctions admin actions on{" "}
        <strong>{DEMO_NETWORK.name}</strong>.
      </p>
    </div>
  );
}

function ContractInfo() {
  const { readProvider } = useWallet();
  const [info, setInfo] = useState<{
    owner: string | null;
    externalOracle: string | null;
    error: string | null;
  }>({ owner: null, externalOracle: null, error: null });

  useEffect(() => {
    let cancelled = false;
    const contract = new Contract(SANCTIONS_LIST_ADDRESS, SANCTIONS_ABI, readProvider);
    void Promise.all([
      contract.owner().catch(() => null),
      contract.externalOracle().catch(() => null),
    ]).then(([owner, oracle]) => {
      if (cancelled) return;
      setInfo({
        owner: owner as string | null,
        externalOracle: oracle as string | null,
        error: null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [readProvider]);

  return (
    <section>
      <SectionHeader title="Contract" badge="live" />
      <div className="grid grid-cols-3 gap-4">
        <Stat
          label="Network"
          value={DEMO_NETWORK.name ?? "—"}
          sub={`Chain ID ${DEMO_NETWORK.chainId}`}
        />
        <Stat
          label="Owner (multisig)"
          value={info.owner ? shortAddr(info.owner) : "…"}
          sub={info.owner ? "Holds add/remove rights" : "Reading on-chain"}
        />
        <Stat
          label="External oracle"
          value={
            isConfiguredAddress(info.externalOracle) ? shortAddr(info.externalOracle) : "Disabled"
          }
          sub={
            isConfiguredAddress(info.externalOracle)
              ? "Chainalysis OFAC fallback"
              : "Self-list only"
          }
        />
      </div>
    </section>
  );
}

function LookupPanel() {
  const { readProvider } = useWallet();
  const [addr, setAddr] = useState("");
  const [result, setResult] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; sanctioned: boolean }
    | { kind: "error"; msg: string }
  >({ kind: "idle" });

  const lookup = useCallback(async () => {
    if (!isValidEvmAddress(addr.trim())) {
      setResult({ kind: "error", msg: "Must be a 0x-prefixed 20-byte address" });
      return;
    }
    setResult({ kind: "loading" });
    try {
      const contract = new Contract(SANCTIONS_LIST_ADDRESS, SANCTIONS_ABI, readProvider);
      const flagged = (await contract.isSanctioned(addr.trim())) as boolean;
      setResult({ kind: "ok", sanctioned: flagged });
    } catch (err) {
      setResult({ kind: "error", msg: explainError(err) });
    }
  }, [addr, readProvider]);

  return (
    <section>
      <SectionHeader
        title="Lookup"
        badge="live"
        hint="includes external oracle if configured"
      />
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="flex flex-wrap items-center gap-3">
          <input
            className="flex-1 min-w-[300px] rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm"
            placeholder="0x…"
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void lookup();
            }}
          />
          <button
            type="button"
            onClick={() => void lookup()}
            disabled={result.kind === "loading"}
            className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {result.kind === "loading" ? "Checking…" : "Check"}
          </button>
        </div>
        {result.kind === "ok" && (
          <div
            className={`mt-4 rounded-md border px-3 py-2 text-sm ${
              result.sanctioned
                ? "border-[var(--color-danger)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]"
                : "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-success)]"
            }`}
          >
            {result.sanctioned
              ? "⚠ Address is sanctioned (self-list or external oracle)."
              : "✓ Address is clear."}
          </div>
        )}
        {result.kind === "error" && (
          <div className="mt-4 rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">
            {result.msg}
          </div>
        )}
      </div>
    </section>
  );
}

function WritePanel() {
  const { account, signer, connect } = useWallet();
  const [addr, setAddr] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const submit = useCallback(
    async (action: "add" | "remove") => {
      if (!signer || !isValidEvmAddress(addr.trim())) return;
      setPhase({ kind: "submitting" });
      try {
        const tx = await writeSanction(signer, addr.trim(), action);
        const receipt = await tx.wait();
        setPhase({
          kind: "success",
          txHash: receipt?.hash ?? tx.hash,
          action,
        });
        setAddr("");
      } catch (err) {
        setPhase({ kind: "error", msg: explainError(err) });
      }
    },
    [signer, addr],
  );

  const valid = isValidEvmAddress(addr.trim());

  return (
    <section>
      <SectionHeader title="Add / Remove entry" badge="live" />
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          The connected wallet must be the contract owner (the admin multisig).
          Self-list entries are authoritative — they take precedence over the external
          oracle.
        </p>
        <input
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm"
          placeholder="0x…"
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
        />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {!account ? (
            <button
              type="button"
              onClick={() => void connect()}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-bg)]"
            >
              Connect admin wallet
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={!valid || phase.kind === "submitting"}
                onClick={() => void submit("add")}
                className="rounded-md bg-[var(--color-danger)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {phase.kind === "submitting" ? "Submitting…" : "Add sanction"}
              </button>
              <button
                type="button"
                disabled={!valid || phase.kind === "submitting"}
                onClick={() => void submit("remove")}
                className="rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] px-4 py-2 text-sm font-medium text-[var(--color-success)] hover:bg-[var(--color-success)] hover:text-white disabled:opacity-50"
              >
                Remove sanction
              </button>
            </>
          )}
        </div>
        {phase.kind === "success" && (
          <div className="mt-4 rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] px-3 py-2 text-sm text-[var(--color-success)]">
            {phase.action === "add" ? "Sanction added" : "Sanction removed"} ·{" "}
            <code className="font-mono">{phase.txHash.slice(0, 10)}…</code>
          </div>
        )}
        {phase.kind === "error" && (
          <div className="mt-4 rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">
            {phase.msg}
          </div>
        )}
      </div>
    </section>
  );
}

async function writeSanction(signer: Signer, addr: string, action: "add" | "remove") {
  const contract = new Contract(SANCTIONS_LIST_ADDRESS, SANCTIONS_ABI, signer);
  const tx = action === "add" ? contract.addSanction(addr) : contract.removeSanction(addr);
  return (await tx) as { hash: string; wait(): Promise<{ hash?: string } | null> };
}

