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
  // A declined request is recorded twice — Document.signingStatus === "DECLINED"
  // and SigningRequest.declinedAt !== null — and the two should never disagree.
  // A partial write, a bug in the decline action, or a migration default could
  // leave one set without the other, so either field is treated as sufficient:
  // a mismatch closes this gate rather than falling through to "expired" or,
  // worse on the access gate for an unauthenticated page, "live". Fail closed.
  //
  // Revoked has no corresponding SigningStatus value, so revokedAt above is
  // genuinely its sole source of truth — that asymmetry with declined is
  // deliberate, not an inconsistency to "tidy" into a matching pair.
  if (input.signingStatus === "DECLINED" || input.declinedAt !== null) {
    return { kind: "declined" };
  }
  // Inclusive: a request whose expiry is exactly now has not expired yet.
  // Some flows create and then immediately resolve a request within the same
  // request cycle; an exclusive boundary (>=) would make a just-issued link
  // with a zero-day validity expire on its own first read.
  if (input.now.getTime() > input.expiresAt.getTime()) return { kind: "expired" };
  return { kind: "live" };
}

/** `expiresAt` for a request sent at `from` under a validity of `days`.
 * Kept here beside `resolveLinkState` so the two halves of the expiry rule
 * are read together.
 *
 * Adds elapsed milliseconds, not calendar days via `setDate`. `expiresAt`
 * and `now` are absolute instants compared with `getTime()` in
 * `resolveLinkState` above, so millisecond arithmetic is exactly right here
 * and has no DST defect. `setDate` looks more "correct" to a future editor,
 * but it operates in the local calendar and would make this absolute
 * instant silently depend on the server's local timezone. */
export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}
