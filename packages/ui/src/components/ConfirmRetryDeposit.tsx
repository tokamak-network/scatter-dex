import { Modal } from "./Modal";
import { Button } from "./Button";

/** Shown when a deposit-retry can't be proven safe on-chain — the prior
 *  deposit is neither in the tree nor provably dropped (an atomic-batch
 *  note with no tx hash, an unreadable receipt, or an unknown status).
 *  Re-depositing then would lock 2× the funds in a second note, so make
 *  the user explicitly acknowledge. Safe default = don't retry: "Wait /
 *  cancel" is the primary action; "Deposit again anyway" is de-emphasized;
 *  the backdrop/Esc maps to cancel.
 *
 *  Shared by Pay and Pro so the load-bearing risk copy can't drift between
 *  products. Each app passes its own `explorerHref` (the user's address on
 *  the active network's explorer); omit it to fall back to plain text. */
export function ConfirmRetryDeposit({
  explorerHref,
  onCancel,
  onConfirm,
}: {
  /** Link to the user's address on the block explorer, when known. */
  explorerHref?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open
      onClose={onCancel}
      title="Deposit again?"
      closeOnBackdrop={false}
    >
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">
        We couldn&apos;t verify whether your <strong>previous deposit</strong>{" "}
        went through. It may still be pending, or already mined but unconfirmed
        here — we can&apos;t tell, and we can&apos;t prove it was dropped
        either.
      </p>
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">
        If it actually landed, depositing again would lock{" "}
        <strong>twice the funds</strong> in a second, separate note.{" "}
        {explorerHref ? (
          <>
            Check{" "}
            <a
              href={explorerHref}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              your recent transactions
            </a>{" "}
            first.
          </>
        ) : (
          "Check the block explorer first."
        )}
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onCancel}>Wait / cancel</Button>
        <Button variant="secondary" onClick={onConfirm}>
          Deposit again anyway
        </Button>
      </div>
    </Modal>
  );
}
