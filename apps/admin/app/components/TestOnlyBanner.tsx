/** Proof-of-concept warning shown on the operator-CA surfaces that generate
 *  key material in the browser (Root CA generation, operator-cert issuance).
 *
 *  Per the PKI design doc §12, browser-generated CA keys and direct Root
 *  signing are a devnet/test PoC only — production requires an HSM-backed
 *  Issuing CA tier. This banner makes that boundary explicit on every page
 *  that exercises the PoC path so it can't be mistaken for a production tool.
 */
export function TestOnlyBanner({ context }: { context?: string }) {
  return (
    <div
      role="note"
      className="flex items-start gap-3 rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-4 py-3 text-sm text-[var(--color-text-muted)]"
    >
      <span aria-hidden className="text-base leading-none">
        ⚠
      </span>
      <div>
        <span className="font-semibold text-[var(--color-warning)]">
          Test / devnet only — not for production.
        </span>{" "}
        {context && `${context} `}
        Browser-generated CA keys and direct Root signing are a proof-of-concept.
        Production requires an HSM-backed Issuing CA tier with offline Root,
        revocation (CRL/OCSP), and dual control — see the PKI design doc §12.
      </div>
    </div>
  );
}
