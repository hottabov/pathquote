/**
 * Whether a `SigningRequest` still opens anything, and what to tell the
 * visitor when it does not. Pure — the clock is a parameter, which is what
 * lets this be tested without fake timers (forbidden by the suite's
 * `isolate: false` contract; see vitest.config.ts).
 */
import type { SigningStatus } from "./state";

export type LinkState =
  | { kind: "live" }
  | { kind: "completed" }
  | { kind: "revoked" }
  | { kind: "declined" }
  | { kind: "expired" };

/**
 * Precedence is deliberate and load-bearing:
 *
 * `completed` outranks everything. A client returning to a quote they signed
 * two months ago must see the quote and its PDF, not "this link expired" —
 * that link is the only copy some of them keep.
 *
 * `revoked` then outranks `declined`, because a manager revoking after a
 * decline is saying "ignore that entirely"; and both outrank `expired`,
 * since an explicit act is more informative than the passage of time.
 */
export function resolveLinkState(input: {
  expiresAt: Date;
  revokedAt: Date | null;
  declinedAt: Date | null;
  signingStatus: SigningStatus;
  now: Date;
}): LinkState {
  if (input.signingStatus === "SIGNED") return { kind: "completed" };
  if (input.revokedAt !== null) return { kind: "revoked" };
  if (input.declinedAt !== null) return { kind: "declined" };
  // Inclusive: a request whose expiry is exactly now has not expired yet.
  if (input.now.getTime() > input.expiresAt.getTime()) return { kind: "expired" };
  return { kind: "live" };
}

/** `expiresAt` for a request sent at `from` under a validity of `days`.
 * Kept here beside `resolveLinkState` so the two halves of the expiry rule
 * are read together. */
export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}
