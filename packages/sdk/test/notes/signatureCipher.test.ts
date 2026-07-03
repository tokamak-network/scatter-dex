// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import { createSignatureNoteCipher } from "../../src/notes/signatureCipher";

// Deterministic 65-byte "signatures" standing in for personal_sign output.
const SIG_A = ("0x" + "ab".repeat(65)) as string;
const SIG_B = ("0x" + "cd".repeat(65)) as string;

describe("createSignatureNoteCipher", () => {
  it("round-trips plaintext", async () => {
    const cipher = createSignatureNoteCipher(SIG_A);
    const plaintext = JSON.stringify({ id: "n1", noteHex: { ownerSecret: "0x6f" } });
    const ct = await cipher.encrypt(plaintext);
    expect(ct).toMatch(/^v1:/);
    expect(ct).not.toContain("ownerSecret");
    await expect(cipher.decrypt(ct)).resolves.toBe(plaintext);
  });

  it("re-derives the same key from the same signature (fresh instance decrypts)", async () => {
    const ct = await createSignatureNoteCipher(SIG_A).encrypt("hello");
    await expect(createSignatureNoteCipher(SIG_A).decrypt(ct)).resolves.toBe("hello");
  });

  it("randomizes the IV — same plaintext, different ciphertexts", async () => {
    const cipher = createSignatureNoteCipher(SIG_A);
    const [a, b] = await Promise.all([cipher.encrypt("same"), cipher.encrypt("same")]);
    expect(a).not.toBe(b);
  });

  it("rejects decryption under a different signature's key", async () => {
    const ct = await createSignatureNoteCipher(SIG_A).encrypt("secret");
    await expect(createSignatureNoteCipher(SIG_B).decrypt(ct)).rejects.toThrow();
  });

  it("rejects a tampered ciphertext (GCM auth)", async () => {
    const cipher = createSignatureNoteCipher(SIG_A);
    const ct = await cipher.encrypt("secret");
    const [v, iv, body] = ct.split(":");
    const flipped = Buffer.from(body!, "base64");
    flipped[0]! ^= 0xff;
    const tampered = `${v}:${iv}:${flipped.toString("base64")}`;
    await expect(cipher.decrypt(tampered)).rejects.toThrow();
  });

  it("rejects an unrecognized envelope", async () => {
    const cipher = createSignatureNoteCipher(SIG_A);
    await expect(cipher.decrypt("v9:AAAA:BBBB")).rejects.toThrow(/envelope/);
    await expect(cipher.decrypt("not-an-envelope")).rejects.toThrow(/envelope/);
  });

  it("rejects a malformed signature input", () => {
    expect(() => createSignatureNoteCipher("0x1234")).toThrow(/65-byte/);
    expect(() => createSignatureNoteCipher("nope")).toThrow(/65-byte/);
  });

  it("derives a key independent of the EdDSA private key (keccak of sig)", async () => {
    // The EdDSA key is keccak256(signature); the cipher key is
    // HKDF(signature). Sanity-check the cipher isn't accidentally keyed on
    // the keccak value by decrypting with a cipher built from that hash.
    const keccakAsSig = ethers.keccak256(SIG_A) + "00".repeat(33); // pad to 65 bytes
    const ct = await createSignatureNoteCipher(SIG_A).encrypt("independent");
    await expect(createSignatureNoteCipher(keccakAsSig).decrypt(ct)).rejects.toThrow();
  });
});
