import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { AdminSiweAuth, makeAdminSiweAuth } from "../src/core/admin-siwe.js";

// Canned operator + attacker EOAs. The corresponding private keys are
// publicly known anvil dev keys, used solely for in-process signing.
const OPERATOR_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const operator = new ethers.Wallet(OPERATOR_PK);
const ATTACKER_PK =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const attacker = new ethers.Wallet(ATTACKER_PK);

function buildAuth(activeAddresses: Set<string>): AdminSiweAuth {
  const lowered = new Set([...activeAddresses].map((a) => a.toLowerCase()));
  return new AdminSiweAuth(async (addr) => lowered.has(addr.toLowerCase()));
}

describe("AdminSiweAuth", () => {
  it("issues unique nonces with future expiry", () => {
    const auth = buildAuth(new Set());
    const a = auth.issueChallenge();
    const b = auth.issueChallenge();
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.expiresAt).toBeGreaterThan(Date.now());
    expect(b.expiresAt).toBeGreaterThan(Date.now());
  });

  it("creates a session for an active relayer signing a fresh challenge", async () => {
    const auth = buildAuth(new Set([operator.address]));
    const { nonce, message } = auth.issueChallenge();
    const signature = await operator.signMessage(message);
    const session = await auth.createSession({ nonce, message, signature });
    expect(session.address.toLowerCase()).toBe(operator.address.toLowerCase());
    expect(session.expiresAt).toBeGreaterThan(Date.now());
    expect(auth.verifySession(session.token)).toBe(operator.address.toLowerCase());
  });

  it("rejects an unknown nonce", async () => {
    const auth = buildAuth(new Set([operator.address]));
    const fakeNonce = "ff".repeat(32);
    const message = `manually constructed without going through issueChallenge — nonce: ${fakeNonce}`;
    const signature = await operator.signMessage(message);
    await expect(
      auth.createSession({ nonce: fakeNonce, message, signature }),
    ).rejects.toThrow(/Unknown or expired/i);
  });

  it("rejects a signer that is not in the registry", async () => {
    const auth = buildAuth(new Set([operator.address]));
    const { nonce, message } = auth.issueChallenge();
    const signature = await attacker.signMessage(message);
    // buildAuth constructs the shared AdminSiweAuth with default options, so the
    // rejection carries the shared default wording. Production
    // (makeAdminSiweAuth) overrides it with the operator-specific message;
    // this test only asserts that a non-admin signer is rejected.
    await expect(
      auth.createSession({ nonce, message, signature }),
    ).rejects.toThrow(/not an authorized admin/i);
  });

  it("burns the nonce even when the signature does not verify", async () => {
    const auth = buildAuth(new Set([operator.address]));
    const { nonce, message } = auth.issueChallenge();
    await expect(
      auth.createSession({
        nonce,
        message,
        signature: "0x" + "00".repeat(65),
      }),
    ).rejects.toThrow();
    // Same nonce is gone — replay attempt must fail with the
    // "unknown nonce" message even though the signature would now
    // be valid.
    const goodSig = await operator.signMessage(message);
    await expect(
      auth.createSession({ nonce, message, signature: goodSig }),
    ).rejects.toThrow(/Unknown or expired/i);
  });

  it("rejects a message that does not exactly match the issued challenge", async () => {
    const auth = buildAuth(new Set([operator.address]));
    const { nonce, message } = auth.issueChallenge();
    // Even a message that *contains* the nonce is rejected unless it
    // is byte-identical to the issued challenge — that's the
    // defense against an attacker tricking the operator into signing
    // an innocuous-looking message that happens to embed the nonce.
    const tampered = `Please confirm your transfer. Original message follows: ${message}`;
    const signature = await operator.signMessage(tampered);
    await expect(
      auth.createSession({ nonce, message: tampered, signature }),
    ).rejects.toThrow(/does not match/i);
  });

  it("revokeSession invalidates a previously valid token", async () => {
    const auth = buildAuth(new Set([operator.address]));
    const { nonce, message } = auth.issueChallenge();
    const signature = await operator.signMessage(message);
    const session = await auth.createSession({ nonce, message, signature });
    auth.revokeSession(session.token);
    expect(auth.verifySession(session.token)).toBeNull();
  });

  it("verifySession returns null for an unknown token", () => {
    const auth = buildAuth(new Set([operator.address]));
    expect(auth.verifySession("ff".repeat(32))).toBeNull();
  });
});

describe("makeAdminSiweAuth (operator self-auth)", () => {
  it("admits the node's own operator wallet", async () => {
    const auth = makeAdminSiweAuth(operator.address);
    const { nonce, message } = auth.issueChallenge();
    const signature = await operator.signMessage(message);
    const session = await auth.createSession({ nonce, message, signature });
    expect(session.address.toLowerCase()).toBe(operator.address.toLowerCase());
    expect(auth.verifySession(session.token)).toBe(operator.address.toLowerCase());
  });

  it("rejects any other wallet — e.g. a different relayer's operator", async () => {
    const auth = makeAdminSiweAuth(operator.address);
    const { nonce, message } = auth.issueChallenge();
    const signature = await attacker.signMessage(message);
    await expect(
      auth.createSession({ nonce, message, signature }),
    ).rejects.toThrow(/not this relayer's operator/i);
  });

  it("matches the operator address case-insensitively", async () => {
    // The node may pass a checksummed or upper-cased address; recovery
    // yields a checksummed address — comparison must not depend on casing.
    const auth = makeAdminSiweAuth(operator.address.toUpperCase());
    const { nonce, message } = auth.issueChallenge();
    const signature = await operator.signMessage(message);
    const session = await auth.createSession({ nonce, message, signature });
    expect(session.address.toLowerCase()).toBe(operator.address.toLowerCase());
  });
});
