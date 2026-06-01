/** Shared PEM/DER helpers for the operator-CA crypto modules (client-only:
 *  uses the browser `atob`/`btoa`). */

/** Strip PEM armor and base64-decode the body to DER bytes. */
export function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Base64-encode raw bytes. */
export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Wrap DER bytes in PEM armor (64-char lines). */
export function wrapPem(der: ArrayBuffer, label: string): string {
  const lines = toBase64(der).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}
