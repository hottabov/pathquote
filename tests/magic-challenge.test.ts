import { describe, it, expect } from "vitest";
import {
  challengeMatches,
  decideChallenge,
  generateChallenge,
  hashChallenge,
  hashVerificationToken,
} from "@/lib/auth/magic-challenge";

const SECRET = "test-secret";
const RAW = "s3cr3t-nonce-value";
const HASH = hashChallenge(RAW);

// A row as the pre-check sees it: whatever `VerificationToken` we found for
// the posted token, or null when there is no such row.
function row(over: Partial<{ expires: Date; challengeHash: string | null }> = {}) {
  return {
    expires: new Date(Date.now() + 900_000),
    challengeHash: HASH,
    ...over,
  };
}

describe("hashVerificationToken", () => {
  // Must stay bit-identical to @auth/core's own hashing
  // (lib/actions/signin/send-token.js → createHash(`${token}${secret}`)),
  // because the row we look up was written by @auth/core, not by us. A
  // divergence here would make every pre-check miss its row and silently
  // disable the whole feature.
  it("is sha256 of token concatenated with the secret, as lowercase hex", async () => {
    const expected = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`abc123${SECRET}`))
      )
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(hashVerificationToken("abc123", SECRET)).toBe(expected);
  });
});

describe("generateChallenge", () => {
  it("returns a fresh, URL-safe, high-entropy value each time", () => {
    const a = generateChallenge();
    const b = generateChallenge();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  });
});

describe("challengeMatches", () => {
  it("accepts the raw value behind the stored hash", () => {
    expect(challengeMatches(RAW, HASH)).toBe(true);
  });

  it("rejects a different value", () => {
    expect(challengeMatches("not-it", HASH)).toBe(false);
  });

  // Length is checked before the constant-time compare because
  // timingSafeEqual throws on a length mismatch; a thrown comparison would
  // surface as a 500 rather than a refusal.
  it("rejects without throwing when the lengths differ", () => {
    expect(() => challengeMatches("x", HASH)).not.toThrow();
    expect(challengeMatches("x", HASH)).toBe(false);
  });

  it("rejects a missing cookie or a missing stored hash", () => {
    expect(challengeMatches(undefined, HASH)).toBe(false);
    expect(challengeMatches(RAW, null)).toBe(false);
    expect(challengeMatches(undefined, null)).toBe(false);
  });
});

describe("decideChallenge", () => {
  const now = new Date();

  it("consumes when the cookie matches — the ordinary same-browser case", () => {
    expect(decideChallenge({ row: row(), cookie: RAW, confirmed: false, now })).toBe("consume");
  });

  // The scanner. This is the entire point of the change: refuse, and leave
  // the token spendable for the human who clicks a minute later.
  it("asks for confirmation when the cookie is absent", () => {
    expect(decideChallenge({ row: row(), cookie: undefined, confirmed: false, now })).toBe(
      "confirm"
    );
  });

  it("asks for confirmation when the cookie is wrong", () => {
    expect(decideChallenge({ row: row(), cookie: "wrong", confirmed: false, now })).toBe("confirm");
  });

  // `confirmed` is the human pressing the button, and it deliberately skips
  // the check entirely — the challenge is a UX gate, never an authorization
  // gate. Possession of the link is what authenticates, as it always was.
  it("consumes on confirmed even with no cookie at all", () => {
    expect(decideChallenge({ row: row(), cookie: undefined, confirmed: true, now })).toBe("consume");
  });

  // Rows predating this change carry NULL. They must behave exactly as
  // before, so links in flight across the deploy keep working.
  it("consumes a legacy row with no challenge bound to it", () => {
    expect(
      decideChallenge({ row: row({ challengeHash: null }), cookie: undefined, confirmed: false, now })
    ).toBe("consume");
  });

  // These three keep the 409 from becoming an oracle. If an unknown or
  // expired token could earn a "confirm", an attacker could probe which
  // tokens are still live. They fall through to the normal path, where
  // Auth.js answers the same way it answers any bad token.
  it("falls through for a token with no row", () => {
    expect(decideChallenge({ row: null, cookie: undefined, confirmed: false, now })).toBe("consume");
  });

  it("falls through for an expired row", () => {
    const expired = row({ expires: new Date(now.getTime() - 1) });
    expect(decideChallenge({ row: expired, cookie: undefined, confirmed: false, now })).toBe(
      "consume"
    );
  });

  it("falls through for a row expiring exactly now", () => {
    const boundary = row({ expires: now });
    expect(decideChallenge({ row: boundary, cookie: undefined, confirmed: false, now })).toBe(
      "consume"
    );
  });
});
