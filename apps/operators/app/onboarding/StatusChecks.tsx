"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@zkscatter/sdk/react";
import { loadRegistrationStatus, NATIVE_BOND_TOKEN } from "@zkscatter/sdk/relayer";
import { useOperator } from "../lib/useOperator";
import { DEMO_NETWORK } from "../lib/network";

type Status = "ok" | "warn" | "fail" | "pending" | "skip";

export function StatusChecks() {
  return (
    <div className="space-y-2.5">
      <WalletCheck />
      <ChainCheck />
      <RpcCheck />
      <RegistrationCheck />
      <BondCheck />
      <HealthCheck />
    </div>
  );
}

function WalletCheck() {
  const { account } = useWallet();
  return (
    <StatusRow
      status={account ? "ok" : "fail"}
      title="Operator wallet connected"
      detail={
        account ? (
          <span className="font-mono">{shortAddress(account)}</span>
        ) : (
          "Connect a wallet from the header to enable the rest of the checks."
        )
      }
    />
  );
}

function ChainCheck() {
  const { readProvider } = useWallet();
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    readProvider
      .getNetwork()
      .then((n) => {
        if (!cancelled) setChainId(Number(n.chainId));
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [readProvider]);

  if (error) {
    return <StatusRow status="fail" title="Chain match" detail={error} />;
  }
  if (chainId === null) {
    return <StatusRow status="pending" title="Chain match" detail="Reading network id…" />;
  }
  const expected = DEMO_NETWORK.chainId;
  return (
    <StatusRow
      status={chainId === expected ? "ok" : "fail"}
      title="Chain match"
      detail={
        chainId === expected
          ? `${DEMO_NETWORK.name} (chainId ${expected}).`
          : `Provider reports chainId ${chainId}; this app expects ${expected} (${DEMO_NETWORK.name}).`
      }
    />
  );
}

function RpcCheck() {
  const { readProvider } = useWallet();
  const [block, setBlock] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    readProvider
      .getBlockNumber()
      .then((n) => {
        if (!cancelled) setBlock(n);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [readProvider]);

  if (error) {
    return (
      <StatusRow
        status="fail"
        title="RPC reachable"
        detail={`getBlockNumber failed: ${error}`}
      />
    );
  }
  if (block === null) {
    return <StatusRow status="pending" title="RPC reachable" detail="Pinging RPC…" />;
  }
  return (
    <StatusRow
      status="ok"
      title="RPC reachable"
      detail={`Latest block: ${block.toLocaleString()}.`}
    />
  );
}

function RegistrationCheck() {
  const { account } = useWallet();
  const { row, loading, registryDeployed } = useOperator();

  if (!registryDeployed) {
    return (
      <StatusRow
        status="skip"
        title="On-chain registration"
        detail={`RelayerRegistry not yet configured for ${DEMO_NETWORK.name}. Step 4 will work once an address is wired in.`}
      />
    );
  }
  if (!account) {
    return (
      <StatusRow
        status="skip"
        title="On-chain registration"
        detail="Connect a wallet to read your registry status."
      />
    );
  }
  if (loading || !row) {
    return <StatusRow status="pending" title="On-chain registration" detail="Reading registry…" />;
  }
  if (row.status === "active") {
    return (
      <StatusRow
        status="ok"
        title="On-chain registration"
        detail={`Active. Fee ${row.feeBps} bps. URL: ${row.url || "(none on-chain)"}.`}
      />
    );
  }
  if (row.status === "cooldown") {
    return (
      <StatusRow
        status="warn"
        title="On-chain registration"
        detail="Exit requested — registry treats you as inactive. Wait out the cooldown and re-register."
      />
    );
  }
  return (
    <StatusRow
      status="fail"
      title="On-chain registration"
      detail={
        row.status === "unregistered"
          ? "No registry entry. Step 4 (registration) is your next action."
          : "Relayer is offline. Re-register to return to the active set."
      }
    />
  );
}

function BondCheck() {
  const { account, readProvider } = useWallet();
  const { registryDeployed } = useOperator();

  const [state, setState] = useState<
    | { kind: "loading" }
    | {
        kind: "ok";
        nativeBalance: bigint;
        minBond: bigint;
        isErc20: boolean;
        allowance: bigint;
      }
    | { kind: "fail"; reason: string }
  >({ kind: "loading" });

  useEffect(() => {
    if (!registryDeployed || !account) return;
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      try {
        const [status, nativeBalance] = await Promise.all([
          loadRegistrationStatus(
            DEMO_NETWORK.contracts.relayerRegistry,
            account,
            readProvider,
          ),
          readProvider.getBalance(account),
        ]);
        if (!cancelled) {
          setState({
            kind: "ok",
            nativeBalance,
            minBond: status.minBond,
            isErc20: status.bondToken !== NATIVE_BOND_TOKEN,
            allowance: status.bondAllowance,
          });
        }
      } catch (e) {
        if (!cancelled) {
          setState({ kind: "fail", reason: String((e as Error)?.message ?? e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, readProvider, registryDeployed]);

  if (!registryDeployed) {
    return (
      <StatusRow
        status="skip"
        title="Bond balance"
        detail="Registry not yet configured. Cannot read minimum bond."
      />
    );
  }
  if (!account) {
    return <StatusRow status="skip" title="Bond balance" detail="Connect a wallet to read." />;
  }
  if (state.kind === "loading") {
    return <StatusRow status="pending" title="Bond balance" detail="Reading minBond + balance…" />;
  }
  if (state.kind === "fail") {
    return <StatusRow status="fail" title="Bond balance" detail={state.reason} />;
  }

  const { nativeBalance, minBond, isErc20, allowance } = state;
  const minLabel = isErc20 ? `${formatUnits18(minBond)} (bond token)` : `${formatUnits18(minBond)} ETH`;

  if (isErc20) {
    const allowanceOk = allowance >= minBond;
    return (
      <StatusRow
        status={allowanceOk ? "ok" : "warn"}
        title="Bond balance"
        detail={
          allowanceOk
            ? `Registry runs in ERC20 mode. Existing allowance ≥ ${minLabel} — registration will not need a fresh approve.`
            : `Registry runs in ERC20 mode. Allowance to the registry is below ${minLabel}; the /register page will request an approve tx. Token balance is checked there too.`
        }
      />
    );
  }
  const enough = nativeBalance >= minBond;
  return (
    <StatusRow
      status={enough ? "ok" : "fail"}
      title="Bond balance"
      detail={
        enough
          ? `${formatUnits18(nativeBalance)} ETH available, registry requires ≥ ${minLabel}.`
          : `Have ${formatUnits18(nativeBalance)} ETH, registry requires ≥ ${minLabel}. Top up before Step 4.`
      }
    />
  );
}

function formatUnits18(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n) / 10n ** 14n;
  return `${whole}.${frac.toString().padStart(4, "0")}`;
}

function HealthCheck() {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; uptime: number; checks: Record<string, string> }
    | { kind: "degraded"; checks: Record<string, string> }
    | { kind: "fail"; reason: string }
  >({ kind: "idle" });

  const onPing = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setState({ kind: "loading" });
    try {
      // Resolve `/health` against the user's input as a base URL,
      // so pasting `https://relayer.example.com/api/info` (or any
      // other path) still hits the right endpoint.
      const target = new URL("/health", trimmed).toString();
      const res = await fetch(target);
      const body = (await res.json()) as {
        status?: string;
        uptime?: number;
        checks?: Record<string, string>;
      };
      if (res.ok && body.status === "healthy") {
        setState({
          kind: "ok",
          uptime: body.uptime ?? 0,
          checks: body.checks ?? {},
        });
      } else {
        setState({ kind: "degraded", checks: body.checks ?? {} });
      }
    } catch (e) {
      setState({ kind: "fail", reason: String((e as Error)?.message ?? e) });
    }
  };

  const status: Status =
    state.kind === "ok"
      ? "ok"
      : state.kind === "degraded"
      ? "warn"
      : state.kind === "fail"
      ? "fail"
      : state.kind === "loading"
      ? "pending"
      : "skip";

  let detail: React.ReactNode;
  if (state.kind === "ok") {
    const checksLine = Object.entries(state.checks)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    detail = (
      <span>
        Healthy. Uptime {state.uptime}s.{checksLine ? ` Checks — ${checksLine}.` : ""}
      </span>
    );
  } else if (state.kind === "degraded") {
    const failed = Object.entries(state.checks)
      .filter(([, v]) => v !== "ok")
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ") || "no detail";
    detail = <span>Degraded — {failed}.</span>;
  } else if (state.kind === "fail") {
    detail = <span>Could not reach the URL: {state.reason}</span>;
  } else if (state.kind === "loading") {
    detail = "Pinging /health…";
  } else {
    detail = "Enter your relayer's public URL and ping it.";
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-start gap-3">
        <StatusBadge status={status} />
        <div className="min-w-0 flex-1">
          <div className="font-medium">Relayer service /health</div>
          <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{detail}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://relayer.example.com"
              className="min-w-0 flex-1 rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-1.5 text-sm font-mono"
            />
            <button
              onClick={onPing}
              disabled={!url || state.kind === "loading"}
              className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {state.kind === "loading" ? "Pinging…" : "Ping"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusRow({
  status,
  title,
  detail,
}: {
  status: Status;
  title: string;
  detail: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <StatusBadge status={status} />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{detail}</p>
      </div>
    </div>
  );
}

const BADGE: Record<Status, { label: string; cls: string }> = {
  ok: {
    label: "OK",
    cls: "bg-[var(--color-success-soft)] text-[var(--color-success)] border-[var(--color-success)]",
  },
  warn: {
    label: "WARN",
    cls: "bg-[var(--color-warning-soft)] text-[var(--color-warning)] border-[var(--color-warning)]",
  },
  fail: {
    label: "FAIL",
    cls: "bg-[var(--color-danger-soft,var(--color-warning-soft))] text-[var(--color-danger,var(--color-warning))] border-[var(--color-danger,var(--color-warning))]",
  },
  pending: {
    label: "…",
    cls: "bg-[var(--color-bg)] text-[var(--color-text-muted)] border-[var(--color-border-strong)]",
  },
  skip: {
    label: "SKIP",
    cls: "bg-[var(--color-bg)] text-[var(--color-text-subtle)] border-[var(--color-border)]",
  },
};

function StatusBadge({ status }: { status: Status }) {
  const { label, cls } = BADGE[status];
  return (
    <span
      className={`inline-flex h-6 min-w-[3rem] items-center justify-center rounded border px-2 text-[10px] font-semibold ${cls}`}
    >
      {label}
    </span>
  );
}

function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
