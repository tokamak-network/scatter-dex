"use client";

import { buildExplorerTxUrl } from "../_lib/explorerUrl";

/** Inline transaction link — the canonical "tx <short-hash↗>" UI
 *  pattern shared by Withdraw / Send / Source-notes panels. Renders
 *  a short-hash text link to the explorer when `explorerBase` is
 *  configured, and falls back to plain truncated text when it isn't
 *  (localhost / disconnected). Centralises the trailing-slash
 *  normalisation, the short-hash truncation, and the safe-URL
 *  protocol gate so the four old inline implementations can't drift.
 *
 *  The link- and fallback-text variants render with distinct
 *  classNames so a non-clickable hash never looks underlined — the
 *  pre-extraction inline copies in Send / Withdraw / SourceNotes
 *  used plain `font-mono` for the no-explorer span, and reusing the
 *  link's underline would be a UX regression.
 *
 *  Use the chip variant (`TxHashChip` in payouts/detail) when the
 *  surface also needs a Copy button — that one carries clipboard
 *  state and is a separate component. */
export function TxLink({
  txHash,
  explorerBase,
  className,
  fallbackClassName,
}: {
  txHash: string;
  explorerBase: string | undefined;
  /** Class for the `<a>` link rendered when an explorer URL is
   *  available. Default matches Withdraw / Send / SourceNotes
   *  status-line styling. */
  className?: string;
  /** Class for the `<span>` fallback when no safe explorer URL can
   *  be built. Default omits the underline so non-clickable text
   *  doesn't masquerade as a link. */
  fallbackClassName?: string;
}) {
  const short = `${txHash.slice(0, 10)}…${txHash.slice(-6)}`;
  const url = buildExplorerTxUrl(explorerBase, txHash);
  if (!url) {
    return (
      <span className={fallbackClassName ?? "font-mono"} title={txHash}>
        {short}
      </span>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className={className ?? "font-mono underline decoration-dotted"}
      title={txHash}
    >
      {short}
    </a>
  );
}
