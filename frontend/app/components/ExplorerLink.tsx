import { getExplorerTxUrl, getExplorerAddressUrl } from "../lib/explorer";
import { shortenAddress } from "../lib/utils";

interface Props {
  kind: "tx" | "address";
  value: string;
  chainId: number | null | undefined;
  className?: string;
}

/** Renders a tx hash / address as an explorer link; plain text when the
 *  chain has no configured explorer. */
export default function ExplorerLink({ kind, value, chainId, className }: Props) {
  const url = kind === "tx"
    ? getExplorerTxUrl(chainId, value)
    : getExplorerAddressUrl(chainId, value);
  const display = shortenAddress(value);
  const base = `font-mono text-xs ${className ?? ""}`.trim();
  const aria = `View ${kind === "tx" ? "transaction" : "address"} ${value} on block explorer`;

  if (!url) {
    return <span className={base} title={value} aria-label={value}>{display}</span>;
  }
  return (
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
  );
}
