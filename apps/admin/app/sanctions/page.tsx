"use client";

import { useCallback, useState, type ReactNode } from "react";
import { Contract, type Signer } from "ethers";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { shortAddr, useWallet } from "@zkscatter/sdk/react";
import { SectionHeader } from "../components/SectionHeader";
import { Stat } from "../components/Stat";
import { explainError } from "../lib/format";
import { DEMO_NETWORK, SANCTIONS_LIST_ADDRESS } from "../lib/network";
import { isValidEvmAddress, normalizeEvmAddress } from "../lib/x509";
import { SetAddressCard } from "../protocol/_components/SetAddressCard";
import { BatchEditor } from "./_components/BatchEditor";
import { CurrentSetTable } from "./_components/CurrentSetTable";
import { HistoryView } from "./_components/HistoryView";
import { OracleHealthProbe } from "./_components/OracleHealthProbe";
import { SanctionsProvider, useSanctions } from "./_components/SanctionsContext";

type TabKey = "self" | "oracle" | "history";

const TABS: Array<{ key: TabKey; label: string; sub: string }> = [
  { key: "self", label: "Self-managed", sub: "Multisig add/remove + batch" },
  { key: "oracle", label: "External oracle", sub: "Chainalysis / OFAC fallback" },
  { key: "history", label: "History", sub: "On-chain events" },
];

const SANCTIONS_ABI = [
  "function isSanctioned(address addr) external view returns (bool)",
  "function sanctioned(address addr) external view returns (bool)",
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
          below alongside the self-list. Owner-only writes are routed through the admin
          multisig.
        </p>
      </header>

      {!configured ? (
        <ConfigBanner />
      ) : (
        <SanctionsProvider address={SANCTIONS_LIST_ADDRESS}>
          <ContractInfo />
          <LookupPanel />
          <TabbedSurface />
        </SanctionsProvider>
      )}
    </div>
  );
}

function TabbedSurface() {
  const [active, setActive] = useState<TabKey>("self");
  return (
    <div className="space-y-6">
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-[var(--color-border)]">
        {TABS.map((tab) => {
          const isActive = active === tab.key;
          return (
            <button
              key={tab.key}
              role="tab"
              aria-selected={isActive}
              type="button"
              onClick={() => setActive(tab.key)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? "border-[var(--color-primary)] text-[var(--color-primary)]"
                  : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              }`}
            >
              <div>{tab.label}</div>
              <div className="text-[10px] font-normal text-[var(--color-text-subtle)]">
                {tab.sub}
              </div>
            </button>
          );
        })}
      </div>
      <TabPanel show={active === "self"}>
        <CurrentSetTable address={SANCTIONS_LIST_ADDRESS} />
        <WritePanel />
        <section>
          <SectionHeader title="Batch operations" badge="live" />
          <BatchEditor address={SANCTIONS_LIST_ADDRESS} />
        </section>
      </TabPanel>
      <TabPanel show={active === "oracle"}>
        <ExternalOracleSection />
      </TabPanel>
      <TabPanel show={active === "history"}>
        <HistoryView />
      </TabPanel>
    </div>
  );
}

/** Render with `display: none` instead of unmounting so the shared
 *  <SanctionsProvider> queryFilter result isn't refetched every time
 *  the operator flicks between tabs. */
function TabPanel({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <div role="tabpanel" hidden={!show} className={show ? "space-y-10" : ""}>
      {children}
    </div>
  );
}

function ConfigBanner() {
  return (
    <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
      <p>
        Set <code className="font-mono">NEXT_PUBLIC_SANCTIONS_LIST_ADDRESS</code> in this
        app&apos;s environment to enable the sanctions admin actions on{" "}
        <strong>{DEMO_NETWORK.name}</strong>.
      </p>
    </div>
  );
}

function ContractInfo() {
  const { currentSet, loading: eventsLoading, owner, externalOracle } = useSanctions();

  return (
    <section>
      <SectionHeader title="Contract" badge="live" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Network"
          value={DEMO_NETWORK.name ?? "—"}
          sub={`Chain ID ${DEMO_NETWORK.chainId}`}
          compact
        />
        <Stat
          label="Owner (multisig)"
          value={owner ? shortAddr(owner) : "…"}
          sub={owner ? "Holds add/remove rights" : "Reading on-chain"}
          compact
        />
        <Stat
          label="External oracle"
          value={
            isConfiguredAddress(externalOracle) ? shortAddr(externalOracle) : "Disabled"
          }
          sub={
            isConfiguredAddress(externalOracle) ? "Chainalysis OFAC fallback" : "Self-list only"
          }
          compact
        />
        <Stat
          label="Self-list size"
          value={eventsLoading ? "…" : `${currentSet.size}`}
          sub="From event replay (current scan window)"
          compact
        />
      </div>
    </section>
  );
}

interface LookupResult {
  selfList: boolean;
  /** Tri-state: `true` if the configured oracle reports the address,
   *  `false` if it doesn't, `null` if no oracle is configured (or its
   *  call reverted — treated as "no information" rather than guessing
   *  from the combined `isSanctioned()` flag, which would silently
   *  hide an oracle hit whenever the self-list also matches). */
  oracle: boolean | null;
}

const ORACLE_ABI = ["function isSanctioned(address) external view returns (bool)"];

function LookupPanel() {
  const { readProvider } = useWallet();
  const { externalOracle } = useSanctions();
  const [addr, setAddr] = useState("");
  const [result, setResult] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; data: LookupResult }
    | { kind: "error"; msg: string }
  >({ kind: "idle" });

  const lookup = useCallback(async () => {
    // Reject mixed-case typos via EIP-55 checksum. All-lower/upper
    // inputs pass straight through (no checksum to verify).
    const normalized = normalizeEvmAddress(addr.trim());
    if (!normalized) {
      setResult({
        kind: "error",
        msg: "Must be a 0x-prefixed 20-byte address (mixed-case must satisfy EIP-55 checksum)",
      });
      return;
    }
    setResult({ kind: "loading" });
    try {
      const contract = new Contract(SANCTIONS_LIST_ADDRESS, SANCTIONS_ABI, readProvider);
      // Read the self-list directly via the raw mapping getter. The
      // oracle is queried independently so a hit on BOTH lists shows
      // both indicators — deriving "oracle flagged" from the
      // OR-combined `isSanctioned()` would hide oracle activity
      // whenever the self-list also matches.
      const oracleConfigured = isConfiguredAddress(externalOracle);
      const oraclePromise: Promise<boolean | null> = oracleConfigured
        ? new Contract(externalOracle as string, ORACLE_ABI, readProvider)
            .isSanctioned(normalized)
            .then((v: boolean) => v)
            .catch(() => null)
        : Promise.resolve(null);
      const [selfList, oracle] = await Promise.all([
        contract.sanctioned(normalized) as Promise<boolean>,
        oraclePromise,
      ]);
      setResult({ kind: "ok", data: { selfList, oracle } });
    } catch (err) {
      setResult({ kind: "error", msg: explainError(err) });
    }
  }, [addr, readProvider, externalOracle]);

  return (
    <section>
      <SectionHeader title="Lookup" badge="live" hint="self-list + external oracle breakdown" />
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
        {result.kind === "ok" && <LookupBreakdown data={result.data} />}
        {result.kind === "error" && (
          <div className="mt-4 rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">
            {result.msg}
          </div>
        )}
      </div>
    </section>
  );
}

function LookupBreakdown({ data }: { data: LookupResult }) {
  // "Sanctioned" if EITHER list flags. Oracle = null means "no oracle
  // configured / call failed" — treat as not contributing.
  const oracleFlagged = data.oracle === true;
  const sanctioned = data.selfList || oracleFlagged;
  return (
    <div className="mt-4 space-y-2">
      <div
        className={`rounded-md border px-3 py-2 text-sm ${
          sanctioned
            ? "border-[var(--color-danger)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]"
            : "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-success)]"
        }`}
      >
        {sanctioned ? "⚠ Address is sanctioned." : "✓ Address is clear."}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div
          className={`rounded-md border px-3 py-2 ${
            data.selfList
              ? "border-[var(--color-danger)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]"
              : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)]"
          }`}
        >
          <div className="text-[10px] font-semibold uppercase tracking-wide">Self-list</div>
          <div className="mt-0.5">
            {data.selfList ? "Listed — removable via this admin" : "Not listed"}
          </div>
        </div>
        <div
          className={`rounded-md border px-3 py-2 ${
            oracleFlagged
              ? "border-[var(--color-warning)] bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
              : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)]"
          }`}
        >
          <div className="text-[10px] font-semibold uppercase tracking-wide">External oracle</div>
          <div className="mt-0.5">
            {data.oracle === null
              ? "No oracle configured (or unreachable)"
              : oracleFlagged
                ? "Listed — managed by oracle operator (not removable here)"
                : "Not flagged by oracle"}
          </div>
        </div>
      </div>
    </div>
  );
}

function WritePanel() {
  const { account, signer, connect } = useWallet();
  const { refresh } = useSanctions();
  const [addr, setAddr] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const submit = useCallback(
    async (action: "add" | "remove") => {
      // Surface a real error rather than silently no-op — the button is
      // gated below, but a race (wallet disconnects between click and
      // handler) would otherwise leave the operator staring at a still
      // page wondering whether their click was received.
      if (!signer) {
        setPhase({ kind: "error", msg: "Wallet signer unavailable. Reconnect and try again." });
        return;
      }
      // Re-validate at submit time using checksum-aware normalize —
      // this is the last line of defence before the tx leaves the
      // browser, so a mixed-case typo must NOT silently pass through
      // to addSanction()/removeSanction().
      const normalized = normalizeEvmAddress(addr.trim());
      if (!normalized) {
        setPhase({
          kind: "error",
          msg: "Invalid address (mixed-case must satisfy EIP-55 checksum)",
        });
        return;
      }
      setPhase({ kind: "submitting" });
      try {
        const tx = await writeSanction(signer, normalized, action);
        const receipt = await tx.wait();
        setPhase({
          kind: "success",
          txHash: receipt?.hash ?? tx.hash,
          action,
        });
        setAddr("");
        refresh();
      } catch (err) {
        setPhase({ kind: "error", msg: explainError(err) });
      }
    },
    [signer, addr, refresh],
  );

  // Syntactic gate for the disabled state — keeps the button live
  // for all-lower/upper inputs and lets `submit` produce the real
  // EIP-55 error message on click. Otherwise mixed-case typos
  // disable the button with no explanation.
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
                disabled={!signer || !valid || phase.kind === "submitting"}
                onClick={() => void submit("add")}
                className="rounded-md bg-[var(--color-danger)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {phase.kind === "submitting" ? "Submitting…" : "Add sanction"}
              </button>
              <button
                type="button"
                disabled={!signer || !valid || phase.kind === "submitting"}
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

function ExternalOracleSection() {
  const { externalOracle, refresh } = useSanctions();

  return (
    <section>
      <SectionHeader title="External oracle" badge="live" />
      <div className="space-y-3">
        <SetAddressCard
          title="Set external oracle"
          description="SanctionsList.setExternalOracle(address). Typically the Chainalysis SDN oracle. Pass 0x0 to disable the OR-combine fallback and rely only on the self-managed list."
          contractAddress={SANCTIONS_LIST_ADDRESS}
          contractAbi={SANCTIONS_ABI}
          readerFn="externalOracle"
          setterFn="setExternalOracle"
          submitLabel="Update oracle"
          allowZeroAddress
          onSuccess={refresh}
        />
        <OracleHealthProbe oracleAddress={externalOracle} />
      </div>
    </section>
  );
}

async function writeSanction(signer: Signer, addr: string, action: "add" | "remove") {
  const contract = new Contract(SANCTIONS_LIST_ADDRESS, SANCTIONS_ABI, signer);
  const tx = action === "add" ? contract.addSanction(addr) : contract.removeSanction(addr);
  return (await tx) as { hash: string; wait(): Promise<{ hash?: string } | null> };
}
