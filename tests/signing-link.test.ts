import { describe, it, expect } from "vitest";
import { resolveLinkState, addDays } from "../src/lib/signing/link";

const NOW = new Date("2026-09-07T10:00:00.000Z");

const live = {
  expiresAt: new Date("2026-10-07T10:00:00.000Z"),
  revokedAt: null,
  declinedAt: null,
  signingStatus: "SENT" as const,
  now: NOW,
};

describe("resolveLinkState", () => {
  it("is live for an unexpired, unrevoked, outstanding request", () => {
    expect(resolveLinkState(live)).toEqual({ kind: "live" });
  });

  it("reports completion even when the link has also expired", () => {
    expect(
      resolveLinkState({
        ...live,
        signingStatus: "SIGNED",
        expiresAt: new Date("2026-08-01T10:00:00.000Z"),
      })
    ).toEqual({ kind: "completed" });
  });

  it("reports completion even when the request was later revoked", () => {
    expect(
      resolveLinkState({ ...live, signingStatus: "SIGNED", revokedAt: NOW })
    ).toEqual({ kind: "completed" });
  });

  it("reports revoked before declined", () => {
    expect(resolveLinkState({ ...live, revokedAt: NOW, declinedAt: NOW })).toEqual({
      kind: "revoked",
    });
  });

  it("reports declined", () => {
    expect(resolveLinkState({ ...live, declinedAt: NOW, signingStatus: "DECLINED" })).toEqual({
      kind: "declined",
    });
  });

  it("reports expired once expiresAt has passed", () => {
    expect(
      resolveLinkState({ ...live, expiresAt: new Date("2026-09-07T09:59:59.999Z") })
    ).toEqual({ kind: "expired" });
  });

  it("treats expiry as inclusive of the boundary instant", () => {
    expect(resolveLinkState({ ...live, expiresAt: NOW })).toEqual({ kind: "live" });
  });
});

describe("addDays", () => {
  it("adds whole days in UTC", () => {
    expect(addDays(NOW, 30).toISOString()).toBe("2026-10-07T10:00:00.000Z");
  });

  it("returns a new Date and does not mutate its input", () => {
    const input = new Date(NOW);
    addDays(input, 5);
    expect(input.toISOString()).toBe(NOW.toISOString());
  });
});
