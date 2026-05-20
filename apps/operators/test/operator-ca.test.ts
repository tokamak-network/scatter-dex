import { describe, expect, it } from "vitest";
import { safeOperatorUrl } from "../app/lib/operatorDisplay";

// Coverage for the URL-safety helper used by the `/operator-ca` page
// to validate `NEXT_PUBLIC_CA_REGISTRATION_URL` at module load. The
// same helper guards every operator-published URL in this app, so
// these cases double as the lib-level safety net for the broader
// reuse surface (`OperatorIdentityBar`, `OperatorWalletDropdown`).
describe("safeOperatorUrl (CA registration URL gate)", () => {
  it("returns null for empty / missing env", () => {
    expect(safeOperatorUrl("")).toBeNull();
    expect(safeOperatorUrl(undefined)).toBeNull();
  });

  it("rejects javascript: scheme", () => {
    expect(safeOperatorUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects data: scheme", () => {
    expect(safeOperatorUrl("data:text/html,<h1>x</h1>")).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(safeOperatorUrl("not a url")).toBeNull();
  });

  it("accepts https URLs", () => {
    expect(safeOperatorUrl("https://ca.example.com/register")).toBe(
      "https://ca.example.com/register",
    );
  });

  it("accepts http URLs (dev / local CA portals)", () => {
    expect(safeOperatorUrl("http://localhost:3001/")).toBe(
      "http://localhost:3001/",
    );
  });
});
