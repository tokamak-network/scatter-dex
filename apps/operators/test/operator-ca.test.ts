import { describe, expect, it } from "vitest";
import { sanitizeExternalUrl } from "../app/operator-ca/page";

describe("sanitizeExternalUrl", () => {
  it("returns null for empty / missing env", () => {
    expect(sanitizeExternalUrl("")).toBeNull();
  });

  it("rejects javascript: scheme", () => {
    expect(sanitizeExternalUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects data: scheme", () => {
    expect(sanitizeExternalUrl("data:text/html,<h1>x</h1>")).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(sanitizeExternalUrl("not a url")).toBeNull();
  });

  it("accepts https URLs", () => {
    expect(sanitizeExternalUrl("https://ca.example.com/register")).toBe(
      "https://ca.example.com/register",
    );
  });

  it("accepts http URLs (dev / local CA portals)", () => {
    expect(sanitizeExternalUrl("http://localhost:3001/")).toBe(
      "http://localhost:3001/",
    );
  });
});
