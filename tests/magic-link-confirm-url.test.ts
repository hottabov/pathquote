import { describe, it, expect } from "vitest";
import { CONFIRM_PATH, toConfirmUrl } from "@/lib/email/magic-link-url";

// The shape @auth/core hands to sendVerificationRequest — see
// node_modules/@auth/core/lib/actions/signin/send-token.js, which builds
// `${basePath}/callback/${provider.id}?callbackUrl=…&token=…&email=…`.
const CALLBACK_URL =
  "https://q.pathfindercut.com/api/auth/callback/nodemailer" +
  "?callbackUrl=https%3A%2F%2Fq.pathfindercut.com%2Flogin" +
  "&token=3f029310c372e4a0ec78310c13353e711e4b7b5fb769713c9c4babcb920c0d4d" +
  "&email=marketing%40pathfindercut.com";

describe("toConfirmUrl", () => {
  it("points the emailed link at the confirm page, not the callback route", () => {
    const url = new URL(toConfirmUrl(CALLBACK_URL));
    expect(url.pathname).toBe(CONFIRM_PATH);
    expect(url.pathname).not.toContain("/api/auth/callback");
  });

  it("keeps the same origin", () => {
    const url = new URL(toConfirmUrl(CALLBACK_URL));
    expect(url.origin).toBe("https://q.pathfindercut.com");
  });

  // The token is compared byte-for-byte against sha256(token + AUTH_SECRET),
  // so any re-encoding of the query string on the way into the email breaks
  // sign-in. Rewriting only the pathname and leaving `search` untouched is
  // what guarantees that, and this asserts it rather than trusting it.
  it("passes the query string through byte-for-byte", () => {
    const original = new URL(CALLBACK_URL);
    const rewritten = new URL(toConfirmUrl(CALLBACK_URL));
    expect(rewritten.search).toBe(original.search);
  });

  it("carries token, email and callbackUrl through unchanged", () => {
    const params = new URL(toConfirmUrl(CALLBACK_URL)).searchParams;
    expect(params.get("token")).toBe(
      "3f029310c372e4a0ec78310c13353e711e4b7b5fb769713c9c4babcb920c0d4d"
    );
    expect(params.get("email")).toBe("marketing@pathfindercut.com");
    expect(params.get("callbackUrl")).toBe("https://q.pathfindercut.com/login");
  });

  // Fail closed. Every rejection below would otherwise mean emailing a link
  // that still consumes the token on a plain GET — which is the bug this
  // module exists to fix — so a loud send failure is the better outcome.
  it("rejects a URL that is not the nodemailer callback", () => {
    expect(() =>
      toConfirmUrl("https://q.pathfindercut.com/api/auth/callback/credentials?token=a&email=b%40c.com")
    ).toThrow();
  });

  it("rejects a link with no token", () => {
    expect(() =>
      toConfirmUrl(
        "https://q.pathfindercut.com/api/auth/callback/nodemailer?email=marketing%40pathfindercut.com"
      )
    ).toThrow();
  });

  it("rejects a link with no email", () => {
    expect(() =>
      toConfirmUrl("https://q.pathfindercut.com/api/auth/callback/nodemailer?token=abc123")
    ).toThrow();
  });

  it("rejects a value that is not a URL at all", () => {
    expect(() => toConfirmUrl("/api/auth/callback/nodemailer?token=a&email=b%40c.com")).toThrow();
  });

  // A non-default basePath still ends in /callback/nodemailer, and the origin
  // is whatever AUTH_URL says, so neither should matter to the rewrite.
  it("handles a custom basePath and a non-standard origin", () => {
    const url = new URL(
      toConfirmUrl("http://localhost:3000/auth/callback/nodemailer?token=abc&email=a%40b.com")
    );
    expect(url.origin).toBe("http://localhost:3000");
    expect(url.pathname).toBe(CONFIRM_PATH);
  });
});
