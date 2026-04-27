"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet, shortAddr } from "@zkscatter/sdk/react";
import { chainName, explorerLink } from "@zkscatter/sdk";
import { getNetworkConfig } from "../_lib/network";

export function WalletButton() {
  const { account, chainId, walletName, connect, disconnect, connectError } = useWallet();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (!account) {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={() => void connect()}
          className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
        >
          Connect Wallet
        </button>
        {connectError && (
          <span className="text-xs text-[var(--color-error,#dc2626)]">
            {connectError === "no-wallet" ? "Install MetaMask to continue." : connectError}
          </span>
        )}
      </div>
    );
  }

  const expectedChain = getNetworkConfig().chainId;
  const wrongChain = chainId !== null && chainId !== expectedChain;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs hover:border-[var(--color-border-strong)]"
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            wrongChain ? "bg-[var(--color-warning)]" : "bg-[var(--color-success)]"
          }`}
        />
        <span className="font-mono">{shortAddr(account)}</span>
        <span className="text-[var(--color-text-muted)]">·</span>
        <span className="text-[var(--color-text-muted)]">
          {chainId !== null ? chainName(chainId) : "—"}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 text-sm shadow-lg">
          <div className="px-3 py-2 text-xs text-[var(--color-text-muted)]">
            <div>{walletName ?? "Connected wallet"}</div>
            <div className="mt-0.5 break-all font-mono text-[10px]">{account}</div>
          </div>
          {wrongChain && (
            <div className="mx-3 my-1 rounded bg-[var(--color-warning-soft)] px-2 py-1 text-xs text-[var(--color-warning)]">
              Switch network to {chainName(expectedChain)} to continue.
            </div>
          )}
          <MenuItem onClick={() => navigator.clipboard.writeText(account)}>
            Copy address
          </MenuItem>
          <ExplorerLink chainId={chainId} account={account} />
          <MenuItem onClick={() => { disconnect(); setOpen(false); }}>
            Disconnect
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-primary-soft)]"
    >
      {children}
    </button>
  );
}

function ExplorerLink({ chainId, account }: { chainId: number | null; account: string }) {
  if (chainId === null) return null;
  const href = explorerLink({ chainId }, "address", account);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="block px-3 py-1.5 hover:bg-[var(--color-primary-soft)]"
    >
      View on explorer ↗
    </a>
  );
}
