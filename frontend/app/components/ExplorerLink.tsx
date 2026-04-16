import { useState, useCallback } from "react";
import { Copy, Check } from "lucide-react";
import { getExplorerTxUrl, getExplorerAddressUrl } from "../lib/explorer";
import { shortenAddress } from "../lib/utils";

interface Props {
  kind: "tx" | "address";
  value: string;
  /** Optional: override the deployment's configured chain (EXPECTED_CHAIN_ID).
   *  Omit in normal cases — settlements and on-chain history are always
   *  for the deployment chain regardless of the connected wallet. */
  chainId?: number | null;
  /** Tailwind size token; defaults to `xs` to match the existing
   *  font-mono tables. Passed separately from `className` so callers
   *  don't have to fight `text-xs` with `text-sm` (no tailwind-merge
   *  in this project). */
  size?: "xs" | "sm";
  className?: string;
}

function CopyButton({ value, size }: { value: string; size: "xs" | "sm" }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);
  const iconSize = size === "xs" ? "w-3 h-3" : "w-3.5 h-3.5";
  return (
    <button
      onClick={copy}
      className="inline-flex items-center ml-1 text-on-surface-variant/40 hover:text-on-surface-variant/80 transition-colors"
      title="Copy to clipboard"
      aria-label={`Copy ${value}`}
    >
      {copied ? <Check className={`${iconSize} text-emerald-400`} /> : <Copy className={iconSize} />}
    </button>
  );
}

/** Renders a tx hash / address as an explorer link; plain text when the
 *  chain has no configured explorer. */
export default function ExplorerLink({ kind, value, chainId, size = "xs", className }: Props) {
  const url = kind === "tx"
    ? getExplorerTxUrl(chainId, value)
    : getExplorerAddressUrl(chainId, value);
  const display = shortenAddress(value);
  const base = `font-mono text-${size} ${className ?? ""}`.trim();
  const aria = `View ${kind === "tx" ? "transaction" : "address"} ${value} on block explorer`;

  if (!url) {
    return (
      <span className={`inline-flex items-center ${base}`}>
        <span title={value} aria-label={value}>{display}</span>
        <CopyButton value={value} size={size} />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={`${base} hover:underline`}
        title={value}
        aria-label={aria}
      >
        {display}
      </a>
      <CopyButton value={value} size={size} />
    </span>
  );
}
