import { describe, it, expect } from "vitest";
import { hashChallenge } from "@/lib/auth/magic-challenge";
import { verifyMagicLink, type VerifyDeps } from "@/lib/auth/verify-magic-link";

const SECRET = "test-secret";
const ORIGIN = "https://q.pathfindercut.com";
const NONCE = "the-nonce-this-browser-holds";

/**
 * Records whether the consuming path ran. `consumed` standing at 0 after a
 * request is the assertion that matters for the scanner cases: the token row
 * was never touched, so the link is still spendable by the human who clicks
 * it a minute later.
 */
function deps(
  over: Partial<{
    row: { expires: Date; challengeHash: string | null } | null;
    reject: "invalid" | "denied" | "error";
  }> = {}
) {
  const state = {
    row:
      over.row === undefined
        ? { expires: new Date(Date.now() + 900_000), challengeHash: hashChallenge(NONCE) }
        : over.row,
    reject: over.reject,
    consumed: 0,
    lastDestination: "",
  };
  const d: VerifyDeps = {
    lookup: async () => state.row,
    consume: async ({ destination }) => {
      state.consumed += 1;
      state.lastDestination = destination;
      return state.reject
        ? ({ ok: false, reason: state.reject } as const)
        : ({ ok: true, redirectTo: destination } as const);
    },
  };
  return { d, state };
}

const base = { token: "raw-token", email: "marketing@pathfindercut.com", origin: ORIGIN, secret: SECRET };

describe("verifyMagicLink", () => {
  it("consumes and returns a destination when the challenge matches", async () => {
    const { d, state } = deps();
    const out = await verifyMagicLink({ ...base, confirmed: false, cookie: NONCE }, d);
    expect(out).toEqual({ status: 200, redirectTo: "/" });
    expect(state.consumed).toBe(1);
  });

  // The scanner. The single most important assertion in this file.
  it("refuses with 409 and leaves the token unconsumed when the challenge is absent", async () => {
    const { d, state } = deps();
    const out = await verifyMagicLink({ ...base, confirmed: false, cookie: undefined }, d);
    expect(out).toEqual({ status: 409 });
    expect(state.consumed).toBe(0);
  });

  it("refuses with 409 and leaves the token unconsumed when the challenge is wrong", async () => {
    const { d, state } = deps();
    const out = await verifyMagicLink({ ...base, confirmed: false, cookie: "not-the-nonce" }, d);
    expect(out).toEqual({ status: 409 });
    expect(state.consumed).toBe(0);
  });

  it("consumes on confirmed with no challenge at all", async () => {
    const { d, state } = deps();
    const out = await verifyMagicLink({ ...base, confirmed: true, cookie: undefined }, d);
    expect(out.status).toBe(200);
    expect(state.consumed).toBe(1);
  });

  it("consumes a legacy row whose challengeHash is NULL", async () => {
    const { d, state } = deps({ row: { expires: new Date(Date.now() + 900_000), challengeHash: null } });
    const out = await verifyMagicLink({ ...base, confirmed: false, cookie: undefined }, d);
    expect(out.status).toBe(200);
    expect(state.consumed).toBe(1);
  });

  // Replay: the row is gone because a previous verify deleted it. This must
  // reach @auth/core and come back 401, never 409 — a 409 here would tell a
  // prober that the token had been live.
  it("returns 401 for a token whose row no longer exists", async () => {
    const { d, state } = deps({ row: null, reject: "invalid" });
    const out = await verifyMagicLink({ ...base, confirmed: false, cookie: undefined }, d);
    expect(out).toEqual({ status: 401 });
    expect(state.consumed).toBe(1);
  });

  it("returns 401 for an expired row rather than asking for confirmation", async () => {
    const { d } = deps({
      row: { expires: new Date(Date.now() - 1), challengeHash: hashChallenge(NONCE) },
      reject: "invalid",
    });
    const out = await verifyMagicLink({ ...base, confirmed: false, cookie: undefined }, d);
    expect(out).toEqual({ status: 401 });
  });

  // An account deactivated between requesting the link and clicking it. The
  // signIn callback in src/auth.ts refuses it, and that is not an expired
  // link — telling the user to request a new one would send them in circles.
  it("returns 403 when the account is no longer allowed to sign in", async () => {
    const { d } = deps({ reject: "denied" });
    const out = await verifyMagicLink({ ...base, confirmed: true }, d);
    expect(out).toEqual({ status: 403 });
  });

  // Our outage, not their link. @auth/core reports an unreachable database
  // through the same error redirect it uses for a bad token, and a smoke test
  // against a dead database is what surfaced this: it answered
  // `error=Configuration`, which an earlier version of this code mapped to
  // "your link has expired".
  it("returns 500 when @auth/core fails for a reason that is not the token", async () => {
    const { d } = deps({ reject: "error" });
    const out = await verifyMagicLink({ ...base, confirmed: true }, d);
    expect(out).toEqual({ status: 500 });
  });

  describe("callbackUrl", () => {
    it("passes a same-origin relative path through", async () => {
      const { d, state } = deps();
      await verifyMagicLink({ ...base, confirmed: true, callbackUrl: "/quotes/42" }, d);
      expect(state.lastDestination).toBe("/quotes/42");
    });

    it("drops a foreign origin", async () => {
      const { d, state } = deps();
      await verifyMagicLink({ ...base, confirmed: true, callbackUrl: "https://evil.example/x" }, d);
      expect(state.lastDestination).toBe("/");
    });

    it("drops a protocol-relative URL", async () => {
      const { d, state } = deps();
      await verifyMagicLink({ ...base, confirmed: true, callbackUrl: "//evil.example/x" }, d);
      expect(state.lastDestination).toBe("/");
    });
  });
});
