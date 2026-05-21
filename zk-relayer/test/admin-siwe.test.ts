import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { AdminSiweAuth, formatChallengeMessage } from "../src/core/admin-siwe.js";

// A canned operator EOA — the wallet's address is the recovery target
// in every "happy path" assertion below. The corresponding private key
// is publicly known (anvil[0]), used solely for in-process signing.
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

async function sign(wallet: ethers.Wallet, message: string): Promise<string> {
  return wallet.signMessage(message);
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
    const { nonce } = auth.issueChallenge();
    const message = formatChallengeMessage({
      nonce,
      issuedAt: new Date().toISOString(),
    });
    const signature = await sign(operator, message);
    const session = await auth.createSession({ nonce, message, signature });
    expect(session.address.toLowerCase()).toBe(operator.address.toLowerCase());
    expect(session.expiresAt).toBeGreaterThan(Date.now());
    expect(auth.verifySession(session.token)).toBe(operator.address.toLowerCase());
  });

  it("rejects an unknown nonce", async () => {
    const auth = buildAuth(new Set([operator.address]));
    const message = formatChallengeMessage({
      nonce: "ff".repeat(32),
      issuedAt: new Date().toISOString(),
    });
    const signature = await sign(operator, message);
    await expect(
      auth.createSession({ nonce: "ff".repeat(32), message, signature }),
    ).rejects.toThrow(/Unknown or expired/i);
  });

  it("rejects a signer that is not in the registry", async () => {
    const auth = buildAuth(new Set([operator.address]));
    const { nonce } = auth.issueChallenge();
    const message = formatChallengeMessage({
      nonce,
      issuedAt: new Date().toISOString(),
    });
    const signature = await sign(attacker, message);
    await expect(
      auth.createSession({ nonce, message, signature }),
    ).rejects.toThrow(/not an active relayer/i);
  });

  it("burns the nonce even when the signature does not verify", async () => {
    const auth = buildAuth(new Set([operator.address]));
    const { nonce } = auth.issueChallenge();
    const message = formatChallengeMessage({
      nonce,
      issuedAt: new Date().toISOString(),
    });
    await expect(
      auth.createSession({
        nonce,
        message,
        signature: "0x" + "00".repeat(65),
      }),
    ).rejects.toThrow();
    // Same nonce is now gone — replay attempt must fail with the
    // "unknown nonce" message even though the signature would now
    // be valid.
    const goodSig = await sign(operator, message);
    await expect(
      auth.createSession({ nonce, message, signature: goodSig }),
    ).rejects.toThrow(/Unknown or expired/i);
  });

  it("rejects a message that does not reference the issued nonce", async () => {
    const auth = buildAuth(new Set([operator.address]));
    const { nonce } = auth.issueChallenge();
    const tamperedMessage = "I just wave hands without the nonce";
    const signature = await sign(operator, tamperedMessage);
    await expect(
      auth.createSession({ nonce, message: tamperedMessage, signature }),
    ).rejects.toThrow(/does not reference/i);
  });

  it("revokeSession invalidates a previously valid token", async () => {
    const auth = buildAuth(new Set([operator.address]));
    const { nonce } = auth.issueChallenge();
    const message = formatChallengeMessage({
      nonce,
      issuedAt: new Date().toISOString(),
    });
    const signature = await sign(operator, message);
    const session = await auth.createSession({ nonce, message, signature });
    auth.revokeSession(session.token);
    expect(auth.verifySession(session.token)).toBeNull();
  });

  it("verifySession returns null for an unknown token", () => {
    const auth = buildAuth(new Set([operator.address]));
    expect(auth.verifySession("ff".repeat(32))).toBeNull();
  });
});
