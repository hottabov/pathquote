import { describe, expect, it } from "vitest";
import { safeRelativeCallbackUrl } from "@/lib/auth/safe-callback-url";

describe("safeRelativeCallbackUrl", () => {
  it("keeps a same-origin path, query included", () => {
    expect(safeRelativeCallbackUrl("/quotes/42?tab=items")).toBe("/quotes/42?tab=items");
  });

  it("falls back to / for anything that is not a string path", () => {
    expect(safeRelativeCallbackUrl(null)).toBe("/");
    expect(safeRelativeCallbackUrl(undefined)).toBe("/");
    expect(safeRelativeCallbackUrl("")).toBe("/");
    expect(safeRelativeCallbackUrl("https://q.pathfindercut.com/quotes")).toBe("/");
  });

  it("rejects protocol-relative forms", () => {
    expect(safeRelativeCallbackUrl("//evil.example/x")).toBe("/");
    expect(safeRelativeCallbackUrl("/\\evil.example/x")).toBe("/");
  });

  // Landing a fresh sign-in on the login form reads as "it didn't work".
  it("never sends a signed-in user back to the sign-in page", () => {
    expect(safeRelativeCallbackUrl("/login")).toBe("/");
    expect(safeRelativeCallbackUrl("/login?callbackUrl=%2F")).toBe("/");
    expect(safeRelativeCallbackUrl("/login/confirm?token=x")).toBe("/");
  });

  it("does not mistake a path that merely starts with the word for it", () => {
    expect(safeRelativeCallbackUrl("/login-history")).toBe("/login-history");
  });
});
