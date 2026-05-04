"use client";

import { Modal } from "@zkscatter/ui";
import { STEPPER_LABELS } from "../_templates";

export function Stepper({ step, onJump }: { step: number; onJump: (n: number) => void }) {
  return (
    <div className="flex gap-2">
      {STEPPER_LABELS.map((l, i) => {
        const n = i + 1;
        const active = n === step;
        const done = n < step;
        const clickable = done || active;
        return (
          <button
            key={l}
            disabled={!clickable}
            onClick={() => clickable && onJump(n)}
            className={`flex-1 rounded-md border px-3 py-2 text-left text-sm ${
              active
                ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
                : done
                ? "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)]"
                : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-subtle)]"
            }`}
          >
            <span className="mr-2 font-semibold">{n}</span>
            {l}
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** Two-cell DL row used by the Review step. Renders as `<dt>` + `<dd>`
 *  inside a parent `<dl>` so a fragment is the right wrapper. `v`
 *  accepts ReactNode so callers can drop in inline editors (e.g. a
 *  re-pick datetime input when the claim time slips into the buffer
 *  zone). */
export function ReviewRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt className="py-2 text-[var(--color-text-muted)]">{k}</dt>
      <dd className="py-2 text-right font-medium">{v}</dd>
    </>
  );
}

/** Bordered card grouping a set of `ReviewRow`s under a heading. The
 *  Review step has run-level details, schedule, and settlement
 *  details — visually splitting them keeps the eye from scanning one
 *  long stripe. */
export function ReviewSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <h3 className="mb-2 text-sm font-semibold text-[var(--color-text-muted)]">{title}</h3>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 divide-y divide-[var(--color-border)] text-sm">
        {children}
      </dl>
    </section>
  );
}

export function ConfirmLargeAmount({
  total,
  token,
  recipients,
  onCancel,
  onConfirm,
}: {
  total: number;
  token: string;
  recipients: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open onClose={onCancel} title="Confirm large payout">
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">
        You&apos;re about to send{" "}
        <strong>
          {total.toLocaleString()} {token}
        </strong>{" "}
        to <strong>{recipients} recipients</strong>. Once signed, this run cannot be reversed —
        recipients can claim it any time, forever.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-md border border-[var(--color-border-strong)] px-4 py-2 text-sm"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
        >
          Sign &amp; submit
        </button>
      </div>
    </Modal>
  );
}
