"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ethers } from "ethers";
import { useWallet, shortAddr } from "@zkscatter/sdk/react";
import { formatTokenLabel } from "@zkscatter/sdk";
import { decodeClaimPackage, type ClaimPackage } from "@zkscatter/sdk/notes";
import { addClaimInboxEntry } from "@zkscatter/sdk/storage";
import { useFolder } from "../lib/folder";
import { formatWhen } from "../lib/format";
import { WorkspaceBar } from "../components/WorkspaceBar";

/** Recipient landing page for a shared claim link
 *  (`/claim?id=<linkId>#<base64url-ClaimPackage>`). Decodes the
 *  package from the URL fragment, summarises it for the recipient,
 *  and offers a one-click "Add to Claims inbox" path. The actual
 *  claim is submitted from the /claims page; centralising it there
 *  keeps a single code path for both pasted-via-inbox and arrived-
 *  via-link entries.
 *
 *  Hash payload, not query string: a base64url-encoded ClaimPackage
 *  is ~1 KB and carries the per-claim secret. Living in the URL
 *  fragment keeps it from leaking to the server (browsers don't
 *  send the fragment in HTTP requests) — same convention Pay
 *  uses. */
export default function ClaimPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-md py-10 text-center text-sm text-[var(--color-text-muted)]">
          Loading claim…
        </div>
      }
    >
      <ClaimInner />
    </Suspense>
  );
}

function ClaimInner() {
  const searchParams = useSearchParams();
  const linkId = searchParams?.get("id") ?? "";
  const { account } = useWallet();
  const folder = useFolder();
  const [parsed, setParsed] = useState<ClaimPackage | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "duplicate" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  // Decode the hash on mount. SSR-safe — we read `window.location`
  // only inside the effect, never during render.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const fragment = window.location.hash.replace(/^#/, "").split("#", 1)[0];
    if (!fragment) {
      setParseError("No claim package in the URL — the link may have been truncated.");
      return;
    }
    try {
      setParsed(decodeClaimPackage(fragment));
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Auto-save once the folder is ready and we have a valid package.
  // No-op if already in the inbox (the SDK helper reports
  // `isNew: false` and we surface that as the `duplicate` state).
  useEffect(() => {
    if (!parsed || !folder.currentId || saveState !== "idle") return;
    setSaveState("saving");
    const rawInput = typeof window !== "undefined" ? window.location.href : "";
    addClaimInboxEntry({ rawInput, pkg: parsed })
      .then((res) => setSaveState(res.isNew ? "saved" : "duplicate"))
      .catch((err) => {
        setSaveError(err instanceof Error ? err.message : String(err));
        setSaveState("error");
      });
  }, [parsed, folder.currentId, saveState]);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Claim your share</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Someone shared a private trade with you. The amount and details
          are decoded from the link itself — nothing was sent to the server.
        </p>
      </header>

      <WorkspaceBar />

      {parseError && (
        <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-4 text-sm text-[var(--color-danger)]">
          <div className="font-medium">Couldn&apos;t decode the claim link</div>
          <div className="mt-1 text-xs">{parseError}</div>
        </div>
      )}

      {parsed && (
        <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
            Trade share details
          </h2>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <Row k="Amount" v={
              <span className="font-semibold">
                {ethers.formatUnits(BigInt(parsed.amount), parsed.tokenDecimals)}{" "}
                <span className="text-xs font-normal text-[var(--color-text-muted)]">
                  {formatTokenLabel(parsed.tokenSymbol)}
                </span>
              </span>
            } />
            <Row k="To" v={<span className="font-mono text-xs">{shortAddr(parsed.recipient)}</span>} />
            <Row k="From" v={
              <span className="font-mono text-xs">
                {parsed.senderLabel ? shortAddr(parsed.senderLabel) : "unknown"}
              </span>
            } />
            <Row k="Order" v={<span className="text-xs">{parsed.runLabel ?? "—"}</span>} />
            <Row k="Available" v={<span className="text-xs">{formatWhen(Number(BigInt(parsed.releaseTime)) * 1000)}</span>} />
            <Row k="Network" v={<span className="text-xs">chainId {parsed.chainId}</span>} />
          </dl>

          {account && account.toLowerCase() !== parsed.recipient.toLowerCase() && (
            <div className="mt-4 rounded border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
              The connected wallet (<span className="font-mono">{shortAddr(account)}</span>) doesn&apos;t
              match the recipient on this link. The claim contract will reject any tx
              you submit from a different address. Switch wallets or hand this link to
              the intended recipient.
            </div>
          )}
        </section>
      )}

      {parsed && !folder.currentId && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-text-muted)]">
          Pick a working folder first so the claim can be stored locally for
          you to claim later.
        </div>
      )}

      {parsed && folder.currentId && saveState === "saving" && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
          Saving to your Claims inbox…
        </div>
      )}

      {parsed && (saveState === "saved" || saveState === "duplicate") && (
        <div className="rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] p-4 text-sm">
          <div className="font-medium text-[var(--color-success)]">
            {saveState === "saved" ? "Added to your Claims inbox" : "Already in your Claims inbox"}
          </div>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            Open Claims to redeem this share once the release time is reached.
          </p>
          <div className="mt-3">
            <Link
              href="/claims"
              className="inline-block rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--color-primary-hover)]"
            >
              Open Claims →
            </Link>
          </div>
        </div>
      )}

      {parsed && saveState === "error" && saveError && (
        <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-3 text-xs text-[var(--color-danger)]">
          <div className="font-medium">Couldn&apos;t save to Claims</div>
          <div className="mt-1">{saveError}</div>
        </div>
      )}

      <footer className="text-[10px] text-[var(--color-text-subtle)]">
        Link id: <span className="font-mono">{linkId || "—"}</span>
      </footer>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt className="text-[var(--color-text-muted)]">{k}</dt>
      <dd className="text-right">{v}</dd>
    </>
  );
}
