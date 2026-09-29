import { describe, expect, it } from "vitest";
import {
  SIGN_IN_PATH,
  consumeResultFromLocation,
  grantedResponse,
} from "@/lib/auth/magic-verify-response";
import { challengeCookieName } from "@/lib/auth/magic-challenge";

const ORIGIN = "https://q.pathfindercut.com";
const SESSION =
  "__Secure-authjs.session-token=eyJhbGciOi.jwt; Path=/; Expires=Tue, 06 Oct 2026 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax";
const CALLBACK = "__Secure-authjs.callback-url=https%3A%2F%2Fq.pathfindercut.com%2F; Path=/; HttpOnly; Secure; SameSite=Lax";

describe("grantedResponse", () => {
  // The 2026-09-29 regression: a NextResponse.cookies.set() after the session
  // cookie had been appended rewrote Set-Cookie from its own map and dropped
  // the session, so every magic-link sign-in arrived signed out.
  it("delivers the session cookie @auth/core minted", () => {
    const cookies = grantedResponse("/", [SESSION, CALLBACK]).headers.getSetCookie();
    expect(cookies).toContain(SESSION);
    expect(cookies).toContain(CALLBACK);
  });

  it("clears the spent challenge cookie", () => {
    const cookies = grantedResponse("/", [SESSION]).headers.getSetCookie();
    const challenge = cookies.find((c) => c.startsWith(`${challengeCookieName()}=`));
    expect(challenge).toBeDefined();
    expect(challenge).toMatch(/Max-Age=0/);
  });

  it("answers 200 with the destination", async () => {
    const response = grantedResponse("/quotes/42", [SESSION]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirectTo: "/quotes/42" });
  });
});

describe("consumeResultFromLocation", () => {
  it("treats a redirect to the destination as success", () => {
    expect(consumeResultFromLocation(`${ORIGIN}/quotes/42`, ORIGIN)).toEqual({
      ok: true,
      redirectTo: `${ORIGIN}/quotes/42`,
    });
  });

  it("reads Verification on the error page as an invalid link", () => {
    expect(consumeResultFromLocation(`${ORIGIN}/api/auth/error?error=Verification`, ORIGIN)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("reads AccessDenied as a refused account", () => {
    expect(consumeResultFromLocation(`${ORIGIN}/api/auth/error?error=AccessDenied`, ORIGIN)).toEqual({
      ok: false,
      reason: "denied",
    });
  });

  // @auth/core sends errors of kind "signIn" to pages.signIn, not to its error
  // page. Read as a success, the user was "signed in" onto the login form.
  it("treats a signIn-kind error on the sign-in page as a failure", () => {
    expect(
      consumeResultFromLocation(`${ORIGIN}${SIGN_IN_PATH}?error=EmailSignin`, ORIGIN)
    ).toEqual({ ok: false, reason: "error" });
  });

  it("reports an unknown error code as our fault, not an expired link", () => {
    expect(consumeResultFromLocation(`${ORIGIN}/api/auth/error?error=Configuration`, ORIGIN)).toEqual({
      ok: false,
      reason: "error",
    });
  });

  it("treats a missing Location as an error", () => {
    expect(consumeResultFromLocation("", ORIGIN)).toEqual({ ok: false, reason: "error" });
  });
});
