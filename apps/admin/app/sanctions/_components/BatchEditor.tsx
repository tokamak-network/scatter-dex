"use client";

import { useCallback, useMemo, useState } from "react";
import { Contract, type Signer } from "ethers";
import { useWallet } from "@zkscatter/sdk/react";
import { AdminWriteCard } from "../../components/AdminWriteCard";
import { parseAddressList } from "../../lib/parseAddressList";
import { useSanctions } from "./SanctionsContext";

const SANCTIONS_ABI = [
  "function addSanctionsBatch(address[] calldata addrs) external",
  "function removeSanctionsBatch(address[] calldata addrs) external",
];

// Matches `SanctionsList.MAX_BATCH_SIZE` in contracts/src/SanctionsList.sol.
const MAX_BATCH_SIZE = 200;

interface Props {
  address: string;
  onSuccess?: () => void;
}

export function BatchEditor({ address, onSuccess }: Props) {
  const { signer } = useWallet();
  const { refresh } = useSanctions();
  const [text, setText] = useState("");
  const [action, setAction] = useState<"add" | "remove">("add");

  // Memoize so paste-and-edit on a 200-row list doesn't re-scan the
  // string + re-run the regex on every keystroke.
  const parsed = useMemo(() => parseAddressList(text), [text]);
  const overLimit = parsed.valid.length > MAX_BATCH_SIZE;
  const valid = parsed.valid.length > 0 && parsed.invalid.length === 0 && !overLimit;

  const submit = useCallback(async () => {
    if (!signer || !valid) throw new Error("Invalid batch");
    return invoke(
      signer,
      address,
      action === "add" ? "addSanctionsBatch" : "removeSanctionsBatch",
      parsed.valid,
    );
  }, [signer, valid, address, action, parsed.valid]);

  return (
    <AdminWriteCard
      title="Batch add / remove"
      description={`SanctionsList.${action === "add" ? "addSanctionsBatch" : "removeSanctionsBatch"}(address[]). Paste up to ${MAX_BATCH_SIZE} addresses (whitespace, comma, or newline separated).`}
      submitLabel={
        action === "add"
          ? `Add ${parsed.valid.length} sanction${parsed.valid.length === 1 ? "" : "s"}`
          : `Remove ${parsed.valid.length} sanction${parsed.valid.length === 1 ? "" : "s"}`
      }
      disabled={!valid}
      onSubmit={submit}
      onSuccess={() => {
        setText("");
        refresh();
        onSuccess?.();
      }}
    >
      <div className="flex gap-4 text-xs">
        <label className="flex items-center gap-2">
          <input type="radio" checked={action === "add"} onChange={() => setAction("add")} />
          Add
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            checked={action === "remove"}
            onChange={() => setAction("remove")}
          />
          Remove
        </label>
      </div>
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-wide text-[var(--color-text-subtle)]">
          Addresses
        </span>
        <textarea
          rows={6}
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs"
          placeholder="0x…&#10;0x…&#10;0x…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <Summary parsed={parsed} overLimit={overLimit} />
    </AdminWriteCard>
  );
}

function Summary({
  parsed,
  overLimit,
}: {
  parsed: ReturnType<typeof parseAddressList>;
  overLimit: boolean;
}) {
  if (parsed.valid.length === 0 && parsed.invalid.length === 0) return null;
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs">
      <div>
        Valid: <strong>{parsed.valid.length}</strong> · Invalid:{" "}
        <strong className={parsed.invalid.length > 0 ? "text-[var(--color-danger)]" : ""}>
          {parsed.invalid.length}
        </strong>
      </div>
      {overLimit && (
        <div className="mt-1 text-[var(--color-danger)]">
          Over the {MAX_BATCH_SIZE}-address contract limit. Split into multiple submissions.
        </div>
      )}
      {parsed.invalid.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[var(--color-danger)]">
            Show invalid entries
          </summary>
          <ul className="mt-1 list-disc pl-4 font-mono text-[10px] text-[var(--color-danger)]">
            {parsed.invalid.slice(0, 10).map((bad, i) => (
              <li key={`${bad}-${i}`}>{bad}</li>
            ))}
            {parsed.invalid.length > 10 && <li>… +{parsed.invalid.length - 10} more</li>}
          </ul>
        </details>
      )}
    </div>
  );
}

async function invoke(signer: Signer, address: string, fn: string, addrs: string[]) {
  const c = new Contract(address, SANCTIONS_ABI, signer);
  const setter = (
    c as unknown as Record<
      string,
      (a: string[]) => Promise<{ hash: string; wait(): Promise<{ hash?: string } | null> }>
    >
  )[fn];
  return (await setter(addrs)) as {
    hash: string;
    wait(): Promise<{ hash?: string } | null>;
  };
}
