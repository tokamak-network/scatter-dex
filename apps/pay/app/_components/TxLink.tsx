"use client";

import { buildExplorerTxUrl } from "../_lib/explorerUrl";

/** Inline transaction link — the canonical "tx <short-hash↗>" UI
 *  pattern shared by Withdraw / Send / Source-notes panels. Renders
 *  a short-hash text link to the explorer when `explorerBase` is
 *  configured, and falls back to plain truncated text when it isn't
 *  (localhost / disconnected). Centralises the trailing-slash
 *  normalisation and the short-hash truncation so the four old
 *  inline implementations can't drift.
 *
 *  Use the chip variant (`TxHashChip` in payouts/detail) when the
 *  surface also needs a Copy button — that one carries clipboard
 *  state and is a separate component. This one is the text-only
 *  variant for status messages. */
export function TxLink({
  txHash,
  explorerBase,
  className,
}: {
  txHash: string;
  explorerBase: string | undefined;
  /** Override the default text-link styling. Keep undefined to use
   *  the canonical `font-mono underline decoration-dotted` look the
   *  withdraw / send / source-notes status lines all share. */
  className?: string;
}) {
  const short = `${txHash.slice(0, 10)}…${txHash.slice(-6)}`;
  const url = buildExplorerTxUrl(explorerBase, txHash);
  const cls = className ?? "font-mono underline decoration-dotted";
  if (!url) {
    return (
      <span className={cls} title={txHash}>
        {short}
      </span>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className={cls}
      title={txHash}
    >
      {short}
    </a>
  );
}
