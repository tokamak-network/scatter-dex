import { bigintToHex } from "@zkscatter/sdk/util";
import { saveFile as sdkSaveFile } from "@zkscatter/sdk/storage";
import type { OrderRecord } from "./orders";

/** Local-time `YYYYMMDD-HHMMSS` slug for filenames so users sort
 *  bundles by browser locale rather than UTC. */
function timestampSlug(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** Build the JSON payload that backs the per-order claim file.
 *  Pulled out of the download / persist helpers so tests and a
 *  future Orders-page "Re-download backup" action can share the
 *  exact same serializer. Bigints serialise as 0x-prefixed hex to
 *  round-trip cleanly through JSON.parse. */
export function buildClaimsBundleJson(
  order: OrderRecord,
  ctx: { relayerUrl: string | null; chainId: number },
): string {
  if (!order.claim) {
    throw new Error("order has no claim material to back up");
  }
  return JSON.stringify(
    {
      version: 1,
      kind: "scatter-pro-claims-bundle",
      createdAt: new Date().toISOString(),
      chainId: ctx.chainId,
      relayerUrl: ctx.relayerUrl,
      order: {
        id: order.id,
        label: order.label,
        side: order.side,
        pair: order.pair,
        price: order.price,
        size: order.size,
        noteId: order.noteId,
        nonce: order.nonce !== undefined ? bigintToHex(order.nonce) : undefined,
        createdAtMs: order.createdAt,
      },
      claim: {
        secret: bigintToHex(order.claim.secret),
        recipient: order.claim.recipient,
        token: order.claim.token,
        amount: bigintToHex(order.claim.amount),
        releaseTime: bigintToHex(order.claim.releaseTime),
        leafIndex: order.claim.leafIndex,
        claimsRoot: order.claim.claimsRoot,
      },
    },
    null,
    2,
  );
}

/** Filename for the per-order claim file inside the user's notes
 *  folder. Mirrors Pay's per-run pattern (`zkscatter-run-{id}.json`):
 *  one file per order keeps the diff each save writes tiny and
 *  side-steps the "two tabs racing on an aggregate file" problem
 *  that the orders adapter has to handle with an in-memory mutex. */
export function orderClaimsBundleFilename(order: OrderRecord): string {
  return `scatter-pro-claims-${order.label}.json`;
}

/** Persist the per-order claim bundle into the user's notes folder
 *  (`scatter-pro-claims-{label}.json`). Pro mounts behind
 *  `<FolderGate>` so a folder is guaranteed to be selected by the
 *  time this fires; the SDK's `saveFile` writes through the active
 *  `FileSystemDirectoryHandle`. Failures are logged but never
 *  thrown — they degrade to "no folder backup" while the IDB-side
 *  order record stays intact. The `io` injection point lets the
 *  unit test exercise the path without touching real FS handles. */
export async function persistOrderClaimsBundle(
  order: OrderRecord,
  ctx: { relayerUrl: string | null; chainId: number },
  io: {
    saveFile: (name: string, content: string) => Promise<void>;
  } = { saveFile: sdkSaveFile },
): Promise<void> {
  try {
    const json = buildClaimsBundleJson(order, ctx);
    await io.saveFile(orderClaimsBundleFilename(order), json);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[scatter pro claims] folder persist failed", e);
  }
}

/** Trigger a browser download of the per-order claim bundle. The
 *  bundle carries every secret a user needs to release the order
 *  later, so we hand it to them as a JSON file the moment Sign &
 *  submit succeeds. The folder copy (`persistOrderClaimsBundle`)
 *  is the in-workspace primary; this download is the off-folder
 *  off-device backup. Silent on non-DOM runtimes (SSR/test). */
export function downloadOrderClaimsBundle(
  order: OrderRecord,
  ctx: { relayerUrl: string | null; chainId: number },
): void {
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const json = buildClaimsBundleJson(order, ctx);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `scatter-pro-claims-${order.label}-${timestampSlug(order.createdAt)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revocation a tick — Safari otherwise cancels the
  // navigation before the download starts.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
