"use client";

import { useEffect, useState } from "react";
import { Contract, parseUnits } from "ethers";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { shortAddr, useNetworkTokens, useWallet } from "@zkscatter/sdk/react";
import { DEMO_NETWORK } from "../../lib/network";
import { prettyAmount } from "../../lib/format";
import { isValidEvmAddress } from "../../lib/x509";

const TREASURY_ABI = [
  "function beneficiary(address) external view returns (bool)",
  "function attributedERC20(address) external view returns (uint256)",
  "function attributedETH() external view returns (uint256)",
  "function paused() external view returns (bool)",
  "function setBeneficiary(address addr, bool allowed) external",
  "function withdraw(address token, address to, uint256 amount) external",
  "function withdrawETH(address payable to, uint256 amount) external",
  "event BeneficiaryUpdated(address indexed addr, bool allowed)",
];

const ERC20_ABI = [
  "function balanceOf(address) external view returns (uint256)",
];

const WETH_ABI = [
  "function balanceOf(address) external view returns (uint256)",
  "function withdraw(uint256 amount) external",
];

type Phase =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; hash: string }
  | { kind: "error"; msg: string };

/** prettyAmount + token symbol suffix — the admin tables render
 *  "1,234.5 USDC" rather than the bare number. */
function fmt(wei: bigint, decimals: number, symbol: string): string {
  return `${prettyAmount(wei, decimals)} ${symbol}`;
}

interface TokenBalance {
  address: string;
  symbol: string;
  decimals: number;
  balance: bigint;
}

export function TreasuryWrites({
  treasuryAddress,
  reloadKey,
  onReload,
}: {
  treasuryAddress: string | null;
  reloadKey: number;
  onReload: () => void;
}) {
  const { readProvider } = useWallet();
  // On-chain token set (Pool∩Settlement) with env fallback.
  const { tokens: networkTokens } = useNetworkTokens(DEMO_NETWORK);
  const [balances, setBalances] = useState<TokenBalance[]>([]);
  const [ethBalance, setEthBalance] = useState<bigint | null>(null);
  const [wethBalance, setWethBalance] = useState<bigint | null>(null);
  const [paused, setPaused] = useState<boolean | null>(null);
  const [beneficiaries, setBeneficiaries] = useState<string[]>([]);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!readProvider || !treasuryAddress || !isConfiguredAddress(treasuryAddress)) return;
    let cancelled = false;
    const treasury = new Contract(treasuryAddress, TREASURY_ABI, readProvider);
    const wethAddr = DEMO_NETWORK.contracts.weth;

    // Native ETH balance + WETH balance + paused
    const wethReads: Promise<bigint>[] = wethAddr && isConfiguredAddress(wethAddr)
      ? [new Contract(wethAddr, WETH_ABI, readProvider).balanceOf(treasuryAddress) as Promise<bigint>]
      : [Promise.resolve(0n)];
    void Promise.all([
      readProvider.getBalance(treasuryAddress),
      treasury.paused() as Promise<boolean>,
      ...wethReads,
    ]).then(([eth, isPaused, weth]) => {
      if (cancelled) return;
      setEthBalance(eth as bigint);
      setPaused(isPaused as boolean);
      setWethBalance((weth as bigint) ?? 0n);
      setLoadError(false);
    }).catch((err) => {
      // Surface the failure instead of leaving balances null → "0 ETH",
      // which would read as an empty treasury rather than an RPC error.
      if (!cancelled) {
        console.error("[treasury] failed to load balances", err);
        setLoadError(true);
      }
    });

    // ERC20 balances — exclude WETH (merged into the ETH row)
    const wethAddrLower = DEMO_NETWORK.contracts.weth?.toLowerCase();
    const tokens = networkTokens.filter(
      (t) => t.address.toLowerCase() !== wethAddrLower
    );
    void Promise.all(
      tokens.map(async (token) => {
        const erc20 = new Contract(token.address, ERC20_ABI, readProvider);
        const balance = (await erc20.balanceOf(treasuryAddress)) as bigint;
        return { address: token.address, symbol: token.symbol, decimals: token.decimals, balance };
      })
    ).then((rows) => { if (!cancelled) setBalances(rows); }).catch(() => {});

    // Beneficiary list from events
    void treasury.queryFilter(treasury.filters.BeneficiaryUpdated())
      .then((logs) => {
        if (cancelled) return;
        const map = new Map<string, boolean>();
        for (const log of logs) {
          const args = (log as { args?: { addr?: string; allowed?: boolean } }).args;
          if (args?.addr !== undefined && args?.allowed !== undefined) {
            map.set(args.addr.toLowerCase(), args.allowed);
          }
        }
        setBeneficiaries([...map.entries()].filter(([, v]) => v).map(([a]) => a));
      }).catch(() => {});

    return () => { cancelled = true; };
  }, [readProvider, treasuryAddress, reloadKey, networkTokens]);

  if (!treasuryAddress || !isConfiguredAddress(treasuryAddress)) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
        Treasury address not configured.
      </div>
    );
  }

  const hasBalance = ethBalance != null && (
    ethBalance > 0n || (wethBalance ?? 0n) > 0n || balances.some((b) => b.balance > 0n)
  );

  return (
    <div className="space-y-6">
      {loadError && (
        <div className="rounded-xl border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-5 py-3 text-sm font-medium text-[var(--color-danger)]">
          ⚠ Failed to read Treasury state from the chain — balances below may be stale. Check the RPC connection and retry.
        </div>
      )}
      {paused && (
        <div className="rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-5 py-3 text-sm font-medium text-[var(--color-warning)]">
          ⚠ Treasury is paused — all withdrawals are blocked.
        </div>
      )}

      {/* Treasury balances */}
      <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="border-b border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-3">
          <div className="font-medium">Treasury balance</div>
          <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">
            Funds held in the Treasury contract ({shortAddr(treasuryAddress)}).
            Withdraw to an allowlisted beneficiary address.
          </div>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
            <tr>
              <th className="px-5 py-2 text-left">Token</th>
              <th className="px-5 py-2 text-right">Balance</th>
              <th className="px-5 py-2 text-right">Withdraw to EOA</th>
            </tr>
          </thead>
          <tbody>
            {/* ETH + WETH merged row */}
            <EthWethRow
              treasuryAddress={treasuryAddress}
              ethBalance={ethBalance ?? 0n}
              wethBalance={wethBalance ?? 0n}
              wethAddress={DEMO_NETWORK.contracts.weth ?? ""}
              beneficiaries={beneficiaries}
              paused={paused !== false}
              onReload={onReload}
            />
            {balances.map((b) => (
              <WithdrawRow
                key={b.address}
                symbol={b.symbol}
                decimals={b.decimals}
                balance={b.balance}
                treasuryAddress={treasuryAddress}
                beneficiaries={beneficiaries}
                paused={paused !== false}
                tokenAddress={b.address}
                onReload={onReload}
              />
            ))}
          </tbody>
        </table>
        {!hasBalance && (
          <div className="px-5 py-4 text-sm text-[var(--color-text-muted)]">
            No balance in Treasury.
          </div>
        )}
      </div>

      {/* Beneficiary allowlist */}
      <BeneficiaryManager
        treasuryAddress={treasuryAddress}
        beneficiaries={beneficiaries}
        reloadKey={reloadKey}
        onReload={onReload}
      />
    </div>
  );
}

function EthWethRow({
  treasuryAddress,
  ethBalance,
  wethBalance,
  wethAddress,
  beneficiaries,
  paused,
  onReload,
}: {
  treasuryAddress: string;
  ethBalance: bigint;
  wethBalance: bigint;
  wethAddress: string;
  beneficiaries: string[];
  paused: boolean;
  onReload: () => void;
}) {
  const { signer } = useWallet();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    if (!to && beneficiaries.length > 0) setTo(beneficiaries[0]);
  }, [beneficiaries, to]);

  const totalEth = ethBalance + wethBalance;

  // Reject amounts over the combined balance up-front: a request larger
  // than the WETH leg would silently skip the native-ETH remainder.
  const amountValid = (() => {
    try {
      if (amount === "") return false;
      const parsed = parseUnits(amount, 18);
      return parsed > 0n && parsed <= totalEth;
    } catch { return false; }
  })();

  // Prefer WETH withdrawal (auto-unwrap) — then native ETH if any remains
  const canWithdraw =
    !!signer && !paused && totalEth > 0n && amountValid &&
    isConfiguredAddress(to) && beneficiaries.includes(to.toLowerCase());

  const submit = async () => {
    if (!signer) return;
    setPhase({ kind: "submitting" });
    try {
      const parsed = parseUnits(amount, 18);
      const treasury = new Contract(treasuryAddress, TREASURY_ABI, signer);
      let finalHash = "";

      if (wethBalance > 0n && isConfiguredAddress(wethAddress)) {
        // Step 1: Treasury.withdraw(weth, to, amount) → WETH lands at beneficiary
        const wethToSend = parsed > wethBalance ? wethBalance : parsed;
        const tx1 = (await treasury.withdraw(wethAddress, to, wethToSend)) as { hash: string; wait(): Promise<{ hash?: string } | null> };
        const r1 = await tx1.wait();
        finalHash = r1?.hash ?? tx1.hash;

        // Step 2: if connected wallet == beneficiary, auto-unwrap WETH → ETH
        const signerAddr = (await signer.getAddress()).toLowerCase();
        if (signerAddr === to.toLowerCase()) {
          try {
            const wethContract = new Contract(wethAddress, WETH_ABI, signer);
            const unwrapTx = (await wethContract.withdraw(wethToSend)) as { hash: string; wait(): Promise<{ hash?: string } | null> };
            const r2 = await unwrapTx.wait();
            finalHash = r2?.hash ?? unwrapTx.hash;
          } catch {
            // Partial: WETH sent but not unwrapped — beneficiary unwraps manually
          }
        }

        // Remaining ETH if requested more than WETH balance
        const remaining = parsed - wethToSend;
        if (remaining > 0n && ethBalance >= remaining) {
          const tx3 = (await treasury.withdrawETH(to, remaining)) as { hash: string; wait(): Promise<{ hash?: string } | null> };
          const r3 = await tx3.wait();
          finalHash = r3?.hash ?? tx3.hash;
        }
      } else if (ethBalance >= parsed) {
        // Only native ETH
        const tx = (await treasury.withdrawETH(to, parsed)) as { hash: string; wait(): Promise<{ hash?: string } | null> };
        const r = await tx.wait();
        finalHash = r?.hash ?? tx.hash;
      }

      setPhase({ kind: "success", hash: finalHash });
      setAmount("");
      onReload();
    } catch (e) {
      setPhase({ kind: "error", msg: (e as Error).message?.slice(0, 80) ?? "Failed" });
    }
  };

  return (
    <tr className="border-t border-[var(--color-border)]">
      <td className="px-5 py-3">
        <div className="font-medium">ETH</div>
        <div className="text-xs text-[var(--color-text-muted)]">
          Native ETH + WETH (auto-unwrap on withdraw)
        </div>
        <div className="mt-0.5 font-mono text-[10px] text-[var(--color-text-subtle)]">
          {fmt(ethBalance, 18, "ETH native")} · {fmt(wethBalance, 18, "WETH")}
        </div>
      </td>
      <td className="px-5 py-3 text-right font-mono">
        {fmt(totalEth, 18, "ETH")}
      </td>
      <td className="px-5 py-3">
        {beneficiaries.length === 0 ? (
          <span className="text-xs text-[var(--color-text-muted)]">No beneficiaries — add one below</span>
        ) : (
          <div className="flex items-center gap-2 justify-end">
            <select
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs"
            >
              {beneficiaries.map((b) => (
                <option key={b} value={b}>{shortAddr(b)}</option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Amount (ETH)"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-28 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs"
            />
            <button
              type="button"
              disabled={!canWithdraw || phase.kind === "submitting"}
              onClick={() => void submit()}
              className="rounded-md bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              {phase.kind === "submitting" ? "Sending…" : "Withdraw"}
            </button>
          </div>
        )}
        {phase.kind === "error" && (
          <div className="mt-1 text-right text-[10px] text-[var(--color-danger)]">{phase.msg}</div>
        )}
        {phase.kind === "success" && (
          <div className="mt-1 text-right font-mono text-[10px] text-[var(--color-success)]">Done {phase.hash.slice(0, 10)}…</div>
        )}
      </td>
    </tr>
  );
}

function WithdrawRow({
  symbol,
  decimals,
  balance,
  treasuryAddress,
  beneficiaries,
  paused,
  tokenAddress,
  onReload,
}: {
  symbol: string;
  decimals: number;
  balance: bigint;
  treasuryAddress: string;
  beneficiaries: string[];
  paused: boolean;
  tokenAddress: string;
  onReload: () => void;
}) {
  const { signer } = useWallet();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    if (!to && beneficiaries.length > 0) setTo(beneficiaries[0]);
  }, [beneficiaries, to]);

  const amountValid = (() => {
    try {
      if (amount === "") return false;
      const parsed = parseUnits(amount, decimals);
      return parsed > 0n && parsed <= balance;
    } catch { return false; }
  })();

  const canWithdraw =
    !!signer &&
    !paused &&
    balance > 0n &&
    amountValid &&
    isConfiguredAddress(to) &&
    beneficiaries.includes(to.toLowerCase());

  const submit = async () => {
    if (!signer) return;
    setPhase({ kind: "submitting" });
    try {
      const parsed = parseUnits(amount, decimals);
      const treasury = new Contract(treasuryAddress, TREASURY_ABI, signer);
      const tx = (await treasury.withdraw(tokenAddress, to, parsed)) as { hash: string; wait(): Promise<{ hash?: string } | null> };
      const receipt = await tx.wait();
      setPhase({ kind: "success", hash: receipt?.hash ?? tx.hash });
      setAmount("");
      onReload();
    } catch (e) {
      setPhase({ kind: "error", msg: (e as Error).message?.slice(0, 80) ?? "Failed" });
    }
  };

  return (
    <tr className="border-t border-[var(--color-border)]">
      <td className="px-5 py-3">
        <div className="font-medium">{symbol}</div>
      </td>
      <td className="px-5 py-3 text-right font-mono text-sm">
        {fmt(balance, decimals, symbol)}
      </td>
      <td className="px-5 py-3">
        {beneficiaries.length === 0 ? (
          <span className="text-xs text-[var(--color-text-muted)]">No beneficiaries — add one below</span>
        ) : (
          <div className="flex items-center gap-2 justify-end">
            <select
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs"
            >
              {beneficiaries.map((b) => (
                <option key={b} value={b}>{shortAddr(b)}</option>
              ))}
            </select>
            <input
              type="text"
              placeholder={`Amount (${symbol})`}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-28 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs"
            />
            <button
              type="button"
              disabled={!canWithdraw || phase.kind === "submitting"}
              onClick={() => void submit()}
              className="rounded-md bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              {phase.kind === "submitting" ? "Sending…" : "Withdraw"}
            </button>
          </div>
        )}
        {phase.kind === "error" && (
          <div className="mt-1 text-right text-[10px] text-[var(--color-danger)]">{phase.msg}</div>
        )}
        {phase.kind === "success" && (
          <div className="mt-1 text-right font-mono text-[10px] text-[var(--color-success)]">
            Done {phase.hash.slice(0, 10)}…
          </div>
        )}
      </td>
    </tr>
  );
}

function BeneficiaryManager({
  treasuryAddress,
  beneficiaries,
  reloadKey: _reloadKey,
  onReload,
}: {
  treasuryAddress: string;
  beneficiaries: string[];
  reloadKey: number;
  onReload: () => void;
}) {
  const { signer } = useWallet();
  const [newAddr, setNewAddr] = useState("");
  const [addPhase, setAddPhase] = useState<Phase>({ kind: "idle" });

  // Use the shared EVM-address validator rather than a local regex.
  // (isConfiguredAddress only rejects empty/zero — not malformed input —
  //  so it's not a substitute for format validation here.)
  const addrValid = isValidEvmAddress(newAddr.trim());

  const add = async () => {
    if (!signer || !addrValid) return;
    setAddPhase({ kind: "submitting" });
    try {
      const treasury = new Contract(treasuryAddress, TREASURY_ABI, signer);
      const tx = (await treasury.setBeneficiary(newAddr.trim(), true)) as { hash: string; wait(): Promise<{ hash?: string } | null> };
      await tx.wait();
      setAddPhase({ kind: "success", hash: tx.hash });
      setNewAddr("");
      onReload();
    } catch (e) {
      setAddPhase({ kind: "error", msg: (e as Error).message?.slice(0, 80) ?? "Failed" });
    }
  };

  const makeRemove = (addr: string) => async () => {
    if (!signer) return;
    const treasury = new Contract(treasuryAddress, TREASURY_ABI, signer);
    const tx = (await treasury.setBeneficiary(addr, false)) as { hash: string; wait(): Promise<{ hash?: string } | null> };
    await tx.wait();
    onReload();
  };

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="border-b border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-3">
        <div className="font-medium">Beneficiary allowlist</div>
        <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">
          Addresses permitted to receive funds via <code className="font-mono">withdraw()</code>.
          Only the owner (multisig) can add or remove.
        </div>
      </div>

      {/* Current list */}
      {beneficiaries.length === 0 ? (
        <div className="px-5 py-4 text-sm text-[var(--color-text-muted)]">
          No beneficiaries registered — add one below.
        </div>
      ) : (
        <div className="divide-y divide-[var(--color-border)]">
          {beneficiaries.map((addr) => (
            <BeneficiaryRow key={addr} addr={addr} onRemove={makeRemove(addr)} />
          ))}
        </div>
      )}

      {/* Add new */}
      <div className="border-t border-[var(--color-border)] px-5 py-3">
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="0x… EOA address to add"
            value={newAddr}
            onChange={(e) => setNewAddr(e.target.value)}
            className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 font-mono text-xs"
          />
          <button
            type="button"
            disabled={!addrValid || !signer || addPhase.kind === "submitting"}
            onClick={() => void add()}
            className="rounded-md bg-[var(--color-primary)] px-4 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {addPhase.kind === "submitting" ? "Adding…" : "Add"}
          </button>
        </div>
        {addPhase.kind === "error" && (
          <div className="mt-1 text-[10px] text-[var(--color-danger)]">{addPhase.msg}</div>
        )}
        {addPhase.kind === "success" && (
          <div className="mt-1 text-[10px] text-[var(--color-success)]">Added</div>
        )}
      </div>
    </div>
  );
}

function BeneficiaryRow({
  addr,
  onRemove,
}: {
  addr: string;
  onRemove: () => Promise<void>;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const remove = async () => {
    setPhase({ kind: "submitting" });
    try {
      await onRemove();
      setPhase({ kind: "success", hash: "" });
    } catch (e) {
      setPhase({ kind: "error", msg: (e as Error).message?.slice(0, 60) ?? "Failed" });
    }
  };

  return (
    <div className="flex items-center justify-between px-5 py-2.5">
      <span className="font-mono text-xs text-[var(--color-text)]">{addr}</span>
      <div className="flex items-center gap-3">
        {phase.kind === "error" && (
          <span className="text-[10px] text-[var(--color-danger)]">{phase.msg}</span>
        )}
        {phase.kind === "success" && (
          <span className="text-[10px] text-[var(--color-success)]">Removed</span>
        )}
        <button
          type="button"
          disabled={phase.kind === "submitting"}
          onClick={() => void remove()}
          className="rounded border border-[var(--color-danger)] px-2.5 py-0.5 text-[10px] font-medium text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white disabled:opacity-40"
        >
          {phase.kind === "submitting" ? "…" : "Remove"}
        </button>
      </div>
    </div>
  );
}
